/**
 * 「尚未完成配置」说明页。
 *
 * 缺 Secret 时不报错、也不让部署失败：所有页面请求都换成这一页，明确告诉部署者
 * 缺哪几个、去哪儿加、怎么加。API 请求则返回 503 JSON（客户端能解析，不会看到一坨 HTML）。
 *
 * 设计参考 qq-bot-cf 的 setupPage：静态 HTML、零外部依赖、不依赖任何数据，
 * 所以在数据库还没建表时也能正常显示。
 */

import { REQUIRED_SECRETS, type SecretsStatus } from './bootstrap.js';

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 随机串生成命令（Windows / macOS / Linux 通用：用 node） */
const GEN_CMD = `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`;

export function apiErrorPayload(status: SecretsStatus) {
  if (status.state === 'no-db') {
    return {
      status: 503,
      body: {
        error: {
          message:
            '数据库尚未初始化：请先执行 `wrangler d1 migrations apply DB --remote`，然后重新部署或刷新本页。',
          type: 'api_error',
          param: null,
          code: 'not_migrated',
        },
      },
    };
  }
  return {
    status: 503,
    body: {
      error: {
        message: `站点尚未完成配置：缺少 ${status.missing.join('、')}。请在 Cloudflare 控制台该 Worker 的 Settings → Variables and Secrets 添加（类型选 Secret）。`,
        type: 'api_error',
        param: null,
        code: 'secret_missing',
      },
    },
  };
}

export function renderSetupPage(status: SecretsStatus, siteName: string): string {
  const isMissing = (key: string) => status.missing.includes(key as never);

  const items = REQUIRED_SECRETS.map((req) => {
    const missing = isMissing(req.key);
    return `
      <div class="req ${missing ? 'missing' : 'ok'}">
        <span class="state">${missing ? '!' : '✓'}</span>
        <div class="body">
          <code>${req.key}</code>
          <p class="why">${req.why}</p>
          <p class="how"><b>${missing ? '待配置：' : '已配置：'}</b>${req.how}</p>
        </div>
      </div>`;
  }).join('');

  const pending = status.missing.length;
  const dbBlocked = status.state === 'no-db';

  const title = dbBlocked ? '数据库尚未初始化' : '尚未完成配置';
  const heading = dbBlocked ? '还差一步：建表' : `还差 ${pending} 项配置`;
  const sub = dbBlocked
    ? 'Worker 已成功部署，但数据库里还没有表。执行下面的命令后刷新本页即可。'
    : 'Worker 已成功部署，数据库也已就绪，只差下面这几个密钥。补齐后刷新本页即可。';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(siteName)} · ${title}</title>
<meta name="robots" content="noindex,nofollow">
<style>
  :root { color-scheme: light dark; --fg:#0f172a; --muted:#64748b; --bg:#f8fafc; --card:#fff;
          --border:#e2e8f0; --accent:#4f46e5; --err:#dc2626; --ok:#15803d; --tint:#eef2ff; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e7ecf5; --muted:#98a3b8; --bg:#0b0e14; --card:#141922; --border:#242e3c;
            --accent:#818cf8; --err:#f87171; --ok:#4ade80; --tint:rgba(129,140,248,.14); }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:40px 20px; background:var(--bg); color:var(--fg);
         font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; }
  .wrap { max-width:720px; margin:0 auto; }
  .badge { display:inline-flex; align-items:center; gap:6px; padding:4px 12px; border-radius:999px;
           background:${dbBlocked ? 'rgba(220,38,38,.1)' : 'rgba(180,83,9,.12)'};
           color:${dbBlocked ? 'var(--err)' : '#b45309'}; font-size:13px; font-weight:600; }
  h1 { font-size:26px; margin:14px 0 8px; }
  .sub { color:var(--muted); margin:0 0 24px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:20px 22px; margin-bottom:18px; }
  .card h2 { font-size:16px; margin:0 0 12px; }
  .req { display:flex; gap:12px; padding:12px 0; border-top:1px solid var(--border); }
  .req:first-of-type { border-top:none; }
  .state { flex:none; width:24px; height:24px; border-radius:50%; display:grid; place-items:center;
           font-weight:700; font-size:13px; }
  .req.missing .state { background:rgba(220,38,38,.12); color:var(--err); }
  .req.ok .state { background:rgba(22,163,74,.12); color:var(--ok); }
  .body code { background:var(--tint); color:var(--accent); padding:1px 6px; border-radius:6px; font-size:13px; }
  .why { margin:6px 0 2px; color:var(--muted); }
  .how { margin:0; font-size:14px; }
  ol { margin:0; padding-left:20px; }
  ol li { margin-bottom:8px; }
  pre { background:var(--tint); padding:10px 12px; border-radius:8px; overflow-x:auto; font-size:13px; }
  .note { color:var(--muted); font-size:13px; margin:7px 0 0; }
</style>
</head>
<body>
<div class="wrap">
  <span class="badge">● ${escapeHtml(title)}</span>
  <h1>${escapeHtml(heading)}</h1>
  <p class="sub">${escapeHtml(sub)}</p>

  ${
    dbBlocked
      ? `<div class="card">
    <h2>建表</h2>
    <p>在项目目录执行：</p>
    <pre>npx wrangler d1 migrations apply DB --remote</pre>
    <p class="note">或者直接重新部署一次（<code>npm run deploy</code> 会自动跑迁移）。</p>
  </div>`
      : `<div class="card">
    <h2>密钥检查</h2>
    ${items}
  </div>

  <div class="card">
    <h2>怎么补（都在 Cloudflare 控制台操作）</h2>
    <ol>
      <li>打开 <code>dash.cloudflare.com</code> → <code>Workers &amp; Pages</code> → 点进这个 Worker</li>
      <li><code>Settings</code> → <code>Variables and Secrets</code> → <code>Add</code>，
          类型<b>必须选 <code>Secret</code></b>（加密变量），不要选 Plaintext / Text</li>
      <li>分别添加 <code>ADMIN_TOKEN</code> 与 <code>ENCRYPTION_KEY</code>，各填一个 16 位以上随机串</li>
      <li>保存后刷新本页，即可用 <code>ADMIN_TOKEN</code> 登录 <a href="/admin">/admin</a></li>
    </ol>
    <p class="note">生成随机串：</p>
    <pre>${escapeHtml(GEN_CMD)}</pre>
    <p class="note">密钥只存在 Cloudflare 上，不经过仓库、不经过本地文件。
      也可以用命令行添加：<code>npx wrangler secret put ADMIN_TOKEN</code>。
      ENCRYPTION_KEY 一旦确定就不要更换，否则已保存的渠道密钥会解不开。</p>
  </div>`
  }
</div>
</body>
</html>`;
}
