/**
 * normalize.js — 归一化与去重
 *
 * 职责：
 *   1) 把不同提取器（规则/LLM）的输出统一成同一形状
 *   2) 计算指纹，识别"同一活动"
 *   3) 合并重复项（保留信息更全、置信度更高的一条）
 */

import { makeFingerprint, cleanText, normalizeDate, normalizeUrl } from '../lib/fingerprint.js';

/** 统一形状 + 补默认值 */
export function normalizeItem(raw, provider) {
  const benefit = raw.benefit || null;
  const claimUrl = raw.claimUrl ? normalizeUrl(raw.claimUrl) : null;

  // 没有领取链接时，用来源页兜底（保证 claim_url 非空，与表约束一致）
  const effectiveClaimUrl = claimUrl || normalizeUrl(raw.sourceUrl) || '';

  const item = {
    providerSlug: provider.slug,
    title: cleanText(raw.title || '').slice(0, 150),
    summary: raw.summary ? cleanText(raw.summary).slice(0, 200) : null,
    category: raw.category || 'free_credit',
    benefitKind: benefit?.kind || null,
    benefitAmount: Number.isFinite(benefit?.amount) ? benefit.amount : null,
    benefitUnit: benefit?.unit || null,
    benefitText: benefit?.text || null,
    audience: Array.isArray(raw.audience) && raw.audience.length ? raw.audience : ['all'],
    audienceNote: raw.audienceNote || null,
    region: raw.region || (provider.country === 'CN' ? 'CN' : 'GLOBAL'),
    requiresCard: raw.requiresCard ? 1 : 0,
    requiresVerification: raw.requiresVerification || null,
    startDate: raw.startDate ? normalizeDate(raw.startDate) : null,
    endDate: raw.endDate ? normalizeDate(raw.endDate) : null,
    isRecurring: raw.isRecurring || null,
    claimUrl: effectiveClaimUrl,
    sourceUrl: raw.sourceUrl || null,
    sourceExcerpt: raw.sourceExcerpt ? cleanText(raw.sourceExcerpt).slice(0, 500) : null,
    confidence: typeof raw.confidence === 'number' ? raw.confidence : 0.5,
    extractedBy: raw.extractedBy || 'rule',
    // 三层关联字段（由 linkItemsToModels 在落库前批量填充；此处只做透传，
    // 保证归一化函数的输出形状稳定）
    modelId: raw.modelId ?? null,
    endpointId: raw.endpointId ?? null,
    modelMatchedBy: raw.modelMatchedBy ?? null,
  };

  // 日期一致性修正
  if (item.startDate && item.endDate && item.endDate < item.startDate) {
    const t = item.startDate; item.startDate = item.endDate; item.endDate = t;
  }

  item.fingerprint = makeFingerprint({
    providerSlug: item.providerSlug,
    title: item.title,
    claimUrl: item.claimUrl,
    startDate: item.startDate,
  });

  return item;
}

/**
 * 批内去重：两轮。
 *
 * 第 1 轮 — 精确指纹：同一指纹只保留"更好"的一条。
 * 第 2 轮 — 近似去重：同一厂商 + 同一领取链接 + 相同额度，
 *            即使标题因抓取块切分不同而不一致，也应视作同一活动。
 *
 * 第 2 轮的由来（真实缺陷）：腾讯混元页面上同一段免费额度说明被两个相邻
 * 文本块分别抓出，标题切成"共100万 tokens，共享消耗。资源包…"与
 * "100万 tokens"，指纹因标题不同而不同 → 产生两条重复活动。
 *
 * 更好 = 置信度高 → 有额度信息 → 有起止时间 → 字段更全 → 标题更像标题
 */
export function dedupeWithinBatch(items) {
  // 第 1 轮：精确指纹
  const map = new Map();
  for (const it of items) {
    const prev = map.get(it.fingerprint);
    if (!prev || quality(it) > quality(prev)) map.set(it.fingerprint, it);
  }

  // 第 2 轮：近似去重（同厂商 + 同链接 + 同额度）
  const nearMap = new Map();
  for (const it of [...map.values()]) {
    const key = [
      (it.providerSlug || '').toLowerCase(),
      normalizeUrl(it.claimUrl || ''),
      it.benefitKind || '',
      it.benefitAmount ?? '',
      it.benefitUnit || '',
    ].join('|');

    // 没有任何识别锚点（无链接且无额度）时不做近似合并，避免误杀
    const hasAnchor = (it.claimUrl && it.claimUrl.length > 12) || it.benefitAmount != null;
    if (!hasAnchor) { nearMap.set(it.fingerprint + '|' + key, it); continue; }

    const prev = nearMap.get(key);
    if (!prev || quality(it) > quality(prev)) nearMap.set(key, it);
  }

  return [...nearMap.values()];
}

/** 质量评分，用于去重时择优 */
export function quality(it) {
  let s = (it.confidence || 0) * 10;
  if (it.benefitKind) s += 5;
  if (it.benefitAmount != null) s += 3;
  if (it.startDate) s += 2;
  if (it.endDate) s += 2;
  if (it.claimUrl && it.sourceUrl && it.claimUrl !== normalizeUrl(it.sourceUrl)) s += 3; // 有独立领取页
  if (it.audience && it.audience[0] !== 'all') s += 1;
  if (it.summary) s += 1;
  // 标题像标题（不太长、不以句读结尾、不含条款语义）→ 优先保留
  const t = String(it.title || '');
  if (t.length >= 8 && t.length <= 60) s += 2;
  if (!/[，。；、]$/.test(t)) s += 1;
  if (/(?:有效期|过期作废|共享消耗|资源包|不结转)/.test(t)) s -= 3;
  return s;
}

/** 与库中已有记录比较，返回需要更新的字段 */
export function diffAgainstExisting(item, existing) {
  const fields = [
    'title', 'summary', 'category', 'benefitKind', 'benefitAmount', 'benefitUnit',
    'benefitText', 'audience', 'audienceNote', 'region', 'requiresCard',
    'requiresVerification', 'startDate', 'endDate', 'isRecurring', 'claimUrl',
    'sourceUrl', 'sourceExcerpt', 'confidence',
  ];
  const changes = [];
  for (const f of fields) {
    let a = item[f];
    let b = existing[f];
    if (f === 'audience') {
      a = JSON.stringify(normalizeAudience(a));
      b = JSON.stringify(normalizeAudience(b));
    }
    if (f === 'benefitAmount') {
      a = a == null ? null : Number(a);
      b = b == null ? null : Number(b);
    }
    const sa = a == null ? null : String(a);
    const sb = b == null ? null : String(b);
    if (sa !== sb) changes.push({ field: f, oldValue: sb, newValue: sa });
  }
  return changes;
}

function normalizeAudience(a) {
  if (!a) return ['all'];
  try {
    const v = typeof a === 'string' ? JSON.parse(a) : a;
    return Array.isArray(v) && v.length ? [...v].sort() : ['all'];
  } catch {
    return ['all'];
  }
}

export { normalizeAudience };
