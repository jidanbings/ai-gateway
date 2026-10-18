-- 允许渠道使用明文 http 连接公网地址
--
-- 默认仍然强制远端 https：上游 API Key 与全部转发内容都要经过公网，明文传输
-- 会被任意中间节点读到。但自建上游未必能拿到证书 —— 域名未备案时通常只能通过
-- 公网 IP 访问，而 CA 不给裸 IP 签发证书。这里给出一个显式开关：只有在该渠道
-- 勾选了「允许明文 HTTP」之后，才放行指向公网地址的 http。
--
-- 回环与私有网段（localhost、10.x、192.168.x、172.16-31.x）不受此限制，
-- 它们本来就直接放行 http。

ALTER TABLE channels ADD COLUMN allow_insecure_http INTEGER NOT NULL DEFAULT 0;
