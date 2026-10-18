/**
 * Cloudflare 命令封装：统一调用 wrangler，并管理「账号相关、但不进仓库」的东西。
 *
 * 设计要点（参见 wrangler.jsonc 顶部的说明）：
 *   * 仓库里的 wrangler.jsonc 只描述「是什么」，不含 database_id 这类每账号独有的 ID
 *   * D1 库在部署时自动查找（同名复用），没有就创建；库 ID 缓存在 .wrangler/d1.json（已 gitignore）
 *   * 部署时以 wrangler.jsonc 为模板生成 .wrangler/deploy.jsonc，把 D1 绑定写进去再部署
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** scripts/lib/ 向上两级才是仓库根目录 */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CONFIG_FILE = 'wrangler.jsonc';
export const DEPLOY_CONFIG_FILE = '.wrangler/deploy.jsonc';
export const D1_CACHE_FILE = '.wrangler/d1.json';

/** D1 库名固定，同名库会被复用 */
export const DB_NAME = 'ai-gateway';
/** Q5：D1 绑定的名字，代码里通过 env.DB 访问 */
export const DB_BINDING = 'DB';
export const MIGRATIONS_DIR = 'migrations';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

const isWindows = process.platform === 'win32';

// ---------------------------------------------------------------- wrangler

/** 运行 wrangler（用当前 node 执行本地安装的版本，避免依赖全局安装） */
export function wrangler(args, { capture = false, env } = {}) {
  const result = spawnSync(process.execPath, [WRANGLER, ...args], {
    cwd: ROOT,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    env: { ...process.env, ...(env ?? {}) },
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    text: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    error: result.error,
  };
}

// ---------------------------------------------------------------- 配置

/** wrangler.jsonc → 对象（只支持行注释与块注释，够用，也不引入额外依赖） */
export function readConfig() {
  const raw = readFileSync(join(ROOT, CONFIG_FILE), 'utf8');
  const stripped = raw.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return JSON.parse(stripped);
}

/**
 * D1 段的基础字段：只含库名、绑定名与迁移目录，**不含 database_id**。
 *
 * 库名与绑定名是部署契约（代码里写死 env.DB），所以由这里统一给。
 * 迁移目录仍写相对路径，由 absolutizePaths() 在生成部署配置时统一转成绝对路径。
 */
export function baseD1Config() {
  return {
    binding: DB_BINDING,
    database_name: DB_NAME,
    migrations_dir: MIGRATIONS_DIR,
  };
}

// ---------------------------------------------------------------- D1 查找 / 创建

function readCachedD1() {
  try {
    const data = JSON.parse(readFileSync(join(ROOT, D1_CACHE_FILE), 'utf8'));
    return UUID_RE.test(data.database_id || '') ? data : null;
  } catch {
    return null;
  }
}

function writeCachedD1(id, name) {
  const target = join(ROOT, D1_CACHE_FILE);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify({ name, database_id: id }, null, 2)}\n`);
}

/** 账号里的 D1 列表；失败返回 null（通常是没登录或没权限） */
export function listD1() {
  const res = wrangler(['d1', 'list', '--json'], { capture: true });
  if (!res.ok) return null;
  try {
    const list = JSON.parse(res.stdout);
    if (!Array.isArray(list)) return null;
    return list.map((d) => ({
      id: d.uuid || d.database_id || d.id || '',
      name: d.name || '',
    }));
  } catch {
    return null;
  }
}

/**
 * 已配置在 Worker 上的 Secret 名字列表（只含名字，不含值）。
 *
 * 返回 null 表示「查不到」（没登录、Worker 还不存在、或 wrangler 不支持该命令），
 * 调用方应把它当作「无法判断」而不是「一个都没有」。
 */
export function listSecrets(options = {}) {
  const res = wrangler(['secret', 'list', '--format', 'json'], { capture: true, ...options });
  const text = res.stdout ?? '';
  const start = text.indexOf('[');
  if (start < 0) return null;
  try {
    const list = JSON.parse(text.slice(start));
    if (!Array.isArray(list)) return null;
    return list.map((s) => (typeof s === 'string' ? s : s?.name)).filter(Boolean);
  } catch {
    return null;
  }
}

export function createD1(name) {
  const res = wrangler(['d1', 'create', name], { capture: true });  const m =
    /"?uuid"?\s*[:=]\s*"?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"?/i.exec(
      res.text,
    ) ||
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(res.text);
  if (!res.ok || !m) return { ok: false, text: res.text };
  return { ok: true, id: m[1] };
}

/**
 * 解析 D1 库 ID：缓存 → 同名复用 → 创建。
 *
 * 缓存优先，因为同一个 Worker 必须始终绑同一个库；只要缓存里的库还在账号里就直接用。
 */
export function resolveD1({ log = () => {} } = {}) {
  const list = listD1();
  if (list === null) {
    throw new Error(
      '无法读取 D1 数据库列表（wrangler d1 list 失败）。\n' +
        '  请确认已登录且凭据有 D1 权限：npx wrangler whoami',
    );
  }

  const cached = readCachedD1();
  if (cached && list.some((d) => d.id === cached.database_id)) {
    log(`  复用上次部署的库 ${cached.name || DB_NAME}: ${cached.database_id}`);
    return cached.database_id;
  }

  const existing = list.find((d) => d.name === DB_NAME);
  if (existing) {
    log(`  复用账号里已有的库 ${DB_NAME}: ${existing.id}`);
    writeCachedD1(existing.id, DB_NAME);
    return existing.id;
  }

  log(`  账号里没有 ${DB_NAME}，正在创建...`);
  const created = createD1(DB_NAME);
  if (!created.ok) {
    throw new Error(
      `创建 D1 失败：\n${created.text.trim()}\n\n可手动执行 npx wrangler d1 create ${DB_NAME}`,
    );
  }
  log(`  已创建: ${created.id}`);
  writeCachedD1(created.id, DB_NAME);
  return created.id;
}

// ---------------------------------------------------------------- 生成部署配置

/**
 * 把配置里与「文件系统」相关的相对路径转成绝对路径。
 *
 * 生成的 deploy.jsonc 放在 .wrangler/ 下，而 wrangler 解析 main / rules.globs /
 * migrations_dir 时是**按配置文件所在目录**算相对路径的 —— 不转换就会出现
 * 「entry-point file at src/index.ts was not found」（CI 上实测过）。
 * 绝对路径在任何目录下都成立，且不会把机器路径带进仓库（这个文件在 .wrangler/ 里，已 gitignore）。
 */
export function absolutizePaths(config) {
  const abs = (p) => (p == null ? p : join(ROOT, p).replace(/\\/g, '/'));
  const out = { ...config };
  if (out.main) out.main = abs(out.main);
  if (Array.isArray(out.rules)) {
    out.rules = out.rules.map((rule) => ({
      ...rule,
      ...(Array.isArray(rule.globs) ? { globs: rule.globs.map(abs) } : {}),
    }));
  }
  if (Array.isArray(out.d1_databases)) {
    out.d1_databases = out.d1_databases.map((db) => ({
      ...db,
      ...(db.migrations_dir ? { migrations_dir: abs(db.migrations_dir) } : {}),
    }));
  }
  return out;
}

/**
 * 以 wrangler.jsonc 为模板生成 .wrangler/deploy.jsonc，把 D1 绑定写进去。
 *
 * 其余字段（name / main / rules / define …）原样保留，只把路径转成绝对路径，
 * 再补上「每账号独有的那一部分」。返回可直接传给 --config 的路径。
 */
export function buildDeployConfig({ dbId }) {
  const config = readConfig();
  config.d1_databases = [{ ...baseD1Config(), database_id: dbId }];

  const target = join(ROOT, DEPLOY_CONFIG_FILE);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(
    target,
    `// 由 scripts/lib/cf.mjs 在部署时自动生成（含本账号的 D1 库 ID，不进仓库）。\n` +
      `${JSON.stringify(absolutizePaths(config), null, 2)}\n`,
  );
  return relative(ROOT, target).replace(/\\/g, '/');
}

export function deployConfigExists() {
  return existsSync(join(ROOT, DEPLOY_CONFIG_FILE));
}
