/**
 * persist.js — 落库
 *
 * 行为：
 *   指纹已存在 → 比对字段差异，有变化写 change_history 并更新；无变化仅更新 last_verified_at
 *   指纹不存在 → 插入新记录
 *   返回统计 { new, updated, unchanged, changes[] }
 */

import { createLogger } from '../lib/logger.js';
import { run, get, all, transaction } from '../db/db.js';
import { diffAgainstExisting } from './normalize.js';
import { AUTO_OK, PENDING } from './validate.js';

const log = createLogger('persist');

const INSERT_SQL = `
INSERT INTO activities (
  fingerprint, provider_id, title, summary, category,
  benefit_kind, benefit_amount, benefit_unit, benefit_text,
  audience, audience_note, region, requires_card, requires_verification,
  start_date, end_date, is_recurring, claim_url,
  source_id, source_url, source_excerpt, evidence_id,
  confidence, extracted_by, review_status, model_id, endpoint_id, last_verified_at
) VALUES (
  ?,?,?,?,?,
  ?,?,?,?,
  ?,?,?,?,?,
  ?,?,?,?,
  ?,?,?,?,
  ?,?,?,?,?,datetime('now')
)`;

export function persistItems(db, items, { runId = null, providerIdBySlug, sourceIdByUrl, evidenceIdBySource }) {
  const stats = { new: 0, updated: 0, unchanged: 0, pending: 0, changes: [], newIds: [] };

  transaction(db, () => {
    for (const it of items) {
      const providerId = providerIdBySlug.get(it.providerSlug);
      if (!providerId) { log.warn(`未知厂商，跳过：${it.providerSlug}`); continue; }

      const existing = get(db, 'SELECT * FROM activities WHERE fingerprint = ?', [it.fingerprint]);

      if (existing) {
        const changes = diffAgainstExisting(it, existing);
        if (changes.length) {
          run(db, `UPDATE activities SET
              title=?, summary=?, category=?,
              benefit_kind=?, benefit_amount=?, benefit_unit=?, benefit_text=?,
              audience=?, audience_note=?, region=?, requires_card=?, requires_verification=?,
              start_date=?, end_date=?, is_recurring=?, claim_url=?,
              source_id=?, source_url=?, source_excerpt=?,
              confidence=?, extracted_by=?,
              model_id=?, endpoint_id=?,
              updated_at=datetime('now'), last_verified_at=datetime('now')
            WHERE id=?`,
            [
              it.title, it.summary, it.category,
              it.benefitKind, it.benefitAmount, it.benefitUnit, it.benefitText,
              JSON.stringify(it.audience), it.audienceNote, it.region, it.requiresCard, it.requiresVerification,
              it.startDate, it.endDate, it.isRecurring, it.claimUrl,
              sourceIdByUrl.get(it.sourceUrl) ?? existing.source_id, it.sourceUrl, it.sourceExcerpt,
              it.confidence, it.extractedBy ?? existing.extracted_by ?? 'rule',
              // 关联字段：本次没匹配到（null）时保留库中已有值。
              // 理由：模型匹配依赖端点在库中的存在性，若某次端点临时被停用，
              // 不应把已经建立好的正确关联抹掉——那是数据退化，不是数据更新。
              it.modelId ?? existing.model_id ?? null,
              it.endpointId ?? existing.endpoint_id ?? null,
              existing.id,
            ]);

          for (const c of changes) {
            run(db, `INSERT INTO change_history (activity_id, field, old_value, new_value, changed_by, run_id)
                     VALUES (?,?,?,?,'pipeline',?)`,
              [existing.id, c.field, c.oldValue, c.newValue, runId]);
          }
          stats.updated++;
          stats.changes.push({ id: existing.id, title: it.title, fields: changes.map((c) => c.field) });
        } else {
          // 无变化 → 仅刷新"最后确认可用"时间，这可作为活动仍然有效的证据
          run(db, `UPDATE activities SET last_verified_at=datetime('now') WHERE id=?`, [existing.id]);
          stats.unchanged++;
        }
        continue;
      }

      // 新记录
      const reviewStatus = it.reviewAction === AUTO_OK ? AUTO_OK : PENDING;
      if (reviewStatus === PENDING) stats.pending++;

      const res = run(db, INSERT_SQL, [
        it.fingerprint, providerId, it.title, it.summary, it.category,
        it.benefitKind, it.benefitAmount, it.benefitUnit, it.benefitText,
        JSON.stringify(it.audience), it.audienceNote, it.region, it.requiresCard, it.requiresVerification,
        it.startDate, it.endDate, it.isRecurring, it.claimUrl,
        sourceIdByUrl.get(it.sourceUrl) ?? null, it.sourceUrl, it.sourceExcerpt,
        evidenceIdBySource.get(it.sourceUrl) ?? null,
        it.confidence, it.extractedBy ?? 'rule', reviewStatus,
        it.modelId ?? null, it.endpointId ?? null,
      ]);
      stats.new++;
      stats.newIds.push(res.lastInsertRowid);
    }
  });

  return stats;
}

/** 人工审核 */
export function reviewActivity(db, id, { action, patch = null, note = null }) {
  const existing = get(db, 'SELECT * FROM activities WHERE id=?', [id]);
  if (!existing) throw new Error(`活动不存在：id=${id}`);

  const status = action === 'approve' ? 'approved'
    : action === 'reject' ? 'rejected'
      : action === 'pending' ? 'pending'
        : null;
  if (patch && typeof patch === 'object') {
    const allowed = [
      'title', 'summary', 'category', 'benefit_kind', 'benefit_amount', 'benefit_unit',
      'benefit_text', 'audience', 'audience_note', 'region', 'requires_card',
      'requires_verification', 'start_date', 'end_date', 'is_recurring', 'claim_url',
      'status_override', 'source_excerpt',
    ];
    transaction(db, () => {
      for (const [k, v] of Object.entries(patch)) {
        if (!allowed.includes(k)) continue;
        const nv = Array.isArray(v) ? JSON.stringify(v) : v;
        if (String(existing[k] ?? '') !== String(nv ?? '')) {
          run(db, `INSERT INTO change_history (activity_id, field, old_value, new_value, changed_by)
                   VALUES (?,?,?,?,'manual')`, [id, k, existing[k] ?? null, nv ?? null]);
          run(db, `UPDATE activities SET ${k}=?, updated_at=datetime('now') WHERE id=?`, [nv ?? null, id]);
        }
      }
    });
  }
  if (status) {
    run(db, `UPDATE activities SET review_status=?, updated_at=datetime('now') WHERE id=?`, [status, id]);
    if (status === 'rejected') {
      run(db, `UPDATE activities SET archived_at=datetime('now') WHERE id=?`, [id]);
    }
  }
  return get(db, 'SELECT * FROM activities WHERE id=?', [id]);
}

/** 软归档：结束超过 N 天的活动 */
export function archiveExpired(db, { afterDays = 30 } = {}) {
  const res = run(
    db,
    `UPDATE activities
        SET archived_at = datetime('now'), updated_at = datetime('now')
      WHERE archived_at IS NULL
        AND end_date IS NOT NULL
        AND julianday(date('now','+8 hours')) - julianday(date(end_date)) > ?
        AND status_override IS NULL`,
    [afterDays]
  );
  // 已拒绝的也归档
  const res2 = run(
    db,
    `UPDATE activities SET archived_at = datetime('now')
      WHERE archived_at IS NULL AND review_status = 'rejected'`
  );
  return { archived: res.changes + res2.changes };
}
