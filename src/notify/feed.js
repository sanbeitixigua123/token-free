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
import { loadGuides } from '../lib/config.js';

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

/**
 * 能力分类标签（三层结构的第三层：模型能做什么）。
 *
 * 取值对齐业界惯例（与 freeaiapi 等同类站点一致），便于数据互通。
 * 顺序即前端筛选器的展示顺序：把用户最常找的文本/代码放前面，
 * 图像/语音/视频/嵌入作为"专项能力"排后。
 */
const CAPABILITY_LABEL = {
  'text-generation': '文本生成',
  'code-generation': '代码生成',
  'image-generation': '图像生成',
  'image-understanding': '图像理解',
  'video-generation': '视频生成',
  'speech-to-text': '语音识别',
  'text-to-speech': '语音合成',
  'text-embeddings': '文本嵌入',
  translation: '翻译',
  rerank: '重排',
};
const CAPABILITY_ORDER = Object.keys(CAPABILITY_LABEL);

/** 配额类型标签 */
const QUOTA_KIND_LABEL = {
  rate_limit: '速率限制',
  credits: '赠送额度',
  free_tier: '免费档位',
  unlimited: '不限量',
};

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
    // —— 三层结构关联（可能为 null：账户级普惠活动不绑定具体模型）——
    // 前端据此渲染"送的是哪个模型的额度"，并支持按模型/能力筛选。
    model: r.model_slug
      ? {
        slug: r.model_slug,
        name: r.model_name,
        capability: r.model_capability,
        capabilityLabel: CAPABILITY_LABEL[r.model_capability] || r.model_capability,
        capabilities: safeJsonArray(r.model_capabilities),
        contextWindow: r.model_context_window,
      }
      : null,
    endpoint: r.endpoint_slug
      ? {
        slug: r.endpoint_slug,
        quotaKind: r.endpoint_quota_kind,
        quotaKindLabel: QUOTA_KIND_LABEL[r.endpoint_quota_kind] || r.endpoint_quota_kind,
        quotaRpm: r.endpoint_quota_rpm,
        quotaRpd: r.endpoint_quota_rpd,
        quotaText: r.endpoint_quota_text,
        apiBase: r.endpoint_api_base,
        score: r.endpoint_score,
        // 端点的门槛信息比活动文本更可靠：它来自长期政策声明，
        // 而非从新闻稿里猜出来的 requires_card
        requiresCard: r.endpoint_requires_card == null ? null : Number(r.endpoint_requires_card) === 1,
        cnAccessible: r.endpoint_cn_accessible == null ? null : Number(r.endpoint_cn_accessible) === 1,
        openaiCompatible: r.endpoint_openai_compatible == null ? null : Number(r.endpoint_openai_compatible) === 1,
        claimUrl: r.endpoint_claim_url,
        docsUrl: r.endpoint_docs_url,
      }
      : null,
  };
}

/**
 * 安全解析 JSON 数组字段（capabilities / tags / audience 等）。
 *
 * 存在的理由：这些字段在库中以 JSON 字符串存储，但**不能直接 JSON.parse**
 * —— 老数据可能是裸字符串、也可能是 null。解析失败时返回空数组而不是抛错，
 * 否则单条脏数据会让整个列表接口 500。
 */
export function safeJsonArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

/** 把 models 表行转成前端友好对象 */
export function serializeModel(m, { endpointCount = 0, providerCount = 0 } = {}) {
  const caps = safeJsonArray(m.capabilities);
  return {
    id: m.id,
    slug: m.slug,
    name: m.name,
    vendorSlug: m.vendor_slug,
    capability: m.capability,
    capabilityLabel: CAPABILITY_LABEL[m.capability] || m.capability,
    capabilities: caps.length ? caps : [m.capability],
    capabilityLabels: (caps.length ? caps : [m.capability]).map((c) => CAPABILITY_LABEL[c] || c),
    contextWindow: m.context_window,
    maxOutput: m.max_output,
    isMultimodal: Number(m.is_multimodal) === 1,
    isOpenWeights: Number(m.is_open_weights) === 1,
    description: m.description,
    homepageUrl: m.homepage_url,
    releasedAt: m.released_at,
    endpointCount,
    providerCount,
  };
}

