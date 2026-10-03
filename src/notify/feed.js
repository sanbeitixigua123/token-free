/**
 * feed.js — RSS 2.0 与 JSON feed 生成
 *
 * 输出到 public/data/：
 *   feed.xml          RSS 2.0（任何阅读器可订阅）
 *   activities.json   全量活动（静态站数据源）
 *   providers.json    厂商清单
 *   stats.json        统计
 *   filters.json      筛选维度枚举
 *   meta.json         生成时间与版本
 *
 * 这是 GitHub Pages 静态版的唯一数据来源，也是"数据可追溯"的对外快照。
 */

import fs from 'node:fs';
import path from 'node:path';
import { all, get, PROJECT_ROOT } from '../db/db.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('feed');
const DATA_DIR = path.join(PROJECT_ROOT, 'public', 'data');

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const CATEGORY_LABEL = {
  free_credit: '免费额度', trial: '免费试用', student: '学生优惠',
  discount: '折扣促销', refreshable: '周期刷新',
};
const AUDIENCE_LABEL = {
  all: '所有人', new_user: '新用户', student: '学生', teacher: '教师',
  open_source: '开源项目', startup: '初创团队', enterprise: '企业', verified: '需实名/绑卡',
};
const STATUS_LABEL = { active: '进行中', upcoming: '即将开始', ended: '已结束' };
const BENEFIT_UNIT_LABEL = { token: 'tokens', CNY: '元', USD: '美元', day: '天', month: '个月', count: '个' };

/** 把数据库行转成前端友好的对象 */
export function serializeActivity(r) {
  let audience = [];
  try { audience = JSON.parse(r.audience); } catch { audience = ['all']; }
  const isNew = Number(r.is_new) === 1;
  return {
    id: r.id,
    fingerprint: r.fingerprint,
    provider: {
      slug: r.provider_slug,
      name: r.provider_name,
      nameEn: r.provider_name_en,
      country: r.provider_country,
      website: r.provider_website,
      color: r.provider_color,
      cnAccessible: Number(r.cn_accessible) === 1,
    },
    title: r.title,
    summary: r.summary,
    category: r.category,
    categoryLabel: CATEGORY_LABEL[r.category] || r.category,
    benefit: r.benefit_kind
      ? {
        kind: r.benefit_kind,
        amount: r.benefit_amount,
        unit: r.benefit_unit,
        unitLabel: BENEFIT_UNIT_LABEL[r.benefit_unit] || r.benefit_unit || '',
        text: r.benefit_text,
        display: formatBenefit(r),
      }
      : (r.benefit_text ? { kind: null, text: r.benefit_text, display: r.benefit_text } : null),
    audience,
    audienceLabels: audience.map((a) => AUDIENCE_LABEL[a] || a),
    audienceNote: r.audience_note,
    region: r.region,
    requiresCard: Number(r.requires_card) === 1,
    requiresVerification: r.requires_verification,
    startDate: r.start_date,
    endDate: r.end_date,
    isRecurring: r.is_recurring,
    claimUrl: r.claim_url,
    sourceUrl: r.source_url,
    sourceExcerpt: r.source_excerpt,
    confidence: r.confidence,
    reviewStatus: r.review_status,
    status: r.status,
    statusLabel: r.status === 'active' && isNew ? 'NEW' : (STATUS_LABEL[r.status] || r.status),
    daysLeft: r.days_left,
    endingSoon: Number(r.ending_soon) === 1,
    isNew,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastVerifiedAt: r.last_verified_at,
  };
}

function formatBenefit(r) {
  if (r.benefit_amount == null) return r.benefit_text || '';
  const unit = BENEFIT_UNIT_LABEL[r.benefit_unit] || r.benefit_unit || '';
  if (r.benefit_unit === 'token') {
    // 1e8 → 1 亿；1e4 → 1 万
    if (r.benefit_amount >= 1e8) return `${trim(r.benefit_amount / 1e8)} 亿 tokens`;
    if (r.benefit_amount >= 1e4) return `${trim(r.benefit_amount / 1e4)} 万 tokens`;
    return `${r.benefit_amount} tokens`;
  }
  if (r.benefit_unit === 'CNY') return `¥${trim(r.benefit_amount)}`;
  if (r.benefit_unit === 'USD') return `$${trim(r.benefit_amount)}`;
  if (r.benefit_unit === 'count') {
    // 计数型赠送：优先展示原文（如"10 个快速克隆音色"），比裸数字更有信息量
    return r.benefit_text || `${trim(r.benefit_amount)} 个`;
  }
  return `${trim(r.benefit_amount)} ${unit}`;
}
const trim = (n) => (Math.round(n * 100) / 100).toString();

/** 生成全量数据文件 */
export function buildDataFiles(db, settings = {}) {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const rows = all(db, `
    SELECT * FROM v_activities
    WHERE review_status IN ('auto_ok','approved')
    ORDER BY
      CASE status WHEN 'active' THEN 0 WHEN 'upcoming' THEN 1 ELSE 2 END,
      COALESCE(end_date, '9999-12-31') ASC,
      confidence DESC, id DESC
  `);
  const activities = rows.map(serializeActivity);

  const providers = all(db, `
    SELECT p.slug, p.name_zh, p.name_en, p.country, p.website, p.pricing_url,
           p.announcement_url, p.brand_color, p.cn_accessible, p.tier,
           COUNT(a.id) AS activity_count,
           SUM(CASE WHEN a.end_date IS NULL OR date(a.end_date) >= date('now','+8 hours') THEN 1 ELSE 0 END) AS active_count
    FROM providers p
    LEFT JOIN activities a ON a.provider_id = p.id AND a.review_status IN ('auto_ok','approved')
    GROUP BY p.id
    ORDER BY p.tier, activity_count DESC, p.name_zh
  `).map((p) => ({
    slug: p.slug,
    name: p.name_zh,
    nameEn: p.name_en,
    country: p.country,
    website: p.website,
    pricingUrl: p.pricing_url,
    announcementUrl: p.announcement_url,
    color: p.brand_color,
    cnAccessible: Number(p.cn_accessible) === 1,
    tier: p.tier,
    activityCount: p.activity_count,
    activeCount: p.active_count,
  }));

  // 统计
  //
  // ⚠️ 契约要求：这里导出的 stats 必须是 /api/stats 的**超集**。
  // 前端 app.js 只按 /api/stats 的嵌套结构取值（byStatus.active / providerCount），
  // 静态模式下若缺这两个字段，首页「进行中」与「覆盖厂商」会静默显示 0。
  // 故在扁平字段之外，额外补齐嵌套别名。改动本对象时请同步核对
  // src/server.js 的 /api/stats 处理器，两者字段必须对齐。
  const activeCount = activities.filter((a) => a.status === 'active').length;
  const upcomingCount = activities.filter((a) => a.status === 'upcoming').length;
  const endedCount = activities.filter((a) => a.status === 'ended').length;
  const providersCovered = providers.filter((p) => p.activityCount > 0).length;

  const stats = {
    // —— 扁平字段（保留，供 feed.xml 等既有消费方使用）——
    total: activities.length,
    active: activeCount,
    upcoming: upcomingCount,
    ended: endedCount,
    endingSoon: activities.filter((a) => a.endingSoon && a.status === 'active').length,
    newToday: activities.filter((a) => a.isNew).length,
    providers: providersCovered,
    providersTracked: providers.length,
    // —— 嵌套别名（与 /api/stats 对齐，前端实际读取的就是这些）——
    byStatus: { active: activeCount, upcoming: upcomingCount, ended: endedCount },
    providerCount: providersCovered,
    // 与 /api/stats 一致的口径：providerCount 只计「有收录活动的厂商」，
    // 而非 providers.yaml 里的全部跟踪厂商（后者见 providersTracked）。
    lastRun: get(db, `SELECT finished_at, status, items_new, sources_ok, sources_total
                      FROM fetch_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1`) || null,
  };

  // 筛选枚举
  const filters = {
    categories: Object.entries(CATEGORY_LABEL).map(([v, l]) => ({
      value: v, label: l, count: activities.filter((a) => a.category === v).length,
    })).filter((c) => c.count > 0),
    audiences: Object.entries(AUDIENCE_LABEL).map(([v, l]) => ({
      value: v, label: l, count: activities.filter((a) => a.audience.includes(v)).length,
    })).filter((c) => c.count > 0),
    statuses: Object.entries(STATUS_LABEL).map(([v, l]) => ({
      value: v, label: l, count: activities.filter((a) => a.status === v).length,
    })).filter((c) => c.count > 0),
    regions: [
      { value: 'CN', label: '国内', count: activities.filter((a) => a.region === 'CN').length },
      { value: 'GLOBAL', label: '海外', count: activities.filter((a) => a.region !== 'CN').length },
    ].filter((c) => c.count > 0),
    providers: providers.filter((p) => p.activityCount > 0).map((p) => ({
      value: p.slug, label: p.name, count: p.activityCount,
    })),
  };

  const meta = {
    generatedAt: new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19),
    generatedAtUtc: new Date().toISOString(),
    timezone: 'Asia/Shanghai',
    siteName: settings.export?.siteName || 'Token Free',
    schedule: '每日 10:00（北京时间）自动更新',
    version: 1,
    counts: { activities: activities.length, providers: providers.length },
  };

  writeJson(path.join(DATA_DIR, 'activities.json'), activities);
  writeJson(path.join(DATA_DIR, 'providers.json'), providers);
  writeJson(path.join(DATA_DIR, 'stats.json'), stats);
  writeJson(path.join(DATA_DIR, 'filters.json'), filters);
  writeJson(path.join(DATA_DIR, 'meta.json'), meta);

  return { activities, providers, stats, filters, meta };
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

