/**
 * 限流。
 *
 * RPM 采用每 isolate 内存计数（软限）：Worker 会同时运行多个 isolate，实际放行量
 * 约为「配置值 × isolate 数」，用于防止单 key 打爆上游，而不是精确计费闸门。
 * 额度（美元）由 D1 中的 used_usd 精确控制，是真正的硬闸门。
 */

interface Bucket {
  window: number;
  count: number;
}

const buckets = new Map<number, Bucket>();

/** 内存表上限，超出时清理过期窗口，防止长期运行的 isolate 内存增长 */
const MAX_BUCKETS = 10_000;

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** 距窗口重置的秒数 */
  resetAfter: number;
}

export function checkRateLimit(keyId: number, limit: number, now = Date.now()): RateLimitResult {
  const window = Math.floor(now / 60_000);
  if (limit <= 0) {
    return { allowed: true, limit: 0, remaining: 0, resetAfter: 0 };
  }

  let bucket = buckets.get(keyId);
  if (!bucket || bucket.window !== window) {
    if (buckets.size >= MAX_BUCKETS) sweep(window);
    bucket = { window, count: 0 };
    buckets.set(keyId, bucket);
  }

  bucket.count++;
  const resetAfter = 60 - Math.floor((now % 60_000) / 1000);
  return {
    allowed: bucket.count <= limit,
    limit,
    remaining: Math.max(0, limit - bucket.count),
    resetAfter,
  };
}

function sweep(currentWindow: number): void {
  for (const [id, bucket] of buckets) {
    if (bucket.window < currentWindow) buckets.delete(id);
  }
  // 极端情况下同一分钟内仍堆积过多条目，直接重置，避免无界增长
  if (buckets.size >= MAX_BUCKETS) buckets.clear();
}

// ---------------------------------------------------------------- 管理登录防爆破

/** 同一 IP 在 15 分钟窗口内允许的登录失败次数 */
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 15 * 60_000;

export function loginWindow(now = Date.now()): number {
  return Math.floor(now / LOGIN_WINDOW_MS);
}

export { LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS };
