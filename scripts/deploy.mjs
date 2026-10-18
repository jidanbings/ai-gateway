/**
 * 部署脚本：npm run deploy（也是 Workers Builds / 连接 GitHub 部署时的「Deploy command」）。
 *
 * 为什么不能直接用 `npx wrangler deploy`：
 *   `wrangler deploy` 会按配置文件**整体覆盖** Worker 的绑定。仓库里的 wrangler.jsonc 不含
 *   D1 段（database_id 每个账号不同，不能写进仓库），直接部署会把 D1 绑定清掉。
 *
 * 所以部署统一走这里：
 *   1. 查账号里的 D1：有同名库就复用，没有就创建（库 ID 缓存进 .wrangler/d1.json，不进仓库）
 *   2. 以 wrangler.jsonc 为模板生成 .wrangler/deploy.jsonc，写入 D1 绑定
 *   3. 对远端库执行迁移（增量，可重复）
 *   4. `wrangler deploy --config .wrangler/deploy.jsonc`，并强制 __TEST_ENDPOINTS__:false
 *      —— 测试辅助端点不进正式产物
 */

import { DB_NAME, buildDeployConfig, listSecrets, readConfig, resolveD1, wrangler } from './lib/cf.mjs';

function fail(msg) {
  console.error(`\n${msg}\n`);
  process.exit(1);
}

function run(args, label) {
  console.log(`\n==> ${label}`);
  const result = wrangler(args);
  if (result.error) fail(`${label} 失败：${result.error.message}`);
  if (!result.ok) fail(`${label} 失败（wrangler 退出码 ${result.status}）`);
}

const config = (() => {
  try {
    return readConfig();
  } catch (err) {
    fail(`读取 wrangler.jsonc 失败：${err.message}`);
  }
})();
const workerName = config.name || 'ai-gateway';

console.log('=== [1/4] 部署目标 ===');
console.log(`  Worker : ${workerName}`);
console.log(`  D1     : ${DB_NAME}（自动查找，没有就创建）`);

console.log('\n=== [2/4] 准备 D1 数据库并生成部署配置 ===');
let dbId;
try {
  dbId = resolveD1({ log: (m) => console.log(m) });
} catch (e) {
  fail(e.message);
}

let deployConfigPath;
try {
  deployConfigPath = buildDeployConfig({ dbId });
} catch (e) {
  fail(e.message);
}
console.log(`  已生成 ${deployConfigPath}（含 D1 绑定，库 ID 不进仓库）`);

// 两个 Secret 由代码检查（src/lib/setup.ts 的说明页），不写进配置：
// wrangler 会把 secrets.required 当成部署门槛，Secret 没加就直接拒绝部署，
// 而 Secret 只能加到已存在的 Worker 上 —— 首次部署会死锁（与 qq-bot-cf 的取舍一致）。
const REQUIRED_SECRETS = ['ADMIN_TOKEN', 'ENCRYPTION_KEY'];

console.log('\n=== [3/4] 应用 D1 迁移 ===');
// 按 binding（DB）而不是库名引用：部署页允许改名，绑定名不变
run(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', deployConfigPath], '建表 / 升级表结构');

console.log('\n=== [4/4] 部署 Worker ===');
const deployArgs = [
  'deploy',
  '--config', deployConfigPath,
  '--define', '__TEST_ENDPOINTS__:false',
];
run(deployArgs, '部署 Worker');

// Worker 一定已经存在了，这时再查 Secret（查不到就是没配）
const afterSecrets = listSecrets({ capture: true }) ?? [];
const missingSecrets = REQUIRED_SECRETS.filter((name) => !afterSecrets.includes(name));
console.log(`
部署完成。数据库表结构已就绪，Worker 已上线。

`);

if (missingSecrets.length > 0) {
  console.log('还差一步：添加 ' + missingSecrets.length + ' 个 Secret（只需一次）');
  console.log(`  Cloudflare 控制台 → Workers & Pages → ${workerName}`);
  console.log('  → Settings → Variables and Secrets → Add，类型必须选 Secret：');
  console.log('     ADMIN_TOKEN      管理后台登录密码，16 位以上随机串');
  console.log('     ENCRYPTION_KEY   渠道密钥的加密主密钥，16 位以上随机串，添加后不要更换');
  console.log('');
  console.log(`  也可以用命令行：${missingSecrets.map((n) => `npx wrangler secret put ${n}`).join('、')}`);
  console.log('  生成随机串：node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'base64url\'))"');
  console.log('');
  console.log('  加完后打开 https://<你的 Worker 域名>/admin 用 ADMIN_TOKEN 登录；没有添加之前页面会提示缺哪几个。');
} else {
  console.log('两个 Secret 都已配置，直接打开 https://<你的 Worker 域名>/admin 用 ADMIN_TOKEN 登录即可。');
}

console.log(`
之后在「上游渠道 / 模型与定价 / 用户 / API 密钥」里完成业务配置，
这些都存在 D1 里，以后重新部署不会丢（Secret 也不会被 deploy 删除）。

以后更新代码：同步 fork 或 git pull，再跑一次 npm run deploy 即可；
D1 绑定由本脚本每次写入，不会因重新部署而丢失。
`);