/** 生成 RSS 2.0 */
export function buildRss(db, settings = {}) {
  const rows = all(db, `
    SELECT * FROM v_activities
    WHERE review_status IN ('auto_ok','approved')
    ORDER BY created_at DESC, id DESC LIMIT 100
  `).map(serializeActivity);

  const site = settings.export?.siteUrl || 'https://example.com';
  const siteName = settings.export?.siteName || 'Token Free';
  const now = new Date(Date.now() + 8 * 3600 * 1000).toUTCString();

  const items = rows.map((a) => {
    const link = `${site.replace(/\/$/, '')}/#/activity/${a.id}`;
    const desc = [
      `${a.provider.name} · ${a.categoryLabel}`,
      a.benefit?.display ? `额度：${a.benefit.display}` : null,
      a.audienceLabels?.length ? `适用：${a.audienceLabels.join('、')}` : null,
      a.endDate ? `截止：${a.endDate}` : null,
      a.summary || '',
    ].filter(Boolean).join(' ｜ ');
    return `    <item>
      <title>${esc(`[${a.provider.name}] ${a.title}`)}</title>
      <link>${esc(link)}</link>
      <guid isPermaLink="false">${esc(a.fingerprint)}</guid>
      <pubDate>${new Date(a.createdAt.replace(' ', 'T') + (a.createdAt.includes('Z') ? '' : 'Z')).toUTCString()}</pubDate>
      <category>${esc(a.categoryLabel)}</category>
      <description>${esc(desc)}</description>
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(siteName)} — AI 免费活动汇总</title>
    <link>${esc(site)}</link>
    <description>每日自动汇总国内外 AI 模型厂商的免费额度、试用与学生优惠活动</description>
    <language>zh-cn</language>
    <lastBuildDate>${now}</lastBuildDate>
    <atom:link href="${esc(site.replace(/\/$/, ''))}/feed.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>`;
}

/** 写出 feed.xml 与全部 JSON */
export function writeFeeds(db, settings = {}) {
  const bundle = buildDataFiles(db, settings);
  const rss = buildRss(db, settings);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'feed.xml'), rss, 'utf8');
  log.info(`已写出 feed 与数据文件：活动 ${bundle.activities.length} 条，厂商 ${bundle.providers.length} 家`);
  return bundle;
}

export { DATA_DIR, CATEGORY_LABEL, AUDIENCE_LABEL, STATUS_LABEL };
