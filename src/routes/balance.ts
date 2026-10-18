/**
 * 下游「查询余额」。
 *
 * 只提供 cc-switch「用量查询 → 通用模板」使用的 `GET /user/balance`：
 * 该模板默认请求 `{{baseUrl}}/user/balance`，并以
 * `remaining: response.balance`、`isValid: response.is_active` 取值。
 * 这个路径与字段取自 DeepSeek 的 `/user/balance`，所以响应里同时给出两套命名，
 * 任何按通用模板或 DeepSeek 口径解析的客户端都能直接显示余额。
 *
 * 鉴权与转发接口完全一致（Authorization: Bearer / x-api-key / api-key），
 * 只返回该 Key 有权看到的额度口径，不泄漏其他用户信息。
 */

import { authenticate } from '../lib/auth.js';
import type { AuthContext, Env } from '../types.js';

/**
 * 额度不限时返回给客户端的大数。
 * 客户端普遍把 0 显示成「已用尽」，给大数才不会误报。
 */
const UNLIMITED_USD = 100_000_000;

const round = (n: number, digits = 6): number => {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
};

interface Wallet {
  /** 生效额度（美元）；unlimited 时为 UNLIMITED_USD */
  granted: number;
  used: number;
  remaining: number;
  unlimited: boolean;
  /** 生效口径来自哪一级 */
  scope: 'key' | 'user';
  keyQuota: number;
  keyUsed: number;
  userQuota: number;
  userUsed: number;
}

/**
 * 计算余额口径。
 *
 * 额度分两级：Key 自身额度优先，未设置（0）时跟随用户额度；都为 0 表示不限。
 * 约束取两级中更紧的那个 —— 必须与 auth.ts 的 assertQuota 判定一致，
 * 否则会出现「余额显示还有、调用却返回 429」的矛盾。
 */
function walletOf(ctx: AuthContext): Wallet {
  const keyQuota = ctx.key.quota_usd > 0 ? ctx.key.quota_usd : 0;
  const userQuota = ctx.user.quota_usd > 0 ? ctx.user.quota_usd : 0;

  let scope: 'key' | 'user';
  let granted: number;
  let used: number;

  if (keyQuota > 0 && (userQuota === 0 || keyQuota <= userQuota)) {
    scope = 'key';
    granted = keyQuota;
    used = ctx.key.used_usd;
  } else if (userQuota > 0) {
    scope = 'user';
    granted = userQuota;
    used = ctx.user.used_usd;
  } else {
    scope = 'key';
    granted = UNLIMITED_USD;
    used = ctx.key.used_usd;
  }

  const unlimited = granted === UNLIMITED_USD;
  return {
    granted,
    used,
    remaining: Math.max(0, granted - used),
    unlimited,
    scope,
    keyQuota: ctx.key.quota_usd,
    keyUsed: ctx.key.used_usd,
    userQuota: ctx.user.quota_usd,
    userUsed: ctx.user.used_usd,
  };
}

/** 客户端的自查信息（不含任何密钥明文） */
function identity(ctx: AuthContext, wallet: Wallet) {
  return {
    scope: wallet.scope,
    unlimited: wallet.unlimited,
    quota_usd: round(wallet.granted, 8),
    used_usd: round(wallet.used, 8),
    remaining_usd: round(wallet.remaining, 8),
    key: {
      id: ctx.key.id,
      masked: `${ctx.key.key_prefix}...${ctx.key.key_last4}`,
      name: ctx.key.name || '',
      quota_usd: ctx.key.quota_usd,
      used_usd: round(ctx.key.used_usd, 8),
    },
    user: {
      id: ctx.user.id,
      name: ctx.user.name,
      quota_usd: ctx.user.quota_usd,
      used_usd: round(ctx.user.used_usd, 8),
    },
  };
}

/** GET /user/balance —— cc-switch 通用模板读取的接口 */
export async function handleUserBalance(request: Request, env: Env): Promise<Response> {
  const { ctx } = await authenticate(request, env);
  const wallet = walletOf(ctx);
  const remaining = round(wallet.remaining, 8);
  const granted = round(wallet.granted, 8);
  const used = round(wallet.used, 8);

  return Response.json({
    // cc-switch 通用模板读取的两个字段
    is_active: ctx.user.status === 'active' && ctx.key.status === 'active',
    balance: remaining,
    // DeepSeek /user/balance 口径的等价字段
    is_available: true,
    currency: 'USD',
    balance_infos: [
      {
        currency: 'USD',
        total_balance: String(remaining),
        granted_balance: String(Math.max(0, granted - used)),
        topped_up_balance: String(granted),
      },
    ],
    ...identity(ctx, wallet),
  });
}
