-- admin_sessions 增加 token_hash 列：登录时记录当时 ADMIN_TOKEN 的 SHA-256 指纹。
--
-- 用途：让「更换 ADMIN_TOKEN」能立即作废所有旧会话。Worker 无法感知 Secret 何时被改，
-- 但可以在每次 requireAdmin 时比对「会话里存的指纹」与「当前 ADMIN_TOKEN 的指纹」——
-- 不一致说明令牌已换，旧会话全部失效、要求重新登录。
--
-- 用 ADD COLUMN 而非重建表：不动既有行。旧会话该列是 NULL，在迁移落地后仍按「无指纹」处理
-- （见 adminAuth.ts：token_hash 为空时不做比对，兼容尚未重新登录的存量会话）。

ALTER TABLE admin_sessions ADD COLUMN token_hash TEXT;