/** 把 endpoints 表行（含 join 出来的厂商/模型信息）转成前端友好对象 */
export function serializeEndpoint(e) {
  return {
    id: e.id,
    slug: e.slug,
    provider: {
      slug: e.provider_slug,
      name: e.provider_name,
      nameEn: e.provider_name_en,
      country: e.country,
      color: e.brand_color,
      website: e.website,
    },
    model: {
      slug: e.model_slug,
      name: e.model_name,
      capability: e.model_capability,
      capabilityLabel: CAPABILITY_LABEL[e.model_capability] || e.model_capability,
      contextWindow: e.model_context_window,
      isOpenWeights: Number(e.model_is_open_weights) === 1,
    },
    quotaKind: e.quota_kind,
    quotaKindLabel: QUOTA_KIND_LABEL[e.quota_kind] || e.quota_kind,
    quotaRpm: e.quota_rpm,
    quotaRpd: e.quota_rpd,
    quotaTpm: e.quota_tpm,
    quotaAmount: e.quota_amount,
    quotaUnit: e.quota_unit,
    quotaText: e.quota_text,
    requiresCard: Number(e.requires_card) === 1,
    requiresSignup: Number(e.requires_signup) === 1,
    requiresPhone: Number(e.requires_phone) === 1,
    cnAccessible: Number(e.cn_accessible) === 1,
    apiBaseUrl: e.api_base_url,
    openaiCompatible: Number(e.openai_compatible) === 1,
    docsUrl: e.docs_url,
    claimUrl: e.claim_url,
    score: e.score,
    scoreSource: e.score_source,
    verifiedAt: e.verified_at,
    // 该端点关联的进行中活动条数（由调用方统计后注入）
    activityCount: e.activity_count ?? 0,
  };
}

/**
 * 把 guides.yaml 的条目（或 DB 行）转成前端友好对象。
 *
 * 段落结构做了双形态归一（前端只认 {title, body}）：
 *   - 手写稿用的是 {heading, items[], body?, code?}（见 guides.yaml 头部注释的骨架）；
 *   - 自动生成稿用的是 {title, body}。
 * 二者的取值**不一致会静默渲染成空标题**（前端读 s.title，而手写稿里叫 heading），
 * 实测整篇手写攻略的 <h2> 全是空白。故在导出层统一：heading→title，
 * items[] → 渲染成 Markdown 无序列表拼进 body，让两类来源共用同一渲染路径。
 */
export function serializeGuide(g) {
  return {
    slug: g.slug,
    title: g.title,
    summary: g.summary || null,
    providerSlug: g.provider_slug || g.provider || null,
    providerName: g.provider_name || null,
    modelSlug: g.model_slug || g.model || null,
    tags: safeJsonArray(g.tags),
    sections: normalizeGuideSections(g.sections),
    publishedAt: g.published_at || null,
    updatedAt: g.updated_at || null,
    confidence: g.confidence ?? null,
    autoGenerated: g.slug ? Boolean(g.source_activity_id) : false,
  };
}

/**
 * 段落归一：把 {heading, items, code} 压成 {title, body}。
 * items 与 body 可能同时存在（手写稿常见），此时 items 作为列表拼在正文之后。
 */
