/**
 * 管理后台会话。
 *
 * 登录只校验单个管理令牌（常量时间比较），成功后签发随机会话令牌，
 * 库中只存其 SHA-256；Cookie 为 HttpOnly + Secure + SameSite=Lax，
 * 因此管理界面不会被跨站脚本直接读取令牌，也不参与跨站请求。
 *
 * 管理令牌来自 Worker 的 Secret `ADMIN_TOKEN`（控制台 → Settings → Variables and Secrets
 * 添加，类型选 Secret）。没配置时登录接口返回 503 并说明缺什么，不会回落到任何默认值。
 */

import { randomToken, sha256Hex, timingSafeEqual } from './crypto.js';
import { first } from './db.js';
import { adminToken } from './bootstrap.js';
import { forbidden, unauthorized } from './errors.js';
import { LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS, loginWindow } from './ratelimit.js';
import type { Env } from '../types.js';

const SESSION_COOKIE = 'ag_session';
const SESSION_TTL_MS = 12 * 60 * 60_000;

export interface AdminSession {
  id: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  ip: string | null;
  ua: string | null;
}

function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get('cookie');
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) {
      // 值可能是非法百分号编码（`ag_session=%` 会让 decodeURIComponent 抛 URIError），
      // 这类请求应当按「没有会话」走 401，而不是 500
      try {
        out[name] = decodeURIComponent(value);
      } catch {
        out[name] = value;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- 登录

export async function verifyAdminToken(env: Env, token: string): Promise<boolean> {
  // adminToken() 在未配置 Secret 时抛 503，把「缺配置」与「令牌不对」区分开
  const expected = adminToken(env);
  return timingSafeEqual(token, expected);
}

export async function isLoginBlocked(env: Env, ip: string, now = Date.now()): Promise<boolean> {
  const row = await first<{ count: number }>(
    env.DB.prepare('SELECT count FROM login_attempts WHERE ip = ? AND window = ?').bind(
      ip,
      loginWindow(now),
    ),
  );
  return (row?.count ?? 0) >= LOGIN_MAX_FAILURES;
}

export async function recordLoginFailure(env: Env, ip: string, now = Date.now()): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO login_attempts (ip, window, count) VALUES (?,?,1)
     ON CONFLICT(ip, window) DO UPDATE SET count = count + 1`,
  )
    .bind(ip, loginWindow(now))
    .run()
    .catch(() => undefined);
}

export async function clearLoginFailures(env: Env, ip: string, now = Date.now()): Promise<void> {
  await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ? AND window = ?')
    .bind(ip, loginWindow(now))
    .run()
    .catch(() => undefined);
}

/** 过期记录清理，登录成功时顺带执行 */
export async function pruneLoginAttempts(env: Env, now = Date.now()): Promise<void> {
  await env.DB.prepare('DELETE FROM login_attempts WHERE window < ?')
    .bind(loginWindow(now) - 1)
    .run()
    .catch(() => undefined);
}

export async function createSession(
  env: Env,
  request: Request,
): Promise<{ cookie: string; expiresAt: number }> {
  const token = randomToken(32);
  const id = await sha256Hex(token);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;

  await env.DB.prepare(
    'INSERT INTO admin_sessions (id, created_at, expires_at, last_seen_at, ip, ua) VALUES (?,?,?,?,?,?)',
  )
    .bind(
      id,
      now,
      expiresAt,
      now,
      request.headers.get('cf-connecting-ip') ?? '',
      (request.headers.get('user-agent') ?? '').slice(0, 300),
    )
    .run();

  return { cookie: buildCookie(token, SESSION_TTL_MS / 1000), expiresAt };
}

export async function destroySession(env: Env, request: Request): Promise<string> {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (token) {
    const id = await sha256Hex(token);
    await env.DB.prepare('DELETE FROM admin_sessions WHERE id = ?').bind(id).run().catch(() => undefined);
  }
  return buildCookie('', 0);
}

function buildCookie(value: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(maxAgeSeconds)}`;
}

// ---------------------------------------------------------------- 会话校验

export async function requireAdmin(request: Request, env: Env): Promise<AdminSession> {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token) throw unauthorized('未登录');

  const id = await sha256Hex(token);
  const session = await first<AdminSession>(
    env.DB.prepare('SELECT * FROM admin_sessions WHERE id = ?').bind(id),
  );
  if (!session) throw unauthorized('会话无效，请重新登录');

  const now = Date.now();
  if (session.expires_at <= now) {
    await env.DB.prepare('DELETE FROM admin_sessions WHERE id = ?').bind(id).run().catch(() => undefined);
    throw unauthorized('会话已过期，请重新登录');
  }

  // 每 5 分钟回写一次活跃时间，避免每个请求都写库
  if (now - session.last_seen_at > 300_000) {
    await env.DB.prepare('UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?')
      .bind(now, id)
      .run()
      .catch(() => undefined);
  }

  return session;
}

/** 清理过期会话 */
export async function pruneSessions(env: Env, now = Date.now()): Promise<void> {
  await env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?')
    .bind(now)
    .run()
    .catch(() => undefined);
}

export { forbidden, LOGIN_WINDOW_MS, SESSION_COOKIE };
