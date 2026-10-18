-- usage_logs 增加 meta 列，支撑「无损合并」。
--
-- 合并会把多行明细折成一行汇总，届时「一行 = 一次请求」不再成立。meta 为 NULL 表示普通明细，
-- 非空表示汇总行，形如 {"merged":true,"requests":37,"errors":2}，聚合查询据此还原条数
-- （见 src/routes/admin.ts 的 REQ_COUNT / ERR_COUNT）。
--
-- 用 ADD COLUMN 而非重建表：不动既有行、不拷数据，也不会碰到 0010 刚重建的索引。
-- 已知取舍：「只看错误」的过滤要带上 json_extract(meta,'$.errors') > 0 才不会漏掉汇总行，
-- 这会让 idx_usage_logs_errors 在那个查询下失效；表只有几百行，可以接受。

ALTER TABLE usage_logs ADD COLUMN meta TEXT;
