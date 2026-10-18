-- 错误行的部分索引
--
-- 背景：总览页的「仅看错误」筛选和请求明细的错误筛选，条件都是
--   status_code >= 400 OR error IS NOT NULL
-- 这个 OR 跨两列，任何普通的 (ts) 索引都帮不上忙 —— 实测执行计划是
--   SCAN usage_logs USING INDEX idx_usage_logs_ts
-- 也就是沿 ts 倒序逐行回表判断。成功请求占绝大多数时，为了凑够一屏的
-- 错误记录要扫过成百上千行；区间拉长到 90 天更明显。
--
-- 部分索引只收录满足该条件的行，体积约等于日志总量乘以错误率。
-- 查询条件与索引的 WHERE 完全一致，SQLite 可以直接定位，无需再过滤。
-- 注意：条件必须与查询里的写法逐字对应，否则优化器认不出来。
CREATE INDEX IF NOT EXISTS idx_usage_logs_errors
  ON usage_logs(ts) WHERE status_code >= 400 OR error IS NOT NULL;
