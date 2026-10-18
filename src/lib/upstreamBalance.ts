/**
 * 上游余额查询。
 *
 * 上游平台各不相同，这里按「已知平台特化 + 通用兜底」两级处理：
 *
 *   1. 已知主机（DeepSeek / OpenRouter / Moonshot / 硅基流动）用各自的接口与字段
 *   2. 其余走通用约定 —— 先试 `{base_url}/user/balance`（DeepSeek 与多数中转站都实现，
 *      与 cc-switch「通用模板」同一口径），再试 `/dashboard/billing/credit_grants`
 *      （one-api / new-api / OpenAI 旧接口的额度查询）
 *
 * 字段用一组宽松的候选名匹配，尽量兼容中转站的各式返回。
 * 查询失败**不算渠道故障**：只记录原因，不影响路由与熔断。
 */

import { encryptionKey } from './bootstrap.js';
import { decryptSecret } from './crypto.js';
import { all } from './db.js';
import type { ChannelRow, Env } from '../types.js';

export interface UpstreamBalance {
  /** 是否成功取到可识别的余额 */
  ok: boolean;
  /** 余额数值；null 表示上游没有返回可识别字段（例如只支持「可用/不可用」判定） */
  amount: number | null;
  /** 币种或单位：USD / CNY / credits / … */
  currency: string | null;
  /** 上游自报是否可用（部分接口返回 is_active / is_available） */
  active: boolean | null;
  status: number;
  latency_ms: number;
  message: string;
}

/** 单次余额查询的候选地址上限，避免把调用的子请求预算用光 */
const MAX_CANDIDATES = 3;
const TIMEOUT_MS = 12_000;

/**
 * 余额字段的候选键（按优先级）。
 *
 * 覆盖：DeepSeek `total_balance`、通用模板 `balance`、one-api `total_available`、
 * 硅基流动 `balance`、OpenRouter `credits`、各类中转站常见的 `remaining`。
 */
const AMOUNT_KEYS = [
  'balance',
  'total_balance',
  'totalBalance',
  'available_balance',
  'availableBalance',
  'remaining',
  'remaining_balance',
  'total_available',
  'credits',
  'quota',
  'amount',
];

const CURRENCY_KEYS = ['currency', 'unit', 'unit_name', 'symbol'];

/**
 * DeepSeek 口径：`balance_infos` 里可能同时有 CNY 与 USD 两条。
 *
 * 只显示「第一个」会把「0 美元」当成余额，掩盖账户里真正还有的人民币，
 * 因此取金额最大的那条，并把其余的写进说明里。
 */
function extractBalanceInfos(
  root: unknown,
): { amount: number; currency: string | null; others: string } | null {
  const infos = (root as { balance_infos?: unknown } | null)?.balance_infos;
  if (!Array.isArray(infos)) return null;

  const entries: Array<{ amount: number; currency: string | null }> = [];
  for (const item of infos) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const amount = toNumber(obj.total_balance ?? obj.balance);
    if (amount === null) continue;
    entries.push({ amount, currency: typeof obj.currency === 'string' ? obj.currency : null });
  }
  if (entries.length === 0) return null;

  const best = entries.reduce((a, b) => (b.amount > a.amount ? b : a));
  const others = entries
    .filter((e) => e !== best)
    .map((e) => `${e.amount} ${e.currency ?? ''}`.trim())
    .join(' / ');
  return { ...best, others };
}

/** 把上游给的值转成数字：既接受 number，也接受 "12.34" / "¥12.34" 这类字符串 */
function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const m = /-?\d+(?:\.\d+)?/.exec(value);
    if (!m) return null;
    const n = Number(m[0]);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function pickString(obj: Record<string, unknown> | null, keys: string[]): string | null {
  if (!obj) return null;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return null;
}

/**
 * 在返回体里找余额。
 *
 * 广度优先遍历前两层（含 `data`、`balance_infos[0]` 这类常见包装），
 * 命中第一个可识别的数值即返回；顺带取同一层的币种。
 */
function findAmount(root: unknown): { amount: number | null; currency: string | null; active: boolean | null } {
  const queue: unknown[] = [root];
  let depth = 0;

  while (queue.length > 0 && depth < 3) {
    const levelSize = queue.length;
    for (let i = 0; i < levelSize; i++) {
      const node = queue.shift();
      if (!node || typeof node !== 'object') continue;
      const obj = node as Record<string, unknown>;

      for (const key of AMOUNT_KEYS) {
        if (!(key in obj)) continue;
        const amount = toNumber(obj[key]);
        if (amount !== null) {
          return {
            amount,
            currency: pickString(obj, CURRENCY_KEYS),
            active: readActive(obj),
          };
        }
      }

      for (const value of Object.values(obj)) {
        if (value && typeof value === 'object') queue.push(value);
      }
    }
    depth++;
  }

  // 没有数值，但可能只给了可用性判定
  const active = readActive(root as Record<string, unknown>);
  return { amount: null, currency: null, active };
}

