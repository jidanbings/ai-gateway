/**
 * 时间常量。
 *
 * 这个模块原先是一个完整的维护任务（runMaintenance）：定时汇总用量、按保留期清理
 * 明细、回收会话、轮转刷新余额，由 wrangler.toml 的 cron trigger 驱动。现在整个
 * 定时任务连同 RETENTION_DAYS 配置一起移除了：
 *   * 用量明细清理   → 管理页「数据维护」手动触发（admin.ts 的 POST /maintenance/prune）
 *   * 会话与登录失败回收 → 每次登录时顺带执行（admin.ts 的 pruneSessions / pruneLoginAttempts）
 *   * 渠道余额刷新   → 渠道页「刷新余额」按钮
 * 每个职责都有对应的手动入口，所以不再保留一个没有调度者的函数，只剩这里的常量。
 */

export const DAY_MS = 24 * 3600_000;
