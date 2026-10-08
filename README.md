# Token Free · AI 免费额度每日汇总

> 每天 10:00（北京时间）自动抓取、校验并汇总国内外 AI 模型厂商的**免费额度 / 免费试用 / 学生优惠 / 折扣促销**，去重归档后以本地服务或静态站两种方式对外展示。

[![Node](https://img.shields.io/badge/node-%3E%3D22.5-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![SQLite](https://img.shields.io/badge/storage-node%3Asqlite-003B57?logo=sqlite&logoColor=white)](https://nodejs.org/api/sqlite.html)
[![Zero Build](https://img.shields.io/badge/frontend-zero--build-4B5563)]()
[![Deploy](https://img.shields.io/badge/deploy-GitHub%20Pages-222?logo=github)]()

---

## 这是什么

一个自动化的 AI 免费活动聚合站。它按你配置的厂商清单抓取官方定价页 / 公告 / 文档，抽取出「哪家在送、送多少、谁能领、什么时候截止」，经过去重、可信度校验和人工待审队列后落库，再导出为纯静态 JSON 供站点读取。

**它解决的问题**：厂商免费活动散落在定价页、博客、文档里，更新频繁、口径不一，靠人肉跟踪容易漏、容易过期。本项目把它变成一条每日自动运行的流水线。

同一份前端代码支持两种部署：

- **本地服务模式**：`node src/server.js`，带 REST API、实时搜索、抓取日志、人工审核、Web Push 订阅。
- **静态站模式**：零构建导出 `public/data/*.json`，部署到 GitHub Pages，前端在浏览器内完成筛选。

前端通过 `public/js/api.js` 自动探测后端是否存在并切换数据源，两种模式下 API 一致：

```js
// 有 /api → 走 REST；无 /api → 读 data/*.json（带 content-type 校验防止静态托管返回 404 HTML）
const res  = await fetch('/api/stats', { cache: 'no-store' });
const mode = res.ok && (res.headers.get('content-type') || '').includes('application/json')
  ? 'api' : 'static';
```

---

## 功能特性

### 1. 厂商覆盖（可声明式扩充）
内置国内（智谱、DeepSeek、通义千问、豆包、Kimi、MiniMax、文心、混元）与海外（OpenAI、Anthropic、Google、xAI）12 家厂商。新增厂商只需在 `config/providers.yaml` 追加约 10 行，执行一次 `npm run migrate` 即生效，**无需改代码**。

### 2. 每日 10:00 自动抓取
- 本地服务内置 cron：`0 10 * * *`（`Asia/Shanghai`，见 `config/settings.json`）。
- CI 模式：`.github/workflows/daily-crawl.yml` 每天 UTC 02:00（= 北京 10:00）运行。
- 也可手动触发：API `POST /api/crawl` 或 `node src/jobs/daily-crawl.js --provider=zhipu`。

### 3. 字段完整
每条活动包含：厂商（slug / 名 / 国家 / 品牌色 / 国内可直连）、标题、摘要、类别、**额度（结构化 amount + unit + 展示文案）**、适用人群、是否需要绑卡 / 实名、起止日期、是否周期刷新、领取链接、来源链接与原文摘录、可信度、审核状态、状态与剩余天数。

`cn_accessible`（国内是否可直连）是差异化字段，多数同类站点缺失。

### 4. 去重与归档
- 指纹去重：`src/lib/fingerprint.js` 生成稳定指纹，同一条活动跨源、跨天只留一条。
- 页内去重：`normalize.js` 的 `dedupeWithinBatch` 消除同批重复。
- 变更追踪：内容变化写入 `change_history`，不是覆盖而是留痕。
- 自动归档：`archiveExpired` 将过期 / 被拒活动按 `archive.afterDays`（默认 30 天）归档，不进主列表。

### 5. 状态标签
- 生命周期：`进行中 / 即将开始 / 已结束`
- 新增标记：当天新收录显示 `NEW`
- 紧迫度：`endingSoon`（临近截止）与 `daysLeft` 剩余天数
- 人群标签：所有人 / 新用户 / 学生 / 教师 / 开源项目 / 初创团队 / 企业 / 需实名绑卡

### 6. 筛选与搜索
按厂商、类别、状态、地区（国内 / 海外）、适用人群、是否需绑卡、是否临近截止、是否新收录筛选；支持多选与组合。搜索走 SQLite **FTS + LIKE 双路**（`src/lib/search.js`）；静态站降级为浏览器内关键词匹配。排序支持：即将结束优先 / 最新收录 / 可信度优先 / 按厂商。

### 7. 订阅通知
- **RSS**：`/feed.xml`（动态）或 `data/feed.xml`（静态），任何阅读器可订阅。
- **Web Push**：基于 `web-push` + VAPID，`POST /api/subscribe` 保存订阅，有新活动时推送；`npm run vapid` 生成密钥（仅本地服务模式）。

### 8. 抓取日志与可追溯
每次运行写 `fetch_runs`（整体结果）、每个源的每次重试写 `fetch_attempts`（HTTP 状态、耗时、字节数、错误）、页面原文快照写 `raw_snapshots`（内容哈希 + 本地 HTML 路径，锁定在 `logs/html/`）。满足审计需求：任意一条活动都能回溯到**哪次运行、哪个 URL、当时页面长什么样**。前端「抓取日志」页展示这些数据（仅本地服务模式）。

---

## 快速开始

要求 **Node.js ≥ 22.5**（用到内置 `node:sqlite`，无需编译原生模块）。

```bash
npm install        # 或 npm ci
npm run migrate    # 建库 + 同步 config/providers.yaml 的厂商与数据源
npm run crawl      # 抓取一轮（首次会稍慢，逐源限速）
npm run start      # 启动本地服务，默认 http://localhost:8787
```

打开 `http://localhost:8787` 即可。常用命令：

```bash
npm run migrate       # 建表 / 同步厂商配置；--reset 清空重建（仅开发）
npm run crawl         # 每日抓取（含归档、推送、生成 feed）
npm run crawl -- --provider=deepseek   # 只抓某家
npm run archive       # 单独执行归档
npm run build         # 导出静态数据到 public/data/
npm run daily         # crawl + archive + build（CI 用一条龙）
npm run serve         # 等同 start
npm run vapid         # 生成 VAPID 密钥（Web Push 用）
PORT=9000 npm run start
DEPLOY=1 PORT=8080 npm run start       # 绑定 0.0.0.0，用于云端托管
CRON=0 npm run start                    # 关闭内置定时（改用系统计划任务时）
```

---

## 架构说明

### 数据流

```
discover → fetch → extract → normalize → validate → persist → notify → export
   发现      抓取      抽取       规范化      校验       落库       通知      导出
```

| 阶段 | 模块 | 做什么 |
| --- | --- | --- |
| discover | `src/pipeline/discover.js` | 按 source 的 `selector` 限定范围，切块并发现候选条目 |
| fetch | `src/pipeline/fetch.js` | 带重试、退避、限速、robots 的抓取，存 HTML 快照与文本快照，计算内容哈希 |
| extract | `src/pipeline/extract.js`、`llm-extract.js` | 规则优先抽取；配置了 LLM 时做增强，LLM 失败自动降级为规则结果 |
| normalize | `src/pipeline/normalize.js` | 字段归一化（日期、额度、人群），生成指纹，页内去重 |
| validate | `src/pipeline/validate.js` | 域名白名单、标题质量、置信度分级 → `auto_ok` / `pending` |
| persist | `src/pipeline/persist.js` | 按指纹 upsert，记录 `change_history`，归档过期项，维护人工审核 |
| notify | `src/notify/push.js`、`feed.js` | Web Push 通知；生成 RSS 与 JSON feed |
| export | `src/export/build-static.js` → `notify/feed.js` | 导出 `public/data/*.json` 与 `feed.xml` |

编排入口：`src/pipeline/index.js` 的 `runPipeline()`。每个源独立失败隔离；连续失败累加计数，达阈值告警。

### 目录结构

```
Token Free/
├── config/
│   ├── providers.yaml        # 厂商与数据源清单（声明式，扩充入口）
│   ├── settings.json         # 时区 / cron / 抓取 / 审核 / 导出设置
│   └── .vapid.json           # Web Push 密钥（gitignore，不入库）
├── src/
│   ├── db/                   # db.js 访问层 · migrate.js 迁移 · schema.sql 表结构
│   ├── pipeline/             # 抓取流水线各阶段
│   ├── jobs/                 # daily-crawl.js 每日任务 · archive.js 归档
│   ├── notify/               # feed.js 导出 · push.js 推送
│   ├── lib/                  # config / fingerprint / logger / retry / search
│   ├── export/               # build-static.js 静态导出
│   └── server.js             # 本地 HTTP 服务 + REST API + 内置 cron
├── public/                   # 零构建前端（也是 Pages 部署产物）
│   ├── index.html
│   ├── css/ js/              # app.js · api.js · components.js · sw.js
│   └── data/                 # 导出的静态数据（activities/providers/stats/filters/meta/feed.xml）
├── scripts/publish-pages.sh  # 部署 public/ 到 gh-pages
├── data/                     # SQLite 数据库（gitignore）
├── logs/                     # 抓取日志与原始 HTML 快照（gitignore）
└── .github/workflows/        # deploy.yml · daily-crawl.yml
```

### 数据表（`src/db/schema.sql`）

`providers`、`sources`、`fetch_runs`、`fetch_attempts`、`raw_snapshots`、`activities`、`activities_fts`、`change_history`、`subscriptions`、`push_log`。对外查询统一走视图 `v_activities`（已做状态 / 剩余天数 / 临近截止等派生计算）。

---

## 如何新增厂商

只需编辑 `config/providers.yaml`，然后 `npm run migrate`。

```yaml
  - slug: mistral                # 唯一英文标识，用于指纹与 URL（必填）
    name_zh: Mistral AI          # 中文名（必填）
    name_en: Mistral AI
    country: FR
    website: https://mistral.ai
    pricing_url: https://mistral.ai/pricing
    announcement_url: https://mistral.ai/news
    brand_color: "#FA520F"
    cn_accessible: false         # 国内能否直连（差异化字段）
    tier: 2                      # 1=核心（优先抓取） 2=次要
    sources:
      - kind: pricing            # pricing | announcement | docs | search | social
        url: https://mistral.ai/pricing
        selector: main           # CSS 选择器，限定提取正文范围（可选）
      - kind: announcement
        url: https://mistral.ai/news
      - kind: search             # 无固定页面时用搜索兜底发现
        query: Mistral free credits student offer
        # enabled: false         # 临时停用某个源
```

要点：

- `slug` 唯一且**不要改**（已入库的活动指纹依赖它）。
- 从 yaml 删除某个 source 后重新 migrate，该源会被自动**停用**而非删除，避免继续抓取废弃地址。
- 加完先单独验证：`node src/jobs/daily-crawl.js --provider=mistral`，确认能抽取到条目再全量跑。

---

## 部署说明

同源码两种模式，区别如下：

| | 本地服务模式 | 静态站模式（GitHub Pages） |
| --- | --- | --- |
| 启动 | `npm run start` | 部署 `public/` 到 Pages |
| 数据 | SQLite 实时查询 | `public/data/*.json` 快照 |
| 搜索 / 筛选 | 服务端 FTS | 浏览器内筛选 |
| 抓取日志 / 人工审核 | ✅ | ❌（静态站无写能力，日志页隐藏） |
| Web Push 订阅 | ✅ | ❌（无后端） |
| RSS | `/feed.xml` | `data/feed.xml` |
| 更新时机 | 每次请求实时 | 每日 CI 构建后 |

### 方式一：GitHub Pages（纯静态，推荐公开演示）

两种部署路径，**二选一**：

1. **GitHub Actions（推荐，见 `.github/workflows/deploy.yml`）**
   把仓库 Pages 源设为 **GitHub Actions**。push 到 `main` 即自动把 `public/` 上线。本项目零构建，直接上传目录即可。

2. **脚本推送 `gh-pages` 分支（见 `scripts/publish-pages.sh`）**
   把 Pages 源设为 **Deploy from a branch → `gh-pages` / (root)**。本地执行：

   ```bash
   bash scripts/publish-pages.sh
   # 或指定仓库
   REPO=https://github.com/<user>/<repo>.git bash scripts/publish-pages.sh
   ```

   脚本先 `npm run build` 导出最新数据，再用**临时 git worktree** 把 `public/` 内容推到 `gh-pages`，分支不存在会自动创建孤立分支，主分支零污染，完成后打印站点 URL。

> 首次部署后到 **Settings → Pages** 确认来源设置与上表一致。

### 方式二：本地 / 自托管服务

```bash
npm ci && npm run migrate && npm run crawl && npm run start
# 云端：DEPLOY=1 PORT=8080 npm run start
```

服务自身可托管 `public/` 并暴露 `/api/*`，适合需要审核后台与推送的场景。

### CI 定时抓取（`.github/workflows/daily-crawl.yml`）

> **当前状态（2026-10-08）**：定时触发已停用，改为 `workflow_dispatch` 手动补跑。
> 日常抓取由部署在服务器上的实例负责（服务器有持久化 `data/`，可复用「页面未变化则跳过」）。

每天 UTC 02:00（北京 10:00）在 runner 上 `migrate → crawl → build`，把 `public/data/` 变更提交回 `main`，并触发 Pages 重新部署。

> ⚠️ **机器人提交不会自动触发 Pages 部署**（2026-10-08 踩坑）
>
> GitHub 规定：用仓库内置 `GITHUB_TOKEN` 推送的提交**不会触发其他 workflow**（防递归设计）。
> 所以 `git-auto-commit-action` 把数据推进 `main` 后，`deploy.yml` **不会**因 `public/**` 变更而醒来，
> Pages 上的数据会一直停在最后一次**人工 push**。
>
> 症状：仓库里数据天天更新，线上纹丝不动。
>
> 解法：在提交后**显式** `gh workflow run deploy.yml --ref main`
> （`workflow_dispatch` 是 `GITHUB_TOKEN` 允许触发的例外），并给 workflow 加 `permissions.actions: write`。
> `daily-crawl.yml` 与 `relays.yml` 均已按此修复。

> **关于数据库**：`data/*.db` 被 gitignore，CI 每次都是**全新空库**从零抓取——因为 SQLite 只是「当日快照的暂存区」，权威产物是导出的 JSON，重建完全无损。
>
> **若要保留历史数据**（如变更轨迹、订阅者）：把数据库持久化到外部，例如
> - 用 artifact 在 workflow 间传递 `data/tokenfree.db`；
> - 或改用对象存储 / 分支（如 `data` 分支）挂载；
> - 或在 `crawl` 前从远端拉取上次的 db 文件再运行。
> 若无需历史，保持现状即可。

---

## 数据可信度说明

免费活动信息一旦过期或错误，比没有更糟。为此做了三层防护：

1. **抓取层——只认权威来源**
   每个厂商在 yaml 中显式声明定价页 / 公告页 / 文档页地址；`selector` 把提取范围限定在正文区域，避免导航、页脚噪音。链接经**域名白名单**校验（`buildAllowedHosts`），拒绝站外跳转。抓取遵守 robots、逐域限速、失败重试与退避。

2. **校验层——置信度分级**
   `validate.js` 对每条候选打分（来源权威性、字段完整度、标题质量、日期合理性等）：
   - 高置信 → `auto_ok`，自动上架；
   - 低置信 → `pending`，进入待审队列，**不对外展示**；
   - 命中黑名单 / 标题异常的候选直接丢弃。

   阈值在 `config/settings.json` 的 `review.autoApproveConfidence` / `pendingConfidence` 可调。

3. **人工层——待审队列与留痕**
   `GET /api/review-queue` 列出待审项，`POST /api/review/:id` 可批准 / 拒绝 / 修正并写备注，操作记入 `change_history`。所有对外数据均可在 `raw_snapshots` 中回溯到当时的原始页面快照。

**仍需注意**：自动化不等于权威。厂商可能随时调整活动规则，页面改版也可能导致抽取偏差。请以**厂商官方页面**为最终依据，本站数据仅供参考。

---

## 免责声明

- 本项目仅抓取**公开页面**，不绕过登录、不破解接口、不采集个人隐私数据。
- 所有活动信息的**最终解释权归各厂商所有**；额度、资格、期限均可能随时变更。请以厂商官方页面为准。
- 本站不提供、不转售、不代领任何额度，与所列厂商无隶属或合作关系。
- 商标、品牌名与 Logo 归各自所有者，本项目仅用于信息指代。
- 数据按「现状」提供，不对完整性、及时性、准确性作任何担保；因使用本站信息产生的后果由使用者自行承担。

---

## 许可

见仓库根目录 LICENSE（如未附带，请按你的发布意图补充）。
