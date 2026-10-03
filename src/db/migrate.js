#!/usr/bin/env node
/**
 * migrate.js — 建库 / 应用 schema，并把 config/providers.yaml 里的厂商与数据源同步入库。
 *
 * 用法：
 *   node src/db/migrate.js            # 建表 + 同步厂商配置
 *   node src/db/migrate.js --reset    # ⚠️ 清空数据后重建（仅开发用）
 */

import { getDb, openDatabase, applySchema, run, get, all, transaction, PROJECT_ROOT } from './db.js';
import { loadProviders } from '../lib/config.js';

const reset = process.argv.includes('--reset');

if (reset) {
  const db = openDatabase();
  const tables = [
    'push_log', 'subscriptions', 'change_history', 'activities_fts',
    'activities', 'raw_snapshots', 'fetch_attempts', 'fetch_runs', 'sources', 'providers',
  ];
  db.exec('PRAGMA foreign_keys = OFF;');
  for (const t of tables) {
    db.exec(`DROP TABLE IF EXISTS ${t};`);
  }
  db.exec('PRAGMA foreign_keys = ON;');
  applySchema(db);
  console.log('[migrate] 已重置全部表结构');
}

const db = getDb();

// ---------------- 增量迁移 ----------------
//
// schema.sql 用的是 CREATE TABLE IF NOT EXISTS，对**已存在的库**不会改结构。
// 因此凡是给老表加列/放宽约束，都必须在这里显式补一次，且要幂等
//（重复执行不报错），否则老库升级时会静默保留旧结构。
migrateSourcesForSearch(db);
migrateActivitiesForExtractedBy(db);

/**
 * 给 activities 表补 extracted_by 列。
 *
 * 背景：条目是「规则抽取」还是「搜索/LLM 抽取」直接决定校验时是否跳过域名白名单，
 * 属于**必须持久化的溯源信息**。此前只在内存里传递、从未落库，导致：
 *   1) revalidate 无法还原条目的来源方式，ZCode 这类搜索得出的条目被误加白名单检查；
 *   2) 事后无法审计"这条到底是机器抽的还是模型抽的"。
 *
 * 加列是向后兼容的（旧行为 NULL），故用最简单的 ALTER TABLE，比重建表安全得多。
 */
function migrateActivitiesForExtractedBy(db) {
  const cols = all(db, 'PRAGMA table_info(activities)');
  if (!cols.length) return; // 全新库：schema.sql 已含该列
  if (cols.some((c) => c.name === 'extracted_by')) return; // 幂等
  db.exec('ALTER TABLE activities ADD COLUMN extracted_by TEXT;');
  console.log('[migrate] activities 表已升级：新增 extracted_by 列（抽取溯源）');
}

/**
 * 让 sources 表支持搜索型数据源。
 *
 * 背景：`url TEXT NOT NULL` + 缺 `query` 列，使 kind='search' 的源既存不进也查不出，
 * providers.yaml 里声明多年的搜索配置从未生效。这里做两件事：
 *   1) 新增 query 列
 *   2) 放宽 url 为可空（SQLite 不支持 ALTER COLUMN，只能重建表）
 *
 * 重建表时必须保留既有数据与外键关系，故用「建新表 → 拷数据 → 换名」的标准做法，
 * 并临时关闭外键约束（否则 DROP 旧表会触发级联）。
 */
