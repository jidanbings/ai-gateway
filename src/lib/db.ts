/** D1 访问辅助：统一语句构造、批量写入与分页 */

import type {
  ApiKeyRow,
  ModelRow,
  UsageEntry,
  UserRow,
} from '../types.js';

export async function all<T>(stmt: D1PreparedStatement): Promise<T[]> {
  const res = await stmt.all<T>();
  return (res.results ?? []) as T[];
}

export async function first<T>(stmt: D1PreparedStatement): Promise<T | null> {
  return (await stmt.first<T>()) ?? null;
}

export async function run(stmt: D1PreparedStatement): Promise<D1Result> {
  return await stmt.run();
}

/** 批量执行；D1 batch 在单事务内提交 */
export async function batch(db: D1Database, stmts: D1PreparedStatement[]): Promise<void> {
  if (stmts.length === 0) return;
  await db.batch(stmts);
}

/** 通用分页查询，返回数据与总数（withCount 为 false 时只取当页数据） */
export async function paginate<T>(
  db: D1Database,
  opts: {
    select: string;
    from: string;
    where?: string;
    params?: unknown[];
    orderBy?: string;
    limit: number;
    offset: number;
    /** 是否统计总数。COUNT(*) 会扫描整个结果集，数据量大时按需关闭 */
    withCount?: boolean;
  },
): Promise<{ items: T[]; total: number | null }> {
  const where = opts.where ? ` WHERE ${opts.where}` : '';
  const orderBy = opts.orderBy ? ` ORDER BY ${opts.orderBy}` : '';
  const params = opts.params ?? [];

  const listStmt = db
    .prepare(`SELECT ${opts.select} FROM ${opts.from}${where}${orderBy} LIMIT ? OFFSET ?`)
    .bind(...params, opts.limit, opts.offset);

  if (opts.withCount === false) {
    return { items: await all<T>(listStmt), total: null };
  }

  const countStmt = db
    .prepare(`SELECT COUNT(*) AS n FROM ${opts.from}${where}`)
    .bind(...params);

  const [items, count] = await Promise.all([all<T>(listStmt), first<{ n: number }>(countStmt)]);
  return { items, total: count?.n ?? 0 };
}

/**
 * 写入用量明细并累加计数。
 *
 * 结算在请求结束时进行，不能失败后阻塞响应，因此调用方需自行 catch；
 * 这里用 batch 保证明细与累加计数在同一次提交内完成。
 *
 * 写入量按「每请求 2~3 行」控制：明细 + 用户额度 + 密钥（额度与最后使用合并成一条）。
 * 高频调用下 last_used_at 会被节流（见 touchKey），避免为了一次展示时间而每请求写一行。
 */
export async function recordUsage(db: D1Database, entry: UsageEntry): Promise<void> {
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO usage_logs (
           ts, request_id, user_id, key_id, channel_id, model, upstream_model,
           prompt_tokens, completion_tokens, total_tokens, cached_tokens, cost_usd, estimated,
           latency_ms, status_code, stream, error, ip, ua
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        Date.now(),
        entry.requestId,
        entry.userId,
        entry.keyId,
        entry.channelId,
        entry.model,
        entry.upstreamModel,
        entry.promptTokens,
        entry.completionTokens,
        entry.totalTokens,
        entry.cachedTokens,
        entry.costUsd,
        entry.estimated,
        entry.latencyMs,
        entry.statusCode,
        entry.stream,
        entry.error,
        entry.ip,
        entry.ua,
      ),
  ];

  const now = Date.now();

  // 预扣时已加过一次，这里只补差额（为负即退回多扣的部分）
  const delta = entry.costUsd - (entry.reservedUsd ?? 0);

  if (entry.userId != null && delta !== 0) {
    stmts.push(
      db
        .prepare('UPDATE users SET used_usd = used_usd + ?, updated_at = ? WHERE id = ?')
        .bind(delta, now, entry.userId),
    );
  }

  if (entry.keyId != null) {
    if (delta !== 0) {
      // used_usd 与 last_used_at 本来就是同一行，合成一条语句，少一次写入
      stmts.push(
        db
          .prepare('UPDATE api_keys SET used_usd = used_usd + ?, last_used_at = ? WHERE id = ?')
          .bind(delta, now, entry.keyId),
      );
    } else if (entry.touchKey !== false) {
      stmts.push(db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').bind(now, entry.keyId));
    }
  }

  await batch(db, stmts);
}

// ---------------------------------------------------------------- 设置

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await first<{ value: string }>(
    db.prepare('SELECT value FROM settings WHERE key = ?').bind(key),
  );
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await run(
    db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(key, value, Date.now()),
  );
}

// ---------------------------------------------------------------- 类型化查询

export async function getUser(db: D1Database, id: number): Promise<UserRow | null> {
  return first<UserRow>(db.prepare('SELECT * FROM users WHERE id = ?').bind(id));
}

export async function getModel(db: D1Database, id: string): Promise<ModelRow | null> {
  return first<ModelRow>(db.prepare('SELECT * FROM models WHERE id = ?').bind(id));
}

export async function findKeyByHash(db: D1Database, keyHash: string): Promise<ApiKeyRow | null> {
  return first<ApiKeyRow>(db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').bind(keyHash));
}
