/**
 * 两个必需密钥的检查与初始化。
 *
 * 本项目需要两个 Secret（Cloudflare 控制台 → 该 Worker → Settings → Variables and Secrets
 * → Add，类型选 **Secret**）：
 *
 *   ADMIN_TOKEN     管理后台登录令牌；忘了直接改成新值即可
 *   ENCRYPTION_KEY  上游渠道密钥的 AES-256-GCM 主密钥；一经使用不要更换
 *
 * 与 qq-bot-cf 的做法一致：**不在 wrangler 配置里声明 secrets.required**（那会让缺 Secret
 * 时部署直接失败，而 Secret 又只能加到已存在的 Worker 上），而是在代码里检查。
 * 缺配置时由 src/lib/setup.ts 返回「尚未完成配置」的说明页，而不是报错。
 *
 * 判定四种状态：
 *   no-db      数据库还没建表（迁移没跑）
 *   missing    控制台里没配 Secret
 *   mismatch   ENCRYPTION_KEY 与库里已加密的数据对不上（换过值）
 *   ok         齐全且可用
 */

import { all, first, getSetting, setSetting } from './db.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { ApiError } from './errors.js';
import type { Env } from '../types.js';

/** 「设置」表里记录主密钥校验值的键 */
export const KEY_CHECK = '__key_check';
/** 写进校验值的内容（只用它判断「能否解开」，不参与加密） */
const KEY_CHECK_VALUE = 'ai-gateway-key-check';

/** 站点名称的默认值；部署者可在管理界面改成自己的 */
export const DEFAULT_SITE_NAME = 'AI 中转站';

export type SecretsState = 'no-db' | 'missing' | 'mismatch' | 'ok';

export interface SecretsStatus {
  state: SecretsState;
  /** 缺的是哪些（只在 state = 'missing' 时有值） */
  missing: Array<'ADMIN_TOKEN' | 'ENCRYPTION_KEY'>;
  /** 数据库表是否可用 */
  dbReady: boolean;
}

/** 库还没建表（迁移没跑）时统一的报错，比 D1 的 no such table 好懂 */
export const notMigrated = (): ApiError =>
  new ApiError(
    503,
    '数据库尚未初始化：请先执行 `wrangler d1 migrations apply DB --remote`',
    'api_error',
    'not_migrated',
  );

/** 两个 Secret 的名字与用途，用于配置指引页 */
export const REQUIRED_SECRETS = [
  {
    key: 'ADMIN_TOKEN',
    why: '管理后台的登录令牌，登录 /admin 时输入的就是它。',
    how: '任意 16 位以上的随机串；忘了直接改成新值即可。',
  },
  {
    key: 'ENCRYPTION_KEY',
    why: '加密保存上游渠道 API Key 的主密钥。',
    how: '16 位以上随机串。**一经使用不要更换**，换了已保存的渠道密钥就解不开。',
  },
] as const;

/**
 * 检查两个 Secret，不抛错、不做写入。
 *
 * 具体怎么提示（说明页 / API 503）由各入口自己决定。
 */