function readActive(obj: Record<string, unknown> | null): boolean | null {
  if (!obj) return null;
  for (const key of ['is_active', 'isActive', 'is_available', 'isAvailable', 'usable']) {
    if (typeof obj[key] === 'boolean') return obj[key] as boolean;
  }
  return null;
}

/** 候选查询地址：特化接口优先，其余为通用约定 */
export function balanceCandidates(baseUrl: string): string[] {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return [];
  }
  const base = url.origin + url.pathname.replace(/\/+$/, '');
  const host = url.hostname.toLowerCase();
  const out: string[] = [];

  const push = (u: string): void => {
    if (!out.includes(u)) out.push(u);
  };

  // 1) 已知平台
  if (host.endsWith('deepseek.com')) push(`${url.origin}/user/balance`);
  if (host.endsWith('openrouter.ai')) push(`${url.origin}/api/v1/credits`);
  if (host.endsWith('moonshot.cn') || host.endsWith('moonshot.ai')) push(`${base}/users/me/balance`);
  if (host.endsWith('siliconflow.cn') || host.endsWith('siliconflow.com')) push(`${base}/user/info`);

  // 2) 通用约定（cc-switch 通用模板 / DeepSeek 口径）
  push(`${base}/user/balance`);

  // 3) OpenAI 旧接口，one-api / new-api 中转站普遍实现
  push(`${url.origin}/dashboard/billing/credit_grants`);

  return out.slice(0, MAX_CANDIDATES);
}

/**
 * credit_grants 形态：需要自己算「总额度 - 已用」。
 * OpenAI / one-api 返回 `{ total_granted, total_used, total_available }`。
 */
function extractCreditGrants(root: unknown): { amount: number | null; currency: string | null } {
  if (!root || typeof root !== 'object') return { amount: null, currency: null };
  const obj = root as Record<string, unknown>;

  const available = toNumber(obj.total_available);
  if (available !== null) return { amount: available, currency: 'USD' };

  const granted = toNumber(obj.total_granted);
  const used = toNumber(obj.total_used);
  if (granted !== null) {
    return { amount: granted - (used ?? 0), currency: 'USD' };
  }
  return { amount: null, currency: null };
}

/** OpenRouter：总额度 - 已用 */
function extractOpenRouter(root: unknown): { amount: number | null; currency: string | null } {
  const data = (root as { data?: Record<string, unknown> } | null)?.data;
  if (!data) return { amount: null, currency: null };
  const total = toNumber(data.total_credits);
  const usage = toNumber(data.total_usage);
  if (total === null) return { amount: null, currency: null };
  return { amount: total - (usage ?? 0), currency: 'credits' };
}

/** 查询单个渠道的余额 */
export async function fetchChannelBalance(channel: ChannelRow, env: Env): Promise<UpstreamBalance> {
  const started = Date.now();
  const base = { status: 0, latency_ms: 0, active: null as boolean | null };

  let apiKey: string;
  try {
    apiKey = await decryptSecret(channel.api_key_enc, encryptionKey(env));
  } catch {
    return {
      ...base,
      ok: false,
      amount: null,
      currency: null,
      message: '渠道密钥无法解密，请重新保存该渠道的 API Key',
    };
  }

  const candidates = balanceCandidates(channel.base_url);
  if (candidates.length === 0) {
    return { ...base, ok: false, amount: null, currency: null, message: 'base_url 不是合法 URL' };
  }

  let lastMessage = '';
  for (const url of candidates) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'TimeoutError';
      lastMessage = aborted ? '查询超时' : `网络错误：${err instanceof Error ? err.message : String(err)}`;
      continue;
    }

    const latency = Date.now() - started;

    // 该地址不存在 → 试下一个候选
    if (res.status === 404 || res.status === 405) {
      lastMessage = `上游未提供余额接口（HTTP ${res.status}）`;
      continue;
    }
    // 鉴权/权限问题：换地址也没用，直接给出结论
    if (res.status === 401 || res.status === 403) {
      return {
        ...base,
        status: res.status,
        latency_ms: latency,
        ok: false,
        amount: null,
        currency: null,
        message: `密钥被拒绝（HTTP ${res.status}），请确认 Key 是否有效`,
      };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      lastMessage = `HTTP ${res.status}：${text.slice(0, 200)}`;
      continue;
    }

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(await res.text());
    } catch {
      // 不少中转站对未知路径返回 200 + HTML，这里换下一个候选地址再试
      lastMessage = '上游返回的不是 JSON（该地址可能不是余额接口）';
      continue;
    }

    // 先按特化形态解析，再退回通用字段匹配
    let amount: number | null = null;
    let currency: string | null = null;
    let others = '';
    if (url.includes('/credits')) {
      ({ amount, currency } = extractOpenRouter(parsed));
    } else if (url.includes('/credit_grants')) {
      ({ amount, currency } = extractCreditGrants(parsed));
    }
    if (amount === null) {
      const infos = extractBalanceInfos(parsed);
      if (infos) {
        amount = infos.amount;
        currency = infos.currency;
        others = infos.others;
      }
    }
    if (amount === null) {
      const generic = findAmount(parsed);
      amount = generic.amount;
      currency = currency ?? generic.currency;
    }

    if (amount === null) {
      const active = readActive(parsed as Record<string, unknown>) ?? findAmount(parsed).active;
      // 上游自报不可用（欠费）是确定结论，直接返回；
      // 只是「认不出字段」则继续试下一个候选地址
      if (active === false) {
        return {
          ...base,
          status: res.status,
          latency_ms: latency,
          active,
          ok: true,
          amount: 0,
          currency: null,
          message: '上游报告账号不可用（可能欠费）',
        };
      }
      lastMessage = '连接正常，但未能识别余额字段';
      continue;
    }

    const active = readActive(parsed as Record<string, unknown>) ?? findAmount(parsed).active;
    // 多条币种时把其余金额写进说明（界面以悬浮提示展示）
    const message = `余额 ${amount} ${currency ?? ''}`.trim() + (others ? `（另有 ${others}）` : '');
    return {
      ...base,
      status: res.status,
      latency_ms: latency,
      active,
      ok: true,
      amount,
      currency: currency ?? 'USD',
      message,
    };
  }

  return {
    ...base,
    latency_ms: Date.now() - started,
    ok: false,
    amount: null,
    currency: null,
    message: lastMessage || '未能获取余额',
  };
}

/** 把查询结果写回渠道（只用于展示，不参与路由） */
export async function saveChannelBalance(
  env: Env,
  channelId: number,
  result: UpstreamBalance,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE channels SET balance_amount = ?, balance_currency = ?, balance_checked_at = ?,
            balance_error = ?, updated_at = ?
      WHERE id = ?`,
  )
    .bind(
      result.amount,
      result.currency,
      Date.now(),
      result.ok ? null : result.message.slice(0, 300),
      Date.now(),
      channelId,
    )
    .run()
    .catch(() => undefined);
}

export interface BalanceRefreshItem {
  id: number;
  name: string;
  ok: boolean;
  amount: number | null;
  currency: string | null;
  message: string;
}

/**
 * 按「最久未查」轮转刷新若干渠道的余额。
 *
 * 单次有上限：免费版每次调用的子请求上限是 50，而每个渠道最多要试 3 个候选地址，
 * 因此渠道多时必须分批轮转，不能一次全刷。
 *
 * @param maxAgeMs 只刷新超过该时长未查过的渠道
 * @param force    true = 忽略时间条件，强制刷新最久未查的几个
 */
export async function refreshStaleBalances(
  env: Env,
  limit: number,
  maxAgeMs: number,
  force = false,
): Promise<BalanceRefreshItem[]> {
  const cutoff = force ? Date.now() : Date.now() - maxAgeMs;
  const rows = await all<ChannelRow>(
    env.DB.prepare(
      `SELECT * FROM channels
        WHERE status = 'enabled' AND (balance_checked_at IS NULL OR balance_checked_at <= ?)
        ORDER BY COALESCE(balance_checked_at, 0) ASC, id ASC
        LIMIT ?`,
    ).bind(cutoff, limit),
  );

  const out: BalanceRefreshItem[] = [];
  for (const channel of rows) {
    const result = await fetchChannelBalance(channel, env);
    await saveChannelBalance(env, channel.id, result);
    out.push({
      id: channel.id,
      name: channel.name,
      ok: result.ok,
      amount: result.amount,
      currency: result.currency,
      message: result.message,
    });
  }
  return out;
}
