#!/usr/bin/env node
/**
 * backfill-model-link.js — 给库中已有活动回填模型/端点关联
 *
 * 用途：
 *   三层结构引入后，老数据（在关联逻辑上线前抓取的活动）的 model_id /
 *   endpoint_id 全为 NULL，前端只能显示"（未关联）"。本脚本就地回填，
 *   避免为了几条数据重跑整轮抓取（耗时数分钟且受目标站点可用性影响）。
 *
 * 用法：
 *   node scripts/backfill-model-link.js           # 只处理未关联的
 *   node scripts/backfill-model-link.js --all     # 重算全部（含已关联，用于修正误判）
 *   node scripts/backfill-model-link.js --dry     # 只打印将要做的改动，不写库
 */

import { getDb, all, get, run } from '../src/db/db.js';
import { buildModelIndex, inferModel, inferEndpointByUrl } from '../src/lib/link-model.js';

const argv = process.argv.slice(2);
const ALL = argv.includes('--all');
const DRY = argv.includes('--dry');

const db = getDb();
const index = buildModelIndex(db);
index.db = db;

const sql = ALL
  ? `SELECT id, provider_id, title, summary, benefit_text, source_excerpt, model_id, endpoint_id FROM activities`
  : `SELECT id, provider_id, title, summary, benefit_text, source_excerpt, model_id, endpoint_id
       FROM activities WHERE model_id IS NULL`;
const rows = all(db, sql);

const modelName = (id) => (id ? get(db, 'SELECT name FROM models WHERE id=?', [id])?.name : null);
const providerName = (id) => get(db, 'SELECT name_zh FROM providers WHERE id=?', [id])?.name_zh || `#${id}`;

let updated = 0, viaUrl = 0, viaFold = 0, viaVer = 0, miss = 0;
const changes = [];

for (const a of rows) {
  const text = [a.title, a.summary, a.benefit_text, a.source_excerpt].filter(Boolean).join(' ');

  let modelId = null, endpointId = null, by = null;
  const urlHit = inferEndpointByUrl({ providerId: a.provider_id, text, index });
  if (urlHit) {
    modelId = urlHit.modelId; endpointId = urlHit.endpointId; by = 'api_url';
  } else {
    const hit = inferModel({ providerId: a.provider_id, text, index });
    if (hit) { modelId = hit.modelId; endpointId = hit.endpointId; by = hit.matchedBy; }
  }

  if (!modelId) { miss++; continue; }
  if (String(modelId) === String(a.model_id) && String(endpointId) === String(a.endpoint_id)) continue;

  if (by === 'api_url') viaUrl++; else if (by === 'fold') viaFold++; else viaVer++;

  changes.push({
    id: a.id,
    provider: providerName(a.provider_id),
    title: String(a.title).slice(0, 42),
    from: modelName(a.model_id) || '（未关联）',
    to: modelName(modelId),
    by,
  });

  if (!DRY) {
    run(db, 'UPDATE activities SET model_id=?, endpoint_id=?, updated_at=datetime(\'now\') WHERE id=?',
      [modelId, endpointId, a.id]);
  }
  updated++;
}

console.log(`\n=== 三层关联回填${DRY ? '（预演，未写库）' : ''} ===`);
console.log(`扫描活动：${rows.length} 条 → 变更 ${updated} 条，未匹配 ${miss} 条`);
console.log(`  依据 API 地址：${viaUrl}   名称折叠匹配：${viaFold}   版本号唯一匹配：${viaVer}`);

if (changes.length) {
  console.log('\n明细：');
  for (const c of changes.slice(0, 40)) {
    console.log(`  [${c.by}] ${c.provider} · ${c.title}\n        ${c.from} → ${c.to}`);
  }
  if (changes.length > 40) console.log(`  … 另有 ${changes.length - 40} 条`);
}

// 关联覆盖率（这是三层结构是否真正可用的唯一判据）
const cov = get(db, `SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN model_id IS NOT NULL THEN 1 ELSE 0 END) AS linked
  FROM activities WHERE archived_at IS NULL`);
console.log(`\n覆盖率：${cov.linked}/${cov.total} = ${cov.total ? Math.round(cov.linked / cov.total * 100) : 0}%`);
