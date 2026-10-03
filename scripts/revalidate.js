/**
 * revalidate.js — 对库内既有条目重新跑一遍校验（一次性修复工具）
 *
 * 场景：validate.js 的判据修好后（如 reasons/notes 拆分），
 * 库内既有条目仍是**旧逻辑**的结论，需要重算 review_status。
 *
 * 为什么需要它：修复的是"判定逻辑"，但库里存的是"判定结果"。
 * 不重算的话，修复对存量数据毫无影响——这正是"修了却没生效"的常见陷阱。
 *
 * 用法：
 *   node scripts/revalidate.js            # 预览（不写库）
 *   node scripts/revalidate.js --apply    # 实际写库
 */

import { getDb, all, run } from '../src/db/db.js';
import { validateItem } from '../src/pipeline/validate.js';
import { buildAllowedHosts } from '../src/pipeline/index.js';
import { loadSettings, loadProviders } from '../src/lib/config.js';

const APPLY = process.argv.includes('--apply');
const db = getDb();
const settings = loadSettings();
const providers = loadProviders();
const bySlug = new Map(providers.map((p) => [p.slug, p]));

/** 把库行还原成 validateItem 需要的 item 形状 */
function rowToItem(r) {
  return {
    providerSlug: r.provider_slug,
    title: r.title,
    summary: r.summary,
    category: r.category,
    benefitKind: r.benefit_kind,
    benefitAmount: r.benefit_amount,
    benefitUnit: r.benefit_unit,
    benefitText: r.benefit_text,
    audience: r.audience ? JSON.parse(r.audience) : ['all'],
    startDate: r.start_date,
    endDate: r.end_date,
    claimUrl: r.claim_url,
    sourceUrl: r.source_url,
    sourceExcerpt: r.source_excerpt,
    confidence: r.confidence,
    // extracted_by 是持久化的溯源列（migrateActivitiesForExtractedBy 补上）。
    // 老数据该列为 NULL，此时回退到"看源 kind"：来自 kind='search' 的源，
    // 其产物必然指向外部站点，应跳过域名白名单。
    extractedBy: r.extracted_by || (r.src_kind === 'search' ? 'search' : 'rule'),
  };
}

const rows = all(db, `
  SELECT a.*, p.slug AS provider_slug,
         (SELECT s.url FROM sources s WHERE s.id = a.source_id) AS src_url,
         (SELECT s.kind FROM sources s WHERE s.id = a.source_id) AS src_kind
  FROM activities a
  JOIN providers p ON p.id = a.provider_id
  WHERE a.archived_at IS NULL
  ORDER BY a.confidence DESC, a.id
`);

console.log(`库内条目 ${rows.length} 条，开始重算（${APPLY ? '写入模式' : '预览模式'}）\n`);

const changes = [];
for (const r of rows) {
  const it = rowToItem(r);
  const skipHostCheck = it.extractedBy === 'search' || it.extractedBy === 'search+llm';
  // ⚠️ 必须复算**真实白名单**。此前传 allowedHosts: [] 导致重算结果与管线实际行为不一致
  // —— 凡是"链接域名不在白名单"的条目都会被误降级为 pending，即使管线里本来是放行的。
  const hosts = buildAllowedHosts(bySlug.get(r.provider_slug) || {}, []);
  const v = validateItem(it, {
    allowedHosts: hosts,
    sourceUrl: r.src_url,
    settings,
    skipHostCheck,
  });

  // 已人工裁决过的（approved/rejected）不覆盖
  const manual = r.review_status === 'approved' || r.review_status === 'rejected';
  const next = manual ? r.review_status : (v.action === 'auto_ok' ? 'auto_ok' : (v.action === 'reject' ? 'rejected' : 'pending'));

  if (next !== r.review_status) {
    changes.push({ id: r.id, title: r.title, from: r.review_status, to: next, conf: r.confidence, reasons: v.reasons, notes: v.notes });
  }
}

if (!changes.length) {
  console.log('无变化。');
} else {
  console.log(`状态变化 ${changes.length} 条：\n`);
  for (const c of changes) {
    console.log(`  #${c.id}  ${c.from} → ${c.to}  (conf ${c.conf})`);
    console.log(`      ${String(c.title).slice(0, 62)}`);
    if (c.reasons?.length) console.log(`      阻塞原因: ${c.reasons.join('; ')}`);
    if (c.notes?.length) console.log(`      备注: ${c.notes.join('; ')}`);
  }
}

if (APPLY && changes.length) {
  for (const c of changes) {
    run(db, `UPDATE activities SET review_status=? WHERE id=?`, [c.to, c.id]);
  }
  console.log(`\n已写入 ${changes.length} 条状态变更。`);
} else if (changes.length) {
  console.log('\n（预览模式，未写库。加 --apply 实际写入）');
}
