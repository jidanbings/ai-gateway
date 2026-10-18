/**
 * 仅本地开发 / 测试构建可用的辅助端点。
 *
 * 这些端点会直接改动用量数据，绝不能在线上暴露：index.ts 按构建期常量
 * __TEST_ENDPOINTS__ 决定是否挂载本路由，正式构建（npm run build）里它根本不存在。
 */

import { Hono } from 'hono';
import { all, first } from '../lib/db.js';
import { badRequest } from '../lib/errors.js';
import { DAY_MS } from '../lib/maintenance.js';
import { asNumber } from '../lib/validate.js';
import type { Env } from '../types.js';

export const testApi = new Hono<{ Bindings: Env }>();

// 错误统一由 index.ts 的 app.onError 处理，这里不再重复注册

/**
 * 注入跨天用量数据。
 *
 * 偏移量写死在天数上，好让「清理到最近 N 天」的断言能精确算出该剩下几行：
 * 10 天前的两行落在任何 1~7 天窗口之外（会被删），3 天前 / 1 天前 / 今天的不受影响。
 */
testApi.post('/seed-usage', async (c) => {
  const env = c.env;
  const now = Date.now();

  // 清理旧数据，保证可重复运行
  await env.DB.prepare('DELETE FROM usage_logs').run();

  const user = await first<{ id: number }>(env.DB.prepare('SELECT id FROM users ORDER BY id LIMIT 1'));
  const channel = await first<{ id: number }>(
    env.DB.prepare('SELECT id FROM channels ORDER BY id LIMIT 1'),
  );
  const userId = user?.id ?? null;
  const channelId = channel?.id ?? null;

  const rows: Array<[number, number, number, number, number, number]> = [
    // [ts 偏移, prompt, completion, cost, statusCode, cached（命中缓存的输入 token）]
    // 10 天前 → 任何 1~7 天窗口都覆盖不到，手动清理后应被删除
    [-10 * DAY_MS, 1000, 2000, 1.5, 200, 400],
    [-10 * DAY_MS, 500, 500, 0.5, 500, 0],
    // 3 天前 → 只有把窗口收到 1~3 天才删得到
    [-3 * DAY_MS, 100, 200, 0.25, 200, 60],
    [-3 * DAY_MS, 50, 50, 0.05, 200, 0],
    // 昨天
    [-1 * DAY_MS, 300, 400, 0.7, 200, 250],
    [-1 * DAY_MS, 10, 10, 0.01, 429, 0],
    // 今天
    [0, 20, 30, 0.02, 200, 5],
  ];

  const stmts = rows.map(([offset, prompt, completion, cost, status, cached], i) =>
    env.DB.prepare(
      `INSERT INTO usage_logs
         (ts, request_id, user_id, key_id, channel_id, model, upstream_model,
          prompt_tokens, completion_tokens, total_tokens, cached_tokens, cost_usd, estimated,
          latency_ms, status_code, stream, error, ip, ua)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,100,?,0,NULL,'127.0.0.1','seed')`,
    ).bind(
      now + offset,
      `seed-${i}`,
      userId,
      null,
      channelId,
      'gpt-4o-mini',
      'fake-chat',
      prompt,
      completion,
      prompt + completion,
      cached,
      cost,
      status,
    ),
  );

  await env.DB.batch(stmts);
  return c.json({ ok: true, inserted: rows.length });
});

/** 用量明细概况：用于断言手动清理的效果 */
testApi.get('/usage-stats', async (c) => {
  const row = await first<{ n: number; oldest: number | null }>(
    c.env.DB.prepare('SELECT COUNT(*) AS n, MIN(ts) AS oldest FROM usage_logs'),
  );

  return c.json({
    totalLogs: row?.n ?? 0,
    /** 最旧一条明细的时间戳（null 表示表是空的） */
    oldestTs: row?.oldest ?? null,
  });
});

/** 清理过期会话 */
testApi.post('/prune-sessions', async (c) => {
  const env = c.env;
  const result = await env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?')
    .bind(Date.now())
    .run();
  return c.json({ ok: true, deleted: result.meta.changes ?? 0 });
});

/** 直接查询明细，用于断言字段写入正确 */
testApi.get('/logs', async (c) => {
  const limit = asNumber(c.req.query('limit'), 'limit', { min: 1, max: 500, fallback: 50 });
  const model = c.req.query('model');
  if (model && model.length > 200) throw badRequest('model 过长', 'model');

  const rows = model
    ? await all<Record<string, unknown>>(
        c.env.DB.prepare('SELECT * FROM usage_logs WHERE model = ? ORDER BY ts DESC LIMIT ?').bind(
          model,
          limit,
        ),
      )
    : await all<Record<string, unknown>>(
        c.env.DB.prepare('SELECT * FROM usage_logs ORDER BY ts DESC LIMIT ?').bind(limit),
      );

  return c.json({ items: rows });
});
