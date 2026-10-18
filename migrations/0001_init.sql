-- AI Gateway 初始表结构
-- 约定：
--   * 所有时间戳为 Unix 毫秒（INTEGER）
--   * 金额单位为美元（REAL），额度 0 表示不限
--   * 不使用 PRAGMA / 外键级联，级联删除在应用层显式处理

-- ---------------------------------------------------------------- 全局设置
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------- 用户（下游）
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  email      TEXT,
  note       TEXT,
  status     TEXT NOT NULL DEFAULT 'active',   -- active | disabled
  quota_usd  REAL NOT NULL DEFAULT 0,          -- 0 = 不限
  used_usd   REAL NOT NULL DEFAULT 0,
  rpm_limit  INTEGER NOT NULL DEFAULT 0,       -- 0 = 不限
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- ---------------------------------------------------------------- 下游 API Key
CREATE TABLE IF NOT EXISTS api_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  key_hash     TEXT NOT NULL UNIQUE,           -- sha256(明文 key) 的十六进制
  key_prefix   TEXT NOT NULL,                  -- 形如 sk-abcd，用于列表展示
  key_last4    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active', -- active | disabled
  quota_usd    REAL NOT NULL DEFAULT 0,        -- 0 = 跟随用户
  used_usd     REAL NOT NULL DEFAULT 0,
  rpm_limit    INTEGER NOT NULL DEFAULT 0,     -- 0 = 跟随用户
  expires_at   INTEGER,
  last_used_at INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);

-- ---------------------------------------------------------------- 上游渠道
CREATE TABLE IF NOT EXISTS channels (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  base_url         TEXT NOT NULL,              -- 例如 https://api.deepseek.com
  api_key_enc      TEXT NOT NULL,              -- AES-GCM 密文
  status           TEXT NOT NULL DEFAULT 'enabled', -- enabled | disabled
  priority         INTEGER NOT NULL DEFAULT 0, -- 越大越优先
  weight           INTEGER NOT NULL DEFAULT 1, -- 同优先级内加权随机
  allow_all_models INTEGER NOT NULL DEFAULT 0, -- 1 = 未登记的模型也直连透传
  timeout_ms       INTEGER NOT NULL DEFAULT 120000,
  extra_headers    TEXT NOT NULL DEFAULT '{}', -- JSON 对象，附加请求头
  inject_usage     INTEGER NOT NULL DEFAULT 1, -- 流式请求自动带 stream_options.include_usage
  cooldown_until   INTEGER NOT NULL DEFAULT 0, -- 熔断截止时间
  fail_count       INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  last_ok_at       INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channels_status ON channels(status);

-- ---------------------------------------------------------------- 渠道模型映射
-- 下游模型名 -> 上游真实模型名
CREATE TABLE IF NOT EXISTS channel_models (
  channel_id     INTEGER NOT NULL,
  model          TEXT NOT NULL,                -- 下游模型名
  upstream_model TEXT NOT NULL,                -- 上游模型名
  PRIMARY KEY (channel_id, model)
);
CREATE INDEX IF NOT EXISTS idx_channel_models_model ON channel_models(model);

-- ---------------------------------------------------------------- 对外模型与定价
CREATE TABLE IF NOT EXISTS models (
  id               TEXT PRIMARY KEY,           -- 下游模型名
  display_name     TEXT NOT NULL DEFAULT '',
  description      TEXT NOT NULL DEFAULT '',
  enabled          INTEGER NOT NULL DEFAULT 1,
  prompt_price     REAL NOT NULL DEFAULT 0,    -- 美元 / 1M 输入 token
  completion_price REAL NOT NULL DEFAULT 0,    -- 美元 / 1M 输出 token
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- ---------------------------------------------------------------- 用量明细
CREATE TABLE IF NOT EXISTS usage_logs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
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
  estimated         INTEGER NOT NULL DEFAULT 0, -- 1 = token 数为估算值
  latency_ms        INTEGER NOT NULL DEFAULT 0,
  status_code       INTEGER NOT NULL DEFAULT 200,
  stream            INTEGER NOT NULL DEFAULT 0,
  error             TEXT,
  ip                TEXT,
  ua                TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_logs_ts ON usage_logs(ts);
CREATE INDEX IF NOT EXISTS idx_usage_logs_user_ts ON usage_logs(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_usage_logs_key_ts ON usage_logs(key_id, ts);
CREATE INDEX IF NOT EXISTS idx_usage_logs_model_ts ON usage_logs(model, ts);
CREATE INDEX IF NOT EXISTS idx_usage_logs_channel_ts ON usage_logs(channel_id, ts);

-- ---------------------------------------------------------------- 用量日汇总
-- 只保存已完整结束的 UTC 日期（< 今天），当天数据仍从 usage_logs 读取
CREATE TABLE IF NOT EXISTS usage_daily (
  day               TEXT NOT NULL,             -- YYYY-MM-DD (UTC)
  user_id           INTEGER NOT NULL DEFAULT 0,
  key_id            INTEGER NOT NULL DEFAULT 0,
  channel_id        INTEGER NOT NULL DEFAULT 0,
  model             TEXT NOT NULL DEFAULT '',
  requests          INTEGER NOT NULL DEFAULT 0,
  errors            INTEGER NOT NULL DEFAULT 0,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id, key_id, channel_id, model)
);
CREATE INDEX IF NOT EXISTS idx_usage_daily_user ON usage_daily(user_id, day);

-- ---------------------------------------------------------------- 管理会话
CREATE TABLE IF NOT EXISTS admin_sessions (
  id           TEXT PRIMARY KEY,               -- sha256(会话 token)
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ip           TEXT,
  ua           TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_exp ON admin_sessions(expires_at);

-- ---------------------------------------------------------------- 登录失败计数
CREATE TABLE IF NOT EXISTS login_attempts (
  ip     TEXT NOT NULL,
  window INTEGER NOT NULL,
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, window)
);