export async function checkSecrets(env: Env): Promise<SecretsStatus> {
  const missing: SecretsStatus['missing'] = [];
  if (!env.ADMIN_TOKEN) missing.push('ADMIN_TOKEN');
  if (!env.ENCRYPTION_KEY) missing.push('ENCRYPTION_KEY');

  if (missing.length > 0) {
    // 缺 Secret 时也先确认库在不在：两个问题同时存在时，先报更根本的那个
    try {
      await env.DB.prepare('SELECT 1 FROM settings LIMIT 1').all();
    } catch {
      return { state: 'no-db', missing, dbReady: false };
    }
    return { state: 'missing', missing, dbReady: true };
  }

  let probe: string | null;
  try {
    probe = await getSetting(env.DB, KEY_CHECK);
  } catch {
    return { state: 'no-db', missing, dbReady: false };
  }

  // 库里还没有校验值时，把当前密钥跑一次加解密落一条标记：之后被换掉就能立刻发现。
  // 用密文存，顺带证明「这个密钥确实能加解密」。
  if (!probe) {
    const sealed = await encryptSecret(KEY_CHECK_VALUE, env.ENCRYPTION_KEY as string).catch(
      () => null,
    );
    if (sealed) {
      await env.DB.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
         ON CONFLICT(key) DO NOTHING`,
      )
        .bind(KEY_CHECK, sealed, Date.now())
        .run()
        .catch(() => undefined);
    }
    return { state: 'ok', missing, dbReady: true };
  }

  try {
    await decryptSecret(probe, env.ENCRYPTION_KEY as string);
    return { state: 'ok', missing, dbReady: true };
  } catch {
    return { state: 'mismatch', missing, dbReady: true };
  }
}

/** 取管理令牌；没配置直接抛错，绝不回落到任何默认值 */
export function adminToken(env: Env): string {
  if (!env.ADMIN_TOKEN) {
    throw new ApiError(
      503,
      'ADMIN_TOKEN 未配置：请在 Cloudflare 控制台 Worker → Settings → Variables and Secrets 添加（类型选 Secret）',
      'api_error',
      'secret_missing',
    );
  }
  return env.ADMIN_TOKEN;
}

/** 取加密主密钥；没配置直接抛错，避免拿空串去加密渠道密钥 */
export function encryptionKey(env: Env): string {
  if (!env.ENCRYPTION_KEY) {
    throw new ApiError(
      503,
      'ENCRYPTION_KEY 未配置：请在 Cloudflare 控制台 Worker → Settings → Variables and Secrets 添加（类型选 Secret）',
      'api_error',
      'secret_missing',
    );
  }
  return env.ENCRYPTION_KEY;
}

/** 换令牌前自检：确认主密钥仍能解开库里的数据 */
export async function assertEncryptionKeyUsable(env: Env): Promise<void> {
  const probe = await first<{ value: string }>(
    env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(KEY_CHECK),
  );
  if (!probe) return;
  try {
    await decryptSecret(probe.value, encryptionKey(env));
  } catch {
    throw new ApiError(
      409,
      'ENCRYPTION_KEY 与库中已加密的数据不匹配：请改回原来的值，或重新保存各渠道的 API Key',
      'api_error',
      'encryption_key_mismatch',
    );
  }
}

/** 管理令牌最近一次轮换的时间（没轮换过就是 null） */
export async function getAdminTokenRotatedAt(env: Env): Promise<number | null> {
  const row = await first<{ value: string }>(
    env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('admin_token_rotated_at'),
  );
  const ts = Number(row?.value);
  return Number.isFinite(ts) && ts > 0 ? ts : null;
}

/** 记录一次轮换时间（令牌本身是 Secret，不在库里存值） */
export async function markAdminTokenRotatedAt(env: Env, ts = Date.now()): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind('admin_token_rotated_at', String(ts), ts)
    .run();
}

/**
 * 用旧主密钥把库里已加密的渠道 API Key 重新加密到当前主密钥。
 *
 * 场景：部署者换了 ENCRYPTION_KEY（现在 state = mismatch），但还记得旧值。此时
 * 所有 channels.api_key_enc 都是旧密钥加密的，解不开。这个函数用旧密钥解密每条
 * 明文，再用当前 env.ENCRYPTION_KEY 重新加密写回，并重写 __key_check 校验值，
 * 让站点从 mismatch 回到 ok，而不必逐个渠道重填 Key。
 *
 * 只动 channels.api_key_enc 与 __key_check 两处：其余表（models / users / api_keys /
 * usage_logs）都不涉及主密钥，不动。返回成功重加密的渠道数。
 */
export async function reencryptChannels(
  env: Env,
  oldKey: string,
): Promise<{ reencrypted: number; total: number }> {
  const newKey = env.ENCRYPTION_KEY;
  if (!newKey) {
    throw new ApiError(
      503,
      'ENCRYPTION_KEY 未配置：请在 Cloudflare 控制台 Worker → Settings → Variables and Secrets 添加（类型选 Secret）',
      'api_error',
      'secret_missing',
    );
  }

  const rows = await all<{ id: number; api_key_enc: string }>(
    env.DB.prepare('SELECT id, api_key_enc FROM channels'),
  );

  const updates: D1PreparedStatement[] = [];
  let reencrypted = 0;

  for (const row of rows) {
    let plain: string;
    try {
      plain = await decryptSecret(row.api_key_enc, oldKey);
    } catch {
      // 这条不是用旧密钥加密的（比如本身就是明文损坏、或部分渠道已经用新密钥存过），
      // 跳过，交给「改回原值 / 重新保存」兜底；不能因为一条解不开就整个失败。
      continue;
    }
    const enc = await encryptSecret(plain, newKey);
    updates.push(
      env.DB.prepare('UPDATE channels SET api_key_enc = ?, updated_at = ? WHERE id = ?').bind(
        enc,
        Date.now(),
        row.id,
      ),
    );
    reencrypted += 1;
  }

  // 一条都没解开、但库里明明有渠道：说明这个「旧密钥」不是最初那个值，整个放弃，
  // 不改任何数据（含 __key_check），让 mismatch 状态保持原样，用户可再试或改回原值。
  if (reencrypted === 0 && rows.length > 0) {
    return { reencrypted: 0, total: rows.length };
  }

  // 校验值也用当前密钥重写：否则即使渠道都重加密了，checkSecrets 仍会判 mismatch
  const sealed = await encryptSecret(KEY_CHECK_VALUE, newKey);
  await setSetting(env.DB, KEY_CHECK, sealed);

  if (updates.length > 0) {
    await env.DB.batch(updates);
  }

  return { reencrypted, total: rows.length };
}