function normalizeGuideSections(sections) {
  if (!Array.isArray(sections)) return [];
  return sections
    .filter((s) => s && typeof s === 'object')
    .map((s) => {
      const title = s.title || s.heading || '';
      const parts = [];
      if (s.body) parts.push(String(s.body));
      if (Array.isArray(s.items) && s.items.length) {
        parts.push(s.items.map((it) => `- ${it}`).join('\n'));
      } else if (typeof s.items === 'string' && s.items) {
        parts.push(s.items);
      }
      if (s.code) parts.push('```\n' + String(s.code).replace(/\n+$/, '') + '\n```');
      return { title, body: parts.join('\n\n') };
    })
    .filter((s) => s.title || s.body);
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
    // 能力分面：让活动列表也能按"这条活动送的是哪类能力"筛选。
    // 计数口径是**活动数**（不是端点数）——这条筛选器作用于活动列表，
    // 与"端点库"页按端点数统计的能力分面是两个不同的口径，不可混用。
    capabilities: CAPABILITY_ORDER.map((c) => ({
      value: c,
      label: CAPABILITY_LABEL[c] || c,
      count: activities.filter((a) => {
        const caps = a.model ? (a.model.capabilities?.length ? a.model.capabilities : [a.model.capability]) : [];
        return caps.includes(c);
      }).length,
    })).filter((c) => c.count > 0),
    sorts: [
      { value: 'ending', label: '即将结束优先' },
      { value: 'newest', label: '最新收录' },
      { value: 'confidence', label: '可信度优先' },
      { value: 'provider', label: '按厂商' },
    ],
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

  // —— 三层结构的模型库与端点库（静态站的数据源）——
  // 静态模式下前端无法查询 API，只能一次性加载全量 JSON 在浏览器内筛选。
  // 端点仅 65 条、模型 55 个，体积可忽略（合计 < 60KB），全量下发完全可行。
  const models = buildModelsData(db);
  const endpoints = buildEndpointsData(db);
  writeJson(path.join(DATA_DIR, 'models.json'), models);
  writeJson(path.join(DATA_DIR, 'endpoints.json'), endpoints);

  // —— 能力分面：三层结构下的"端点/模型"口径 ——
  //
  // ⚠️ 这里极易出错，务必区分两套口径：
  //   · filters.json 的 capabilities —— 计数单位是**活动数**，服务于「活动列表」的侧栏，
  //     语义是"这个能力下有多少个可领的免费机会"。
  //   · capabilities.json —— 计数单位是**端点数/模型数**，服务于「模型库」「端点库」，
  //     必须与被列出的条目数严格一致，否则用户看到 chip 写 7、点进去只有 3 条，
  //     会直接判定"数据算错了"。
  //
  // 早期实现把两处都按端点累加：端点库刚好一致（因为它按端点筛），
  // 但模型库按**模型**筛 → chip 数字对不上，是实打实的显示 bug。
  // 现在从 models/endpoints 两份已构建好的数组反推，天然一致，不可能再漂移。
  const modelCapabilities = CAPABILITY_ORDER.map((c) => {
    const eps = endpoints.filter((e) => e.model.capability === c);
    const mods = models.filter((m) => (m.capabilities?.length ? m.capabilities : [m.capability]).includes(c));
    if (!eps.length && !mods.length) return null;
    return {
      value: c,
      label: CAPABILITY_LABEL[c] || c,
      // count 保持"端点数"口径以兼容既有调用方；两个专用字段才是前端真正该读的
      count: eps.length,
      endpointCount: eps.length,
      modelCount: mods.length,
      // 与能力筛选条上"活动"口径区分开：模型库/端点库各自用上面两个字段
      activityCount: activities.filter((a) => {
        const caps = a.model ? (a.model.capabilities?.length ? a.model.capabilities : [a.model.capability]) : [];
        return caps.includes(c);
      }).length,
      providerCount: new Set(eps.map((e) => e.provider.slug)).size,
    };
  }).filter(Boolean);

  writeJson(path.join(DATA_DIR, 'capabilities.json'), modelCapabilities);

  // 攻略：列表页不需要 sections，列表与详情分开存，
  // 避免列表页白白下载全部正文（攻略正文可达数 KB/篇）
  const guides = loadGuides().map(serializeGuide);
  writeJson(path.join(DATA_DIR, 'guides.json'), guides);

  return {
    activities, providers, stats, filters, meta, models, endpoints,
    capabilities: modelCapabilities, guides,
  };
}

/**
 * 模型库数据（含每个模型有多少个端点、多少家提供方）。
 *
 * 为什么把统计做在导出层而不是前端：静态模式下前端拿到的是扁平 JSON，
 * 若不做预聚合，每个模型卡片都要遍历全部端点算一次（O(n²)）。
 * 这类"关系计数"应在数据生成时一次算清。
 */
export function buildModelsData(db) {
  const counts = new Map();
  for (const r of all(db, `SELECT model_id, COUNT(*) c, COUNT(DISTINCT provider_id) p
                            FROM endpoints WHERE enabled=1 GROUP BY model_id`)) {
    counts.set(r.model_id, { endpoints: r.c, providers: r.p });
  }
  return all(db, `SELECT * FROM models ORDER BY capability, name`).map((m) => {
    const c = counts.get(m.id) || { endpoints: 0, providers: 0 };
    return serializeModel(m, { endpointCount: c.endpoints, providerCount: c.providers });
  });
}

/** 端点库数据（含厂商与模型的 join 信息，以及关联的进行中活动数） */
export function buildEndpointsData(db) {
  const actCounts = new Map();
  for (const r of all(db, `SELECT endpoint_id, COUNT(*) c FROM activities
                            WHERE endpoint_id IS NOT NULL AND archived_at IS NULL
                              AND review_status IN ('auto_ok','approved')
                            GROUP BY endpoint_id`)) {
    actCounts.set(r.endpoint_id, r.c);
  }
  return all(db, `
    SELECT e.*,
           p.slug AS provider_slug, p.name_zh AS provider_name, p.name_en AS provider_name_en,
           p.country, p.brand_color, p.website,
           m.slug AS model_slug, m.name AS model_name, m.capability AS model_capability,
           m.context_window AS model_context_window, m.is_open_weights AS model_is_open_weights
    FROM endpoints e
    JOIN providers p ON p.id = e.provider_id
    JOIN models m    ON m.id = e.model_id
    WHERE e.enabled = 1
    ORDER BY m.capability, p.name_zh
  `).map((e) => serializeEndpoint({ ...e, activity_count: actCounts.get(e.id) || 0 }));
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

export {
  DATA_DIR, CATEGORY_LABEL, AUDIENCE_LABEL, STATUS_LABEL,
  CAPABILITY_LABEL, CAPABILITY_ORDER, QUOTA_KIND_LABEL,
};