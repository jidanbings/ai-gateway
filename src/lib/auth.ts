/**
 * 下游鉴权。
 *
 * 下游 Key 以 SHA-256 哈希入库，明文只在创建时返回一次。校验顺序为
 * 「格式 → 存在 → 启用 → 过期 → 用户状态 → 额度 → RPM」，任一步失败都返回
 * 明确的 401/403/429，不泄漏其他 Key 或用户的信息。
 */

import { sha256Hex } from './crypto.js';
import { findKeyByHash, getUser } from './db.js';
import { forbidden, quotaExceeded, rateLimited, unauthorized } from './errors.js';
import { checkRateLimit } from './ratelimit.js';
import type { AuthContext, Env, UserRow } from '../types.js';

export interface AuthResult {
  ctx: AuthContext;
  rate: { limit: number; remaining: number; resetAfter: number };
}

/**
 * 从请求头提取下游 Key。
 *
 * 兼容三种客户端习惯，避免用户因为「头部形态不对」而看到 401 却查不到原因：
 *   Authorization: Bearer <key>   —— OpenAI 官方 SDK、绝大多数客户端
 *   x-api-key: <key>              —— Anthropic 风格（Claude Code、Cline 等）
 *   api-key: <key>                —— Azure OpenAI 风格
 * 另外容忍把裸 Key 直接塞进 Authorization（不带 Bearer）的客户端；
 * 只接受不含空格的整串，因此 `Basic xxx` 之类不会被误当成 Key。
 */
export function extractBearer(request: Request): string | null {
  const auth = (request.headers.get('authorization') ?? '').trim();
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m?.[1]) return m[1].trim();
    if (!/\s/.test(auth)) return auth;
  }
  const xApiKey = request.headers.get('x-api-key') ?? request.headers.get('api-key');
  if (xApiKey) return xApiKey.trim();
  return null;
}

export async function authenticate(request: Request, env: Env): Promise<AuthResult> {
  const raw = extractBearer(request);
  if (!raw) throw unauthorized('缺少 API Key，请在 Authorization 头中提供 Bearer <key>');
  if (!raw.startsWith('sk-') || raw.length < 20) throw unauthorized('API Key 格式不正确');

  const hash = await sha256Hex(raw);
  const key = await findKeyByHash(env.DB, hash);
  if (!key) throw unauthorized('API Key 不存在或已被删除');
  if (key.status !== 'active') throw forbidden('该 API Key 已被禁用');

  const now = Date.now();
  if (key.expires_at != null && key.expires_at <= now) {
    throw unauthorized('该 API Key 已过期');
  }

  const user = await getUser(env.DB, key.user_id);
  if (!user) throw unauthorized('API Key 所属用户不存在');
  if (user.status !== 'active') throw forbidden('该账号已被禁用');

  assertQuota(key, user);

  const rpmLimit = key.rpm_limit > 0 ? key.rpm_limit : user.rpm_limit;
  const rate = checkRateLimit(key.id, rpmLimit, now);
  if (!rate.allowed) {
    throw rateLimited(`请求过于频繁，当前限制为每分钟 ${rpmLimit} 次，请在 ${rate.resetAfter} 秒后重试`);
  }

  return { ctx: { key, user }, rate };
}

/**
 * 额度检查。
 *
 * Key 自身额度优先，未设置时跟随用户额度；两者都为 0 表示不限。
 * 额度用尽返回 429（与 OpenAI 的 insufficient_quota 行为一致），而非 403，
 * 这样下游 SDK 的退避重试逻辑能正确识别。
 */
function assertQuota(key: { quota_usd: number; used_usd: number }, user: UserRow): void {
  if (key.quota_usd > 0 && key.used_usd >= key.quota_usd) {
    throw quotaExceeded('该 API Key 额度已用尽');
  }
  if (user.quota_usd > 0 && user.used_usd >= user.quota_usd) {
    throw quotaExceeded('该账号额度已用尽');
  }
}

/**
 * 额度预扣，返回实际扣掉的金额（没扣则为 0）。
 *
 * `assertQuota` 是「先查后扣」—— 并发请求都会看到同一个 used_usd 并全部放行。这里在
 * 转发前用一条带条件的 UPDATE 原子扣掉估算上限，实际花费在结算时补差额（见 recordUsage）。
 * 只有配了有限额度的一方才预扣，额度为 0（不限）的走原路径，不增加任何写入。
 *
 * 取舍：预扣与结算之间 Worker 被回收，这笔钱会留在账上 —— 范围由估算上限兜住。
 */
export async function reserveQuota(
  env: Env,
  key: { id: number; quota_usd: number },
  user: { id: number; quota_usd: number },
  amount: number,
): Promise<number> {
  if (amount <= 0) return 0;
  const needUser = user.quota_usd > 0;
  const needKey = key.quota_usd > 0;
  // 必须返回 0 而不是 amount：调用方按「实际花费 − 返回值」记账，谎报会减去一笔
  // 从未加过的钱，账面直接变负
  if (!needUser && !needKey) return 0;

  const now = Date.now();

  if (needUser) {
    const res = await env.DB.prepare(
      `UPDATE users SET used_usd = used_usd + ?, updated_at = ?
        WHERE id = ? AND (quota_usd = 0 OR used_usd + ? <= quota_usd)`,
    )
      .bind(amount, now, user.id, amount)
      .run();
    if ((res.meta?.changes ?? 0) !== 1) throw quotaExceeded('该账号额度已用尽');
  }

  if (needKey) {
    const res = await env.DB.prepare(
      `UPDATE api_keys SET used_usd = used_usd + ?
        WHERE id = ? AND (quota_usd = 0 OR used_usd + ? <= quota_usd)`,
    )
      .bind(amount, key.id, amount)
      .run();
    if ((res.meta?.changes ?? 0) !== 1) {
      // 用户那侧已经扣掉了，这里失败必须退回
      if (needUser) {
        await env.DB.prepare('UPDATE users SET used_usd = used_usd - ?, updated_at = ? WHERE id = ?')
          .bind(amount, now, user.id)
          .run()
          .catch(() => undefined);
      }
      throw quotaExceeded('该 API Key 额度已用尽');
    }
  }

  return amount;
}
