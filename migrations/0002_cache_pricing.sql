-- 缓存命中计价与统计
--
-- 背景：DeepSeek、OpenAI 等对上文的「前缀缓存命中」部分按更低价格计费
-- （DeepSeek 命中价约为未命中的 1/10）。此前网关把所有输入 token 都按同一
-- 单价计算，命中率越高，越会高估成本、多扣下游额度。
--
-- cache_hit_price 采用可空语义：
--   NULL → 不区分缓存，命中部分也按 prompt_price 计（保持迁移前的行为）
--   0    → 命中部分完全免费（仅在上游确实不计费时使用）
--   其他 → 命中部分按该单价计（美元 / 100 万 token）

ALTER TABLE models ADD COLUMN cache_hit_price REAL;

-- 缓存命中的输入 token 数（prompt_tokens 的子集）
ALTER TABLE usage_logs ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_daily ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0;

-- 命中率是常用筛选维度，按模型聚合时用得较多
CREATE INDEX IF NOT EXISTS idx_usage_logs_model_ts_cached
  ON usage_logs(model, ts, cached_tokens);
