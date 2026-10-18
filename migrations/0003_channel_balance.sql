-- 上游渠道的余额快照
--
-- 背景：一个网关往往挂着多个上游账号，某个账号欠费后请求会全部失败，而
-- 「渠道测试」只验证地址与密钥格式，看不出余额。这里保存最近一次查询结果，
-- 由管理界面手动刷新，或由定时任务按「最久未查」轮转刷新（每次有上限，
-- 避免把单次调用的子请求预算用光）。
--
-- 查询失败不是渠道故障：只把原因写进 balance_error，不影响路由与熔断。

-- 余额数值（保留上游的原始币种/单位，不做汇率换算）
ALTER TABLE channels ADD COLUMN balance_amount REAL;
-- 币种或单位：USD / CNY / credits / tokens 等，由上游返回
ALTER TABLE channels ADD COLUMN balance_currency TEXT;
-- 最近一次查询时间（0/NULL 表示从未查询）
ALTER TABLE channels ADD COLUMN balance_checked_at INTEGER;
-- 最近一次查询失败或无法识别余额时的原因
ALTER TABLE channels ADD COLUMN balance_error TEXT;
