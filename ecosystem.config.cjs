/**
 * PM2 部署配置
 *
 * 用法：
 *   npm i -g pm2
 *   ADMIN_TOKEN=xxx pm2 start ecosystem.config.cjs
 *   pm2 save && pm2 startup      # 开机自启
 *   pm2 logs token-free
 *
 * ⚠️ 关键：instances 必须为 1。
 *    本项目内置 node-cron 定时抓取，多副本会导致每个副本各抓一次——
 *    互相触发反爬、重复消耗 LLM 配额、并争抢 SQLite 写锁。
 *    若要多副本，必须设 CRON=0 把调度外置（系统 cron / K8s CronJob），
 *    只让一个调度器去调 POST /api/crawl。
 */

const isDeploy = process.env.DEPLOY === '1';

module.exports = {
  apps: [
    {
      name: 'token-free',
      script: './src/server.js',
      cwd: __dirname,

      // 单实例是硬性要求，见文件头说明
      instances: 1,
      exec_mode: 'fork',

      env: {
        NODE_ENV: 'production',
        DEPLOY: '1',
        PORT: 8787,
        // ADMIN_TOKEN 不写死在这里——从真实环境变量继承更安全
        // （PM2 会继承启动时的环境；也可以放 env_production 里）
      },

      // 崩溃自启
      autorestart: true,
      // 1 分钟内重启超过 15 次则判定为启动失败，不再徒劳重试
      max_restarts: 15,
      min_uptime: '60s',
      // 重启间隔，避免瞬崩瞬启打满 CPU
      restart_delay: 5000,

      // 内存超限自动重启（本项目数据量下 512M 绰绰有余）
      max_memory_restart: '512M',

      // 日志
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      // 不加时间戳前缀（应用日志自带时间戳）
      time: false,
      merge_logs: true,

      // 给进程 15s 优雅关闭（与 server.js 里 10s 兜底配套）
      kill_timeout: 15000,
      // 用 SIGINT 让 Node 走 gracefulShutdown；PM2 默认 SIGINT 更友好
      kill_retry_time: 2000,

      watch: false,
    },
  ],
};
