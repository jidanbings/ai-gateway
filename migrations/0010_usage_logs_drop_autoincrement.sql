-- usage_logs 去掉 AUTOINCREMENT
--
-- id 列本身保留：它是 INTEGER PRIMARY KEY，也就是 rowid 的别名，不额外占存储，
-- 而且有它在，D1 控制台会把它当成普通列显示为 id，而不是渲染出隐式的 rowid。
--
-- 但 AUTOINCREMENT 是个持续的额外负担：SQLite 为了兑现「rowid 单调递增、绝不复用」
-- 会维护一张 sqlite_sequence 表，每次 INSERT 都要对它读写一次。日志表每请求写一行，
-- 这个开销是按请求计的。而「rowid 不复用」对本表毫无意义——没有任何代码读 id，
-- 先删后插留下的空洞也不影响任何查询（一切按 ts 排序、按索引过滤）。
--
-- 所以重建一次，仅移除 AUTOINCREMENT。列定义、列顺序、索引与重建前完全一致，
-- 差别只有：不再维护 sqlite_sequence，删掉最后一行后新行可以复用它的 rowid。

CREATE TABLE usage_logs_new (
  id                INTEGER PRIMARY KEY,
  ts                INTEGER NOT NULL,
  request_id        TEXT NOT NULL,
  user_id           INTEGER,
  key_id            INTEGER,
  channel_id        INTEGER,
  model             TEXT,
  upstream_model    TEXT,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL NOT NULL DEFAULT 0,
  estimated         INTEGER NOT NULL DEFAULT 0,
  latency_ms        INTEGER NOT NULL DEFAULT 0,
  status_code       INTEGER NOT NULL DEFAULT 200,
  stream            INTEGER NOT NULL DEFAULT 0,
  error             TEXT,
  ip                TEXT,
  ua                TEXT,
  cached_tokens     INTEGER NOT NULL DEFAULT 0
);

INSERT INTO usage_logs_new (
  id, ts, request_id, user_id, key_id, channel_id, model, upstream_model,
  prompt_tokens, completion_tokens, total_tokens, cost_usd, estimated,
  latency_ms, status_code, stream, error, ip, ua, cached_tokens
)
SELECT
  id, ts, request_id, user_id, key_id, channel_id, model, upstream_model,
  prompt_tokens, completion_tokens, total_tokens, cost_usd, estimated,
  latency_ms, status_code, stream, error, ip, ua, cached_tokens
FROM usage_logs;

DROP TABLE usage_logs;

ALTER TABLE usage_logs_new RENAME TO usage_logs;

CREATE INDEX IF NOT EXISTS idx_usage_logs_ts ON usage_logs(ts);
CREATE INDEX IF NOT EXISTS idx_usage_logs_user_ts ON usage_logs(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_usage_logs_key_ts ON usage_logs(key_id, ts);
CREATE INDEX IF NOT EXISTS idx_usage_logs_model_ts ON usage_logs(model, ts);
CREATE INDEX IF NOT EXISTS idx_usage_logs_channel_ts ON usage_logs(channel_id, ts);
CREATE INDEX IF NOT EXISTS idx_usage_logs_model_ts_cached
  ON usage_logs(model, ts, cached_tokens);
CREATE INDEX IF NOT EXISTS idx_usage_logs_errors
  ON usage_logs(ts) WHERE status_code >= 400 OR error IS NOT NULL;
