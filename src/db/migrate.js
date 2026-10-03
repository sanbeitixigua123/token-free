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
    const seenUrls = new Set();
    for (const s of p.sources || []) {
      const url = s.url || null;
      if (!url) continue;
      seenUrls.add(url);
      const ex = get(db, 'SELECT id FROM sources WHERE provider_id=? AND url=?', [providerId, url]);
      const enabled = s.enabled === false ? 0 : 1;
      if (ex) {
        run(db, `UPDATE sources SET kind=?, selector=?, frequency=?, enabled=? WHERE id=?`,
          [s.kind || 'pricing', s.selector || null, s.frequency || 'daily', enabled, ex.id]);
      } else {
        run(db, `INSERT INTO sources (provider_id, kind, url, selector, frequency, enabled)
                 VALUES (?,?,?,?,?,?)`,
          [providerId, s.kind || 'pricing', url, s.selector || null, s.frequency || 'daily', enabled]);
      }
      srcSynced++;
    }
    // 停用 yaml 中已不存在的源
    const existingSources = all(db, 'SELECT id, url FROM sources WHERE provider_id=?', [providerId]);
    for (const es of existingSources) {
      if (!seenUrls.has(es.url)) {
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
