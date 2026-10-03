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

-- ---------------- 数据源 ----------------
CREATE TABLE IF NOT EXISTS sources (
  id                   INTEGER PRIMARY KEY,
  provider_id          INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL,
  url                  TEXT NOT NULL,
  selector             TEXT,
  frequency            TEXT NOT NULL DEFAULT 'daily',
  enabled              INTEGER NOT NULL DEFAULT 1,
  last_ok_at           TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider_id, url)
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
JOIN providers p ON p.id = a.provider_id;
