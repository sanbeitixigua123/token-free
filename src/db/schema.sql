-- ============================================================
--  Token Free — SQLite Schema
--  设计原则：
--    1) 状态用视图实时派生，不落库（避免定时任务失效导致状态僵化）
--    2) 去重靠指纹 fingerprint
--    3) 软归档而非删除（archived_at 非空即已归档，数据可追溯）
--    4) 所有"今天"判断用 date('now','+8 hours') —— 北京时间，无夏令时
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------- 厂商 ----------------
CREATE TABLE IF NOT EXISTS providers (
  id               INTEGER PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE,
  name_zh          TEXT NOT NULL,
  name_en          TEXT,
  country          TEXT NOT NULL DEFAULT 'CN',
  website          TEXT,
  pricing_url      TEXT,
  announcement_url TEXT,
  logo_url         TEXT,
  brand_color      TEXT,
  cn_accessible    INTEGER NOT NULL DEFAULT 1,
  tier             INTEGER NOT NULL DEFAULT 2,
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prov_active ON providers(active, tier);

-- ---------------- 模型（"给的是什么"） ----------------
--
-- 为什么要有独立的模型实体？
--   引入前的结构是「活动 → 厂商」两层，一条活动只能表达"某厂商在送东西",
--   却表达不了"送的是哪个模型"，前端也就无法按模型或能力分类浏览。
--   对标 freeaiapi.org（177 个模型 / 157 个端点）后确认，独立的模型层是其能
--   收录得多、且能被按能力检索的根本原因。
--
-- 能力分类 capability 采用 freeaiapi 的命名（与业界惯例一致，便于互通）：
--   text-generation / code-generation / image-generation / image-understanding
--   speech-to-text / text-to-speech / text-embeddings / video-generation / translation
CREATE TABLE IF NOT EXISTS models (
  id               INTEGER PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE,     -- 全局唯一模型标识，如 gemini-3-8-flash
  vendor_slug      TEXT,                     -- 模型开发方（可能是厂商外的第三方，如 Meta）
  name             TEXT NOT NULL,            -- 展示名，如 "Gemini 3.8 Flash"
  capability       TEXT NOT NULL DEFAULT 'text-generation',
  -- 同一模型可能具备多种能力（如既支持文本又支持视觉），用 JSON 数组存全部
  capabilities     TEXT NOT NULL DEFAULT '[]',
  context_window   INTEGER,                  -- 上下文窗口（token 数）
  max_output       INTEGER,                  -- 最大输出长度
  is_multimodal    INTEGER NOT NULL DEFAULT 0,
  is_open_weights  INTEGER NOT NULL DEFAULT 0,
  description      TEXT,
  homepage_url     TEXT,
  released_at      TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_model_cap ON models(capability);

-- ---------------- 端点（"在哪儿领、能领多少"）★ 最小可领取单元 ----------------
--
-- 这是三层结构里最关键的一层，也是此前完全缺失的一层。
-- 语义：某**提供方**在某个**模型**上给出的免费额度。
--   例：Google AI Studio × Gemini 3.8 Flash = 15 RPM / 1500 RPD / 1M 上下文 / 免绑卡
--
-- 与 activities 的区别（易混，务必分清）：
--   endpoint   —— 长期稳定的"免费额度政策"（Google AI Studio 一直给 1500 RPD）
--   activity   —— 有时效的"限时活动"（ZCode 周末送 1 亿，9/7 截止）
-- 二者是"常态"与"限时"的关系。一条 activity 可以指向某个 endpoint（即"这次活动
-- 给的是这个端点的额度"），也可以不指向（纯活动发放，不对应长期端点）。
CREATE TABLE IF NOT EXISTS endpoints (
  id                INTEGER PRIMARY KEY,
  provider_id       INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id          INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  slug              TEXT NOT NULL UNIQUE,    -- 形如 google-ai-studio--gemini-3-8-flash
  -- 免费配额：用结构化字段而非自然语言，才能做"按额度排序/筛选"
  quota_kind        TEXT,                    -- rate_limit / credits / free_tier / unlimited
  quota_rpm         INTEGER,                 -- 每分钟请求数
  quota_rpd         INTEGER,                 -- 每日请求数
  quota_tpm         INTEGER,                 -- 每分钟 token 数
  quota_amount      REAL,                    -- 额度数值（当 quota_kind=credits 时）
  quota_unit        TEXT,                    -- token / CNY / USD / request
  quota_text        TEXT,                    -- 原文表述（结构化解析不了时保底展示）
  requires_card     INTEGER NOT NULL DEFAULT 0,
  requires_signup   INTEGER NOT NULL DEFAULT 1,
  requires_phone    INTEGER NOT NULL DEFAULT 0,
  cn_accessible     INTEGER NOT NULL DEFAULT 1,
  api_base_url      TEXT,                    -- OpenAI 兼容端点，便于用户直接接入
  openai_compatible INTEGER NOT NULL DEFAULT 1,
  docs_url          TEXT,
  claim_url         TEXT,                    -- 领取/注册入口
  score             REAL,                    -- 评分（可为空）
  score_source      TEXT,                    -- 评分来源，避免"来源不明的数字"
  verified_at       TEXT,                    -- 最近一次人工核实时间
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  -- 同一厂商下同一模型只能有一个端点（避免重复条目）
  UNIQUE(provider_id, model_id)
);
CREATE INDEX IF NOT EXISTS idx_ep_provider ON endpoints(provider_id, enabled);
CREATE INDEX IF NOT EXISTS idx_ep_model    ON endpoints(model_id, enabled);
CREATE INDEX IF NOT EXISTS idx_ep_free     ON endpoints(requires_card, cn_accessible);

-- ---------------- 数据源 ----------------
CREATE TABLE IF NOT EXISTS sources (
  id                   INTEGER PRIMARY KEY,
  provider_id          INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL,
  -- 固定页源填 url；搜索型源（kind='search'）填 query，此时 url 允许为 NULL。
  -- 早期版本把 url 定义为 NOT NULL，导致搜索源根本无法入库，
  -- 于是 providers.yaml 里所有 kind:search 配置形同虚设（详见 2026-10-03 排查）。
  url                  TEXT,
  query                TEXT,
  selector             TEXT,
  frequency            TEXT NOT NULL DEFAULT 'daily',
  enabled              INTEGER NOT NULL DEFAULT 1,
  last_ok_at           TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  -- 同一厂商下：固定源按 url 唯一，搜索源按 query 唯一。
  -- 两列都参与唯一约束，NULL 在 SQLite 中互不相等，故不会误判。
  UNIQUE(provider_id, url, query)
);
CREATE INDEX IF NOT EXISTS idx_src_provider ON sources(provider_id, enabled);

-- ---------------- 抓取批次 ----------------
CREATE TABLE IF NOT EXISTS fetch_runs (
  id            INTEGER PRIMARY KEY,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  trigger       TEXT NOT NULL DEFAULT 'cron',
  status        TEXT NOT NULL DEFAULT 'running',
  sources_total INTEGER NOT NULL DEFAULT 0,
  sources_ok    INTEGER NOT NULL DEFAULT 0,
  items_found   INTEGER NOT NULL DEFAULT 0,
  items_new     INTEGER NOT NULL DEFAULT 0,
  items_updated INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_started ON fetch_runs(started_at DESC);

-- ---------------- 单源抓取尝试（失败重试可追溯） ----------------
CREATE TABLE IF NOT EXISTS fetch_attempts (
  id          INTEGER PRIMARY KEY,
  run_id      INTEGER NOT NULL REFERENCES fetch_runs(id) ON DELETE CASCADE,
  source_id   INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  attempt_no  INTEGER NOT NULL,
  started_at  TEXT NOT NULL,
  duration_ms INTEGER,
  http_status INTEGER,
  ok          INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  bytes       INTEGER,
  UNIQUE(run_id, source_id, attempt_no)
);
CREATE INDEX IF NOT EXISTS idx_att_run ON fetch_attempts(run_id, ok);

-- ---------------- 原始快照（证据链） ----------------
CREATE TABLE IF NOT EXISTS raw_snapshots (
  id           INTEGER PRIMARY KEY,
  attempt_id   INTEGER NOT NULL REFERENCES fetch_attempts(id) ON DELETE CASCADE,
  source_id    INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  text_content TEXT,
  html_path    TEXT,
  captured_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_snap_hash ON raw_snapshots(content_hash);
CREATE INDEX IF NOT EXISTS idx_snap_src  ON raw_snapshots(source_id, captured_at DESC);

-- ---------------- 活动主表 ----------------
CREATE TABLE IF NOT EXISTS activities (
  id                    INTEGER PRIMARY KEY,
  fingerprint           TEXT NOT NULL UNIQUE,
  provider_id           INTEGER NOT NULL REFERENCES providers(id),
  -- 关联到"端点"与"模型"（见上方两张表的注释）。
  -- 允许为空：并非每条活动都能对应到某个已知模型/长期端点
  --（如"登录客户端送 6 元赠金"这类与具体模型无关的普惠活动）。
  endpoint_id           INTEGER REFERENCES endpoints(id) ON DELETE SET NULL,
  model_id              INTEGER REFERENCES models(id) ON DELETE SET NULL,
  title                 TEXT NOT NULL,
  summary               TEXT,
  category              TEXT NOT NULL DEFAULT 'free_credit',
  benefit_kind          TEXT,
  benefit_amount        REAL,
  benefit_unit          TEXT,
  benefit_text          TEXT,
  audience              TEXT NOT NULL DEFAULT '["all"]',
  audience_note         TEXT,
  region                TEXT NOT NULL DEFAULT 'CN',
  requires_card         INTEGER NOT NULL DEFAULT 0,
  requires_verification TEXT,
  start_date            TEXT,
  end_date              TEXT,
  is_recurring          TEXT,
  claim_url             TEXT NOT NULL,
  source_id             INTEGER REFERENCES sources(id),
  source_url            TEXT,
  source_excerpt        TEXT,
  evidence_id           INTEGER REFERENCES raw_snapshots(id),
  confidence            REAL NOT NULL DEFAULT 0.5,
  -- extracted_by: 该条目由哪条路径产出（rule / search / llm / search+llm）。
  -- 必须持久化，否则"链接是否经过域名白名单校验"这一决策事后无法追溯：
  -- 搜索型源的产物刻意跳过白名单校验（宁多毋缺），若无此列，
  -- 事后重算审核状态时无法还原当时的判定上下文（实测踩过这个坑）。
  extracted_by          TEXT,
  review_status         TEXT NOT NULL DEFAULT 'pending',
  status_override       TEXT,
  archived_at           TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  last_verified_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_act_provider ON activities(provider_id);
CREATE INDEX IF NOT EXISTS idx_act_category ON activities(category);
CREATE INDEX IF NOT EXISTS idx_act_dates    ON activities(start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_act_review   ON activities(review_status);
CREATE INDEX IF NOT EXISTS idx_act_archived ON activities(archived_at);
CREATE INDEX IF NOT EXISTS idx_act_created  ON activities(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_act_endpoint ON activities(endpoint_id);
CREATE INDEX IF NOT EXISTS idx_act_model    ON activities(model_id);

-- ---------------- 变更历史（谁在何时改了什么） ----------------
CREATE TABLE IF NOT EXISTS change_history (
  id          INTEGER PRIMARY KEY,
  activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  field       TEXT NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  changed_by  TEXT NOT NULL DEFAULT 'pipeline',
  run_id      INTEGER REFERENCES fetch_runs(id),
  changed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chg_act ON change_history(activity_id, changed_at DESC);

-- ---------------- 订阅（Web Push） ----------------
CREATE TABLE IF NOT EXISTS subscriptions (
  id           INTEGER PRIMARY KEY,
  endpoint     TEXT NOT NULL UNIQUE,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  filters      TEXT,
  user_agent   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_push_at TEXT,
  fail_count   INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1
);

-- ---------------- 推送日志 ----------------
CREATE TABLE IF NOT EXISTS push_log (
  id              INTEGER PRIMARY KEY,
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  activity_id     INTEGER REFERENCES activities(id) ON DELETE SET NULL,
  ok              INTEGER NOT NULL,
  status_code     INTEGER,
  error           TEXT,
  sent_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------- 键值配置（如 VAPID 公钥） ----------------
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
--  全文索引（FTS5，unicode61 分词，中文实测可用）
--  使用 external-content 模式，靠触发器手动同步
-- ============================================================
-- 说明：unicode61 分词器会把连续中文当作单个 token（"1亿" 与 "1 亿" 视为不同 token），
-- 导致中文子串检索不可靠。因此本表只建一个「通配前缀增强列」，真正的检索
-- 由 src/lib/search.js 统一处理（FTS + LIKE 双路合并），保证中英文都能命中。
CREATE VIRTUAL TABLE IF NOT EXISTS activities_fts USING fts5(
  title,
  summary,
  benefit_text,
  audience_note,
  provider_name,
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS trg_act_ai AFTER INSERT ON activities BEGIN
  INSERT INTO activities_fts(rowid, title, summary, benefit_text, audience_note, provider_name)
  VALUES (
    new.id,
    new.title,
    COALESCE(new.summary, ''),
    COALESCE(new.benefit_text, ''),
    COALESCE(new.audience_note, ''),
    COALESCE((SELECT name_zh FROM providers WHERE id = new.provider_id), '')
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_act_au AFTER UPDATE ON activities BEGIN
  DELETE FROM activities_fts WHERE rowid = old.id;
  INSERT INTO activities_fts(rowid, title, summary, benefit_text, audience_note, provider_name)
  VALUES (
    new.id,
    new.title,
    COALESCE(new.summary, ''),
    COALESCE(new.benefit_text, ''),
    COALESCE(new.audience_note, ''),
    COALESCE((SELECT name_zh FROM providers WHERE id = new.provider_id), '')
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_act_ad AFTER DELETE ON activities BEGIN
  DELETE FROM activities_fts WHERE rowid = old.id;
END;

-- 厂商改名时同步 FTS 中的 provider_name
CREATE TRIGGER IF NOT EXISTS trg_prov_au AFTER UPDATE OF name_zh ON providers BEGIN
  UPDATE activities_fts
     SET provider_name = new.name_zh
   WHERE rowid IN (SELECT id FROM activities WHERE provider_id = new.id);
END;

-- 全文检索辅助索引：LIKE 回退路径用（中文子串匹配）
CREATE INDEX IF NOT EXISTS idx_act_title ON activities(title);

-- ============================================================
--  状态派生视图
--  status: active | upcoming | ended
--  优先级：人工覆盖 > 归档 > 开始时间 > 结束时间 > 默认进行中
-- ============================================================
DROP VIEW IF EXISTS v_activities;
CREATE VIEW v_activities AS
SELECT
  a.*,
  p.name_zh       AS provider_name,
  p.name_en       AS provider_name_en,
  p.slug          AS provider_slug,
  p.country       AS provider_country,
  p.website       AS provider_website,
  p.brand_color   AS provider_color,
  p.cn_accessible AS cn_accessible,
  -- 模型层（可能为空：部分普惠活动不绑定具体模型）
  m.slug          AS model_slug,
  m.name          AS model_name,
  m.capability    AS model_capability,
  m.capabilities  AS model_capabilities,
  m.context_window AS model_context_window,
  -- 端点层（可能为空：限时活动不一定对应长期端点）
  e.slug          AS endpoint_slug,
  e.quota_kind    AS endpoint_quota_kind,
  e.quota_rpm     AS endpoint_quota_rpm,
  e.quota_rpd     AS endpoint_quota_rpd,
  e.quota_text    AS endpoint_quota_text,
  e.api_base_url  AS endpoint_api_base,
  e.score         AS endpoint_score,
  -- 端点的门槛信息：用于活动卡片直接标注"免绑卡 / 国内直连"，
  -- 这些字段来自长期端点而非限时活动，可信度高于从活动文本里猜出来的 requires_card
  e.requires_card    AS endpoint_requires_card,
  e.cn_accessible    AS endpoint_cn_accessible,
  e.openai_compatible AS endpoint_openai_compatible,
  e.claim_url        AS endpoint_claim_url,
  e.docs_url         AS endpoint_docs_url,
  CASE
    WHEN a.status_override IS NOT NULL THEN a.status_override
    WHEN a.archived_at IS NOT NULL THEN 'ended'
    WHEN a.start_date IS NOT NULL AND date(a.start_date) > date('now','+8 hours') THEN 'upcoming'
    WHEN a.end_date   IS NOT NULL AND date(a.end_date)   < date('now','+8 hours') THEN 'ended'
    ELSE 'active'
  END AS status,
  CASE
    WHEN a.end_date IS NOT NULL
    THEN CAST(julianday(date(a.end_date)) - julianday(date('now','+8 hours')) AS INTEGER)
  END AS days_left,
  CASE
    WHEN a.end_date IS NOT NULL
     AND date(a.end_date) >= date('now','+8 hours')
     AND CAST(julianday(date(a.end_date)) - julianday(date('now','+8 hours')) AS INTEGER) <= 3
    THEN 1 ELSE 0
  END AS ending_soon,
  CASE
    WHEN a.created_at >= datetime('now','-1 day') THEN 1 ELSE 0
  END AS is_new
FROM activities a
JOIN providers p ON p.id = a.provider_id
LEFT JOIN models    m ON m.id = a.model_id
LEFT JOIN endpoints e ON e.id = a.endpoint_id;
