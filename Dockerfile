# Token Free 生产镜像
#
# 构建：docker build -t token-free .
# 运行：docker run -d --name token-free \
#         -p 8787:8787 \
#         -e ADMIN_TOKEN=your-secret \
#         -v token-free-data:/app/data \
#         -v token-free-logs:/app/logs \
#         --restart unless-stopped \
#         token-free
#
# ⚠️ 必须挂载卷：data/（SQLite 数据库）与 logs/。
#    不挂 data/ 的话每次重建容器都从空库开始，会丢掉「页面未变化则跳过」的
#    增量优化——每次都要全量重抽，白白消耗 LLM 配额。（这正是 GitHub Actions
#    方案的固有缺陷：CI 每次都是新库。）

FROM node:22-slim

# 仅装运行时依赖；本项目零原生编译（用 Node 内置 node:sqlite），不需要 build-essential
WORKDIR /app

# 先只复制依赖清单，充分利用 Docker 层缓存
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

# 数据目录：SQLite + 日志（会被卷覆盖，需在运行时挂载）
RUN mkdir -p /app/data /app/logs

ENV NODE_ENV=production \
    DEPLOY=1 \
    PORT=8787 \
    TZ=Asia/Shanghai

EXPOSE 8787

# 健康检查：用新增的 /api/health（会实际查库，能区分"进程活着"与"数据陈旧"）
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>{if(!r.ok)process.exit(1);return r.json()}).then(j=>{if(!j.ok||j.db!=='ok')process.exit(1)}).catch(()=>process.exit(1))"

# 直接跑 node（不用 npm start），保证 PID 1 收到 SIGTERM，
# 从而触发 server.js 的优雅关闭逻辑
CMD ["node", "src/server.js"]