function migrateSourcesForSearch(db) {
  const cols = all(db, 'PRAGMA table_info(sources)');
  if (!cols.length) return; // 全新库：schema.sql 已含正确结构
  const hasQuery = cols.some((c) => c.name === 'query');
  const urlRow = cols.find((c) => c.name === 'url');
  const urlNotNull = urlRow && urlRow.notnull === 1;
  if (hasQuery && !urlNotNull) return; // 已是新结构

  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sources_new (
        id                   INTEGER PRIMARY KEY,
        provider_id          INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        kind                 TEXT NOT NULL,
        url                  TEXT,
        query                TEXT,
        selector             TEXT,
        frequency            TEXT NOT NULL DEFAULT 'daily',
        enabled              INTEGER NOT NULL DEFAULT 1,
        last_ok_at           TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        created_at           TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(provider_id, url, query)
      );
    `);
    const q = hasQuery ? 'query' : 'NULL';
    db.exec(`
      INSERT OR IGNORE INTO sources_new
        (id, provider_id, kind, url, query, selector, frequency, enabled,
         last_ok_at, consecutive_failures, created_at)
      SELECT id, provider_id, kind, url, ${q}, selector, frequency, enabled,
             last_ok_at, consecutive_failures, created_at
      FROM sources;
    `);
    db.exec('DROP TABLE sources;');
    db.exec('ALTER TABLE sources_new RENAME TO sources;');
    db.exec('CREATE INDEX IF NOT EXISTS idx_src_provider ON sources(provider_id, enabled);');
    console.log('[migrate] sources 表已升级：支持搜索型源（url 可空 + 新增 query 列）');
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

// ---------------- 同步厂商配置 ----------------
const providers = loadProviders();
let provInserted = 0, provUpdated = 0, srcSynced = 0, srcDisabled = 0;

transaction(db, () => {
  for (const p of providers) {
    const existing = get(db, 'SELECT id FROM providers WHERE slug = ?', [p.slug]);
    const params = [
      p.name_zh, p.name_en || null, p.country || 'CN', p.website || null,
      p.pricing_url || null, p.announcement_url || null, p.logo_url || null,
      p.brand_color || null, p.cn_accessible === false ? 0 : 1, p.tier || 2,
    ];
    let providerId;
    if (existing) {
      run(db, `UPDATE providers SET
                 name_zh=?, name_en=?, country=?, website=?, pricing_url=?,
                 announcement_url=?, logo_url=?, brand_color=?, cn_accessible=?, tier=?,
                 updated_at=datetime('now')
               WHERE id=?`, [...params, existing.id]);
      providerId = existing.id;
      provUpdated++;
    } else {
      const r = run(db, `INSERT INTO providers
                 (slug, name_zh, name_en, country, website, pricing_url, announcement_url,
                  logo_url, brand_color, cn_accessible, tier)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [p.slug, ...params]);
      providerId = r.lastInsertRowid;
      provInserted++;
    }

    // 同步数据源
    // 关键：yaml 里已删除的源必须停用，否则会一直抓取已废弃的地址
    // 搜索型源没有 url，改用 query 作为身份标识；两者都纳入"已见"集合，
    // 否则每次 migrate 都会把搜索源误判为已删除而停用。
    const seenKeys = new Set();
    for (const s of p.sources || []) {
      const kind = s.kind || 'pricing';
      const isSearch = kind === 'search';
      const url = isSearch ? null : (s.url || null);
      const query = isSearch ? (s.query || null) : (s.query || null);
      // 搜索源必须有 query，固定源必须有 url；缺关键字段则跳过（配置写错时不静默建脏数据）
      if (isSearch && !query) continue;
      if (!isSearch && !url) continue;

      const key = isSearch ? `q:${query}` : `u:${url}`;
      seenKeys.add(key);

      const ex = isSearch
        ? get(db, 'SELECT id FROM sources WHERE provider_id=? AND query=? AND kind=?', [providerId, query, kind])
        : get(db, 'SELECT id FROM sources WHERE provider_id=? AND url=?', [providerId, url]);
      const enabled = s.enabled === false ? 0 : 1;

      if (ex) {
        run(db, `UPDATE sources SET kind=?, url=?, query=?, selector=?, frequency=?, enabled=? WHERE id=?`,
          [kind, url, query, s.selector || null, s.frequency || 'daily', enabled, ex.id]);
      } else {
        run(db, `INSERT INTO sources (provider_id, kind, url, query, selector, frequency, enabled)
                 VALUES (?,?,?,?,?,?,?)`,
          [providerId, kind, url, query, s.selector || null, s.frequency || 'daily', enabled]);
      }
      srcSynced++;
    }
    // 停用 yaml 中已不存在的源
    const existingSources = all(db, 'SELECT id, url, query, kind FROM sources WHERE provider_id=?', [providerId]);
    for (const es of existingSources) {
      const key = es.url ? `u:${es.url}` : `q:${es.query}`;
      if (!seenKeys.has(key)) {
        run(db, 'UPDATE sources SET enabled=0 WHERE id=?', [es.id]);
        srcDisabled++;
      }
    }
  }
});

const stats = {
  providers: get(db, 'SELECT COUNT(*) AS c FROM providers').c,
  sources: get(db, 'SELECT COUNT(*) AS c FROM sources WHERE enabled=1').c,
};
console.log(`[migrate] 厂商：新增 ${provInserted} / 更新 ${provUpdated}，数据源同步 ${srcSynced} 条，停用 ${srcDisabled} 条`);
console.log(`[migrate] 当前库内厂商 ${stats.providers} 家，启用数据源 ${stats.sources} 个`);
console.log(`[migrate] 数据库位置：${process.env.TOKENFREE_DB || PROJECT_ROOT + '/data/tokenfree.db'}`);
