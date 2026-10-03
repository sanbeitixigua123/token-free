/**
 * server.js — 本地 HTTP 服务
 *
 * 能力：
 *   - 静态文件服务（public/）
 *   - REST API（活动/厂商/统计/筛选/抓取日志/审核/订阅）
 *   - RSS feed
 *   - 可选：内置 cron 定时（每天 10:00 北京时间）
 *
 * 启动：node src/server.js   （PORT 环境变量可覆盖，默认 8787）
 *        DEPLOY=1 时绑定 0.0.0.0 并读取 PORT（用于云端托管）
 *
 * 生产部署（2026-10-03 服务器上线前加固）：
 *   写接口（review/crawl/export/退订）需 ADMIN_TOKEN，见 requireAdmin()。
 *   ⚠️ 未设置 ADMIN_TOKEN 时管理接口**直接拒绝**（503），而不是放行——
 *      "忘了配"绝不能退化成"完全敞开"。
 *   ⚠️ 内置 cron 只在单实例下安全；多副本部署须把调度外置，
 *      否则每个副本都会各抓一次（互相触发反爬 + 重复消耗 LLM 配额）。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getDb, all, get, run, PROJECT_ROOT } from './db/db.js';
import { loadSettings, loadGuides } from './lib/config.js';
import { createLogger } from './lib/logger.js';
import { searchActivityIds } from './lib/search.js';
import { runPipeline } from './pipeline/index.js';
import { archiveExpired, reviewActivity } from './pipeline/persist.js';
import { saveSubscription, removeSubscription, getVapidPublicKey } from './notify/push.js';
import { buildRss, writeFeeds } from './notify/feed.js';
import {
  serializeActivity, serializeModel, serializeEndpoint, serializeGuide, safeJsonArray,
  CATEGORY_LABEL, AUDIENCE_LABEL, STATUS_LABEL,
  CAPABILITY_LABEL, CAPABILITY_ORDER,
} from './notify/feed.js';

const log = createLogger('server');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const settings = loadSettings();

const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.DEPLOY === '1' ? '0.0.0.0' : '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/rss+xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

// ---------------- 工具 ----------------

/**
 * 安全响应头（2026-10-03 上线前补齐）。
 * 此前一个都没有——公网裸奔会被点框劫持 / MIME 嗅探。
 *
 * CSP 说明：本站是零构建原生 ES modules，无内联 <script>，故可上较严策略。
 * 但 style-src 必须留 'unsafe-inline'：组件里有内联 style 属性
 * （如 scoreRing 用 CSS 变量写 --v）。收紧前需先改掉这些用法。
 */
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'geolocation=(), microphone=(), camera=()',
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "font-src 'self' data:; connect-src 'self'",
  // HSTS 只在 HTTPS 下有意义；本地 http 加了会被忽略且误导。
  ...(process.env.DEPLOY === '1'
    ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' }
    : {}),
};

/**
 * 管理接口鉴权。
 * 返回 undefined 表示通过；否则返回 true 表示「已发出响应，调用方须 return」。
 */
function requireAdmin(req, res) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    // 关键：未配置 = 禁用，绝不放行
    sendJson(res, {
      error: '服务端未配置 ADMIN_TOKEN，管理接口已禁用。设置环境变量 ADMIN_TOKEN 后重启即可启用。',
    }, 503);
    return true;
  }
  const got = String(req.headers['x-admin-token'] || '');
  // 长度不等时 timingSafeEqual 会抛异常，必须先比长度
  let ok = false;
  if (got.length === expected.length) {
    try {
      ok = crypto.timingSafeEqual(Buffer.from(got, 'utf8'), Buffer.from(expected, 'utf8'));
    } catch { ok = false; }
  }
  if (!ok) {
    log.warn('管理接口鉴权失败', {
      path: req.url,
      ip: req.socket?.remoteAddress,
      ua: String(req.headers['user-agent'] || '').slice(0, 80),
    });
    sendJson(res, { error: '未授权：缺少或错误的 x-admin-token' }, 401);
    return true;
  }
  return undefined;
}

function sendJson(res, data, status = 200, extraHeaders = null) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    ...SECURITY_HEADERS,
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function sendText(res, text, status = 200, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    ...SECURITY_HEADERS,
  });
  res.end(text);
}

function readBody(req, limit = 1024 * 100) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve({ _raw: raw }); }
    });
    req.on('error', reject);
  });
}

function parseQuery(url) {
  const q = {};
  for (const [k, v] of url.searchParams) q[k] = v;
  return q;
}

// ---------------- API 处理器 ----------------

/** GET /api/activities */
function apiActivities(db, q) {
  const page = Math.max(1, parseInt(q.page || '1', 10));
  const pageSize = Math.min(200, Math.max(1, parseInt(q.page_size || '24', 10)));
  const where = [];
  const params = [];

  // 审核状态：默认只返回已通过（auto_ok/approved）
  const includePending = q.include_pending === '1';
  if (!includePending) {
    where.push(`review_status IN ('auto_ok','approved')`);
  }

  if (q.provider) {
    const list = String(q.provider).split(',').filter(Boolean);
    where.push(`provider_slug IN (${list.map(() => '?').join(',')})`);
    params.push(...list);
  }
  if (q.category) {
    const list = String(q.category).split(',').filter(Boolean);
    where.push(`category IN (${list.map(() => '?').join(',')})`);
    params.push(...list);
  }
  if (q.status) {
    const list = String(q.status).split(',').filter(Boolean);
    where.push(`status IN (${list.map(() => '?').join(',')})`);
    params.push(...list);
  }
  if (q.region) {
    if (q.region === 'CN') where.push(`region = 'CN'`);
    else where.push(`region <> 'CN'`);
  }
  if (q.audience) {
    const list = String(q.audience).split(',').filter(Boolean);
    // audience 字段是 JSON 数组字符串，用 LIKE 做包含匹配
    where.push('(' + list.map(() => `audience LIKE ?`).join(' OR ') + ')');
    params.push(...list.map((a) => `%"${a}"%`));
  }
  if (q.no_card === '1') where.push(`requires_card = 0`);
  if (q.ending_soon === '1') where.push(`ending_soon = 1 AND status = 'active'`);
  if (q.is_new === '1') where.push(`is_new = 1`);
  if (q.from) { where.push(`(end_date IS NULL OR date(end_date) >= date(?))`); params.push(q.from); }
  if (q.to) { where.push(`(start_date IS NULL OR date(start_date) <= date(?))`); params.push(q.to); }
  if (q.cn_accessible === '1') where.push(`cn_accessible = 1`);
  // 三层结构：按模型能力筛选活动。
  // 命中可能落在 model_capabilities 数组里（多模态模型），故用 LIKE 匹配 JSON 串；
  // 若活动只关联了主能力（老数据），再由 model_capability 兜底。
  if (q.capability) {
    const list = String(q.capability).split(',').filter(Boolean);
    where.push('(' + list.flatMap(() => [
      `model_capabilities LIKE ?`, `model_capability = ?`,
    ]).join(' OR ') + ')');
    for (const c of list) params.push(`%"${c}"%`, c);
  }
  // 只看已关联到模型的（"送的是哪个模型"）—— 用于区分"模型额度"与"账户级普惠"
  if (q.has_model === '1') where.push('model_id IS NOT NULL');

  // 关键词搜索（FTS + LIKE 双路）
  if (q.q && q.q.trim()) {
    const ids = searchActivityIds(db, q.q.trim());
    if (ids === null || ids.length === 0) {
      return { items: [], total: 0, page, page_size: pageSize, pages: 0, query: q.q };
    }
    where.push(`id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const total = get(db, `SELECT COUNT(*) AS c FROM v_activities ${whereSql}`, params).c;

  // 排序
  let order = `CASE status WHEN 'active' THEN 0 WHEN 'upcoming' THEN 1 ELSE 2 END,
               COALESCE(end_date,'9999-12-31') ASC, id DESC`;
  if (q.sort === 'newest') order = 'created_at DESC, id DESC';
  else if (q.sort === 'confidence') order = 'confidence DESC, id DESC';
  else if (q.sort === 'ending') order = `days_left ASC NULLS LAST, id DESC`;
  else if (q.sort === 'provider') order = 'provider_name ASC, id DESC';

  const rows = all(db,
    `SELECT * FROM v_activities ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize]);

  return {
    items: rows.map(serializeActivity),
    total,
    page,
    page_size: pageSize,
    pages: Math.ceil(total / pageSize),
  };
}

/** GET /api/activities/:id */
function apiActivityDetail(db, id) {
  const row = get(db, 'SELECT * FROM v_activities WHERE id=?', [id]);
  if (!row) return null;
  const activity = serializeActivity(row);

  const history = all(db, `
    SELECT field, old_value, new_value, changed_by, changed_at
    FROM change_history WHERE activity_id=? ORDER BY changed_at DESC, id DESC LIMIT 50
  `, [id]);

  const providerActivities = all(db, `
    SELECT * FROM v_activities
    WHERE provider_id=? AND id<>? AND review_status IN ('auto_ok','approved')
    ORDER BY COALESCE(end_date,'9999-12-31') ASC LIMIT 6
  `, [row.provider_id, id]).map(serializeActivity);

  return { ...activity, history, related: providerActivities };
}

/** GET /api/stats */
function apiStats(db) {
  const rows = all(db, `SELECT * FROM v_activities WHERE review_status IN ('auto_ok','approved')`);
  const byStatus = { active: 0, upcoming: 0, ended: 0 };
  let endingSoon = 0, newToday = 0;
  const byProvider = {}, byCategory = {}, byAudience = {};
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    if (r.ending_soon) endingSoon++;
    if (r.is_new) newToday++;
    byProvider[r.provider_name] = (byProvider[r.provider_name] || 0) + 1;
    byCategory[r.category] = (byCategory[r.category] || 0) + 1;
    let aud = [];
    try { aud = JSON.parse(r.audience); } catch { aud = []; }
    for (const a of aud) byAudience[a] = (byAudience[a] || 0) + 1;
  }
  const lastRun = get(db, `SELECT id, started_at, finished_at, status, sources_total, sources_ok, items_new
                           FROM fetch_runs ORDER BY id DESC LIMIT 1`);
  const pendingCount = get(db, `SELECT COUNT(*) AS c FROM activities WHERE review_status='pending'`).c;
  return {
    total: rows.length, byStatus, endingSoon, newToday,
    byProvider, byCategory, byAudience,
    providerCount: Object.keys(byProvider).length,
    pendingCount, lastRun,
  };
}

/** GET /api/providers */
function apiProviders(db) {
  return all(db, `
    SELECT p.*,
      COUNT(a.id) AS activity_count,
      SUM(CASE WHEN a.status='active' THEN 1 ELSE 0 END) AS active_count,
      MAX(a.updated_at) AS last_activity_at
    FROM providers p
    LEFT JOIN v_activities a ON a.provider_id = p.id
    GROUP BY p.id ORDER BY p.tier, active_count DESC, p.name_zh
  `).map((p) => ({
    id: p.id, slug: p.slug, name: p.name_zh, nameEn: p.name_en, country: p.country,
    website: p.website, pricingUrl: p.pricing_url, announcementUrl: p.announcement_url,
    logoUrl: p.logo_url, color: p.brand_color,
    cnAccessible: Number(p.cn_accessible) === 1, tier: p.tier, active: Number(p.active) === 1,
    activityCount: p.activity_count, activeCount: p.active_count || 0,
    lastActivityAt: p.last_activity_at,
  }));
}

/** GET /api/filters */
function apiFilters(db) {
  const cnt = (sql, ...p) => get(db, sql, p).c;
  const rows = all(db, `SELECT * FROM v_activities WHERE review_status IN ('auto_ok','approved')`);
  const count = (fn) => rows.filter(fn).length;
  return {
    categories: Object.entries(CATEGORY_LABEL)
      .map(([value, label]) => ({ value, label, count: count((r) => r.category === value) }))
      .filter((x) => x.count > 0),
    audiences: Object.entries(AUDIENCE_LABEL)
      .map(([value, label]) => ({
        value, label,
        count: count((r) => { try { return JSON.parse(r.audience).includes(value); } catch { return false; } }),
      }))
      .filter((x) => x.count > 0 || x.value === 'all'),
    statuses: Object.entries(STATUS_LABEL)
      .map(([value, label]) => ({ value, label, count: count((r) => r.status === value) }))
      .filter((x) => x.count > 0),
    regions: [
      { value: 'CN', label: '国内', count: count((r) => r.region === 'CN') },
      { value: 'GLOBAL', label: '海外', count: count((r) => r.region !== 'CN') },
    ].filter((x) => x.count > 0),
    providers: all(db, `
      SELECT p.slug AS value, p.name_zh AS label, COUNT(a.id) AS count
      FROM providers p LEFT JOIN v_activities a ON a.provider_id=p.id
      GROUP BY p.id HAVING count > 0 ORDER BY count DESC
    `),
    // 能力分面（按活动数计），与静态导出的 filters.json 保持同构。
    // 注意：这里计的是**活动数**；端点库页的能力分面计的是**端点数**，
    // 两者口径不同、数值也不同，不要互相参照。
    capabilities: CAPABILITY_ORDER.map((c) => ({
      value: c,
      label: CAPABILITY_LABEL[c] || c,
      count: rows.filter((r) => {
        let caps = [];
        try { caps = r.model_capabilities ? JSON.parse(r.model_capabilities) : []; } catch { caps = []; }
        if (!caps.length && r.model_capability) caps = [r.model_capability];
        return caps.includes(c);
      }).length,
    })).filter((x) => x.count > 0),
    sorts: [
      { value: 'ending', label: '即将结束优先' },
      { value: 'newest', label: '最新收录' },
      { value: 'confidence', label: '可信度优先' },
      { value: 'provider', label: '按厂商' },
    ],
  };
}

/** GET /api/fetch-runs */
function apiFetchRuns(db, q) {
  const limit = Math.min(100, parseInt(q.limit || '30', 10));
  return all(db, `SELECT * FROM fetch_runs ORDER BY id DESC LIMIT ?`, [limit]);
}

/** GET /api/fetch-runs/:id */
function apiFetchRunDetail(db, id) {
  const runRow = get(db, 'SELECT * FROM fetch_runs WHERE id=?', [id]);
  if (!runRow) return null;
  const attempts = all(db, `
    SELECT a.*, s.url AS source_url, s.kind, p.name_zh AS provider_name, p.slug AS provider_slug
    FROM fetch_attempts a
    JOIN sources s ON s.id = a.source_id
    JOIN providers p ON p.id = s.provider_id
    WHERE a.run_id=? ORDER BY p.name_zh, s.url, a.attempt_no
  `, [id]);
  return { ...runRow, attempts };
}

/** GET /api/review-queue */
function apiReviewQueue(db, q) {
  const limit = Math.min(200, parseInt(q.limit || '50', 10));
  return all(db, `
    SELECT * FROM v_activities WHERE review_status='pending'
    ORDER BY confidence DESC, id DESC LIMIT ?
  `, [limit]).map(serializeActivity);
}

// ---------------- 三层结构：模型库 / 端点库 / 能力分面 ----------------

/**
 * GET /api/models
 *
 * 支持筛选：
 *   capability  能力（可多值逗号分隔）
 *   vendor      模型开发方 slug
 *   q           关键词（匹配名称/描述/slug）
 *   has_endpoint=1  只返回有端点（即当前真能拿到免费额度）的模型
 *
 * 默认按能力分组排序，与前端模型库页的展示顺序一致。
 */
function apiModels(db, q) {
  const counts = new Map();
  for (const r of all(db, `SELECT model_id, COUNT(*) c, COUNT(DISTINCT provider_id) p
                            FROM endpoints WHERE enabled=1 GROUP BY model_id`)) {
    counts.set(r.model_id, { endpoints: r.c, providers: r.p });
  }

  let rows = all(db, 'SELECT * FROM models ORDER BY capability, name');

  if (q.capability) {
    const set = new Set(String(q.capability).split(',').filter(Boolean));
    rows = rows.filter((m) => {
      const caps = safeJsonArray(m.capabilities);
      const list = caps.length ? caps : [m.capability];
      return list.some((c) => set.has(c));
    });
  }
  if (q.vendor) {
    const set = new Set(String(q.vendor).split(',').filter(Boolean));
    rows = rows.filter((m) => set.has(m.vendor_slug));
  }
  if (q.q) {
    const kw = String(q.q).trim().toLowerCase();
    rows = rows.filter((m) => [m.name, m.slug, m.description, m.vendor_slug]
      .filter(Boolean).join(' ').toLowerCase().includes(kw));
  }
  if (q.has_endpoint === '1') {
    rows = rows.filter((m) => (counts.get(m.id)?.endpoints || 0) > 0);
  }

  return rows.map((m) => {
    const c = counts.get(m.id) || { endpoints: 0, providers: 0 };
    return serializeModel(m, { endpointCount: c.endpoints, providerCount: c.providers });
  });
}

/** GET /api/models/:slug —— 模型详情（含其全部端点与关联活动） */
function apiModelDetail(db, slug) {
  const m = get(db, 'SELECT * FROM models WHERE slug=?', [slug]);
  if (!m) return null;

  const endpoints = all(db, `
    SELECT e.*,
           p.slug AS provider_slug, p.name_zh AS provider_name, p.name_en AS provider_name_en,
           p.country, p.brand_color, p.website,
           m.slug AS model_slug, m.name AS model_name, m.capability AS model_capability,
           m.context_window AS model_context_window, m.is_open_weights AS model_is_open_weights
    FROM endpoints e
    JOIN providers p ON p.id = e.provider_id
    JOIN models m    ON m.id = e.model_id
    WHERE e.model_id = ? AND e.enabled = 1
    ORDER BY e.requires_card ASC, p.tier, p.name_zh
  `, [m.id]).map(serializeEndpoint);

  const activities = all(db, `
    SELECT * FROM v_activities
    WHERE model_id = ? AND review_status IN ('auto_ok','approved')
    ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'upcoming' THEN 1 ELSE 2 END,
             COALESCE(end_date,'9999-12-31') ASC
  `, [m.id]).map(serializeActivity);

  return {
    ...serializeModel(m, {
      endpointCount: endpoints.length,
      providerCount: new Set(endpoints.map((e) => e.provider.slug)).size,
    }),
    endpoints,
    activities,
  };
}

/**
 * GET /api/endpoints
 *
 * 这是三层结构里最有用的接口 —— 用户真正的问题是
 * "我能在哪儿、用哪个模型、免费拿到多少、要不要绑卡"。
 *
 * 支持筛选：provider / model / capability / no_card / cn_accessible / openai_compatible / q
 */
function apiEndpoints(db, q) {
  const actCounts = new Map();
  for (const r of all(db, `SELECT endpoint_id, COUNT(*) c FROM activities
                            WHERE endpoint_id IS NOT NULL AND archived_at IS NULL
                              AND review_status IN ('auto_ok','approved')
                            GROUP BY endpoint_id`)) {
    actCounts.set(r.endpoint_id, r.c);
  }

  const where = ['e.enabled = 1'];
  const params = [];
  if (q.provider) {
    const list = String(q.provider).split(',').filter(Boolean);
    where.push(`p.slug IN (${list.map(() => '?').join(',')})`);
    params.push(...list);
  }
  if (q.model) {
    const list = String(q.model).split(',').filter(Boolean);
    where.push(`m.slug IN (${list.map(() => '?').join(',')})`);
    params.push(...list);
  }
  if (q.capability) {
    const list = String(q.capability).split(',').filter(Boolean);
    // 能力可能落在 capabilities 数组里（多模态模型），故用 LIKE 匹配 JSON 串
    where.push('(' + list.map(() => `m.capabilities LIKE ?`).join(' OR ') + ')');
    params.push(...list.map((c) => `%"${c}"%`));
  }
  if (q.no_card === '1') where.push('e.requires_card = 0');
  if (q.cn_accessible === '1') where.push('e.cn_accessible = 1');
  if (q.openai_compatible === '1') where.push('e.openai_compatible = 1');
  if (q.q) {
    where.push('(m.name LIKE ? OR m.slug LIKE ? OR p.name_zh LIKE ? OR e.quota_text LIKE ?)');
    const like = `%${q.q}%`;
    params.push(like, like, like, like);
  }

  const order = q.sort === 'score' ? 'e.score DESC NULLS LAST, p.name_zh'
    : q.sort === 'card' ? 'e.requires_card ASC, p.name_zh'
      : q.sort === 'provider' ? 'p.name_zh, m.name'
        : 'm.capability, e.requires_card ASC, p.name_zh';

  return all(db, `
    SELECT e.*,
           p.slug AS provider_slug, p.name_zh AS provider_name, p.name_en AS provider_name_en,
           p.country, p.brand_color, p.website,
           m.slug AS model_slug, m.name AS model_name, m.capability AS model_capability,
           m.context_window AS model_context_window, m.is_open_weights AS model_is_open_weights
    FROM endpoints e
    JOIN providers p ON p.id = e.provider_id
    JOIN models m    ON m.id = e.model_id
    WHERE ${where.join(' AND ')}
    ORDER BY ${order}
  `, params).map((e) => serializeEndpoint({ ...e, activity_count: actCounts.get(e.id) || 0 }));
}

/** GET /api/endpoints/:provider/:model —— 单个端点详情（含关联活动） */
function apiEndpointDetail(db, providerSlug, modelSlug) {
  const e = get(db, `
    SELECT e.*,
           p.slug AS provider_slug, p.name_zh AS provider_name, p.name_en AS provider_name_en,
           p.country, p.brand_color, p.website,
           m.slug AS model_slug, m.name AS model_name, m.capability AS model_capability,
           m.context_window AS model_context_window, m.is_open_weights AS model_is_open_weights
    FROM endpoints e
    JOIN providers p ON p.id = e.provider_id
    JOIN models m    ON m.id = e.model_id
    WHERE p.slug = ? AND m.slug = ?
  `, [providerSlug, modelSlug]);
  if (!e) return null;

  const activities = all(db, `
    SELECT * FROM v_activities
    WHERE endpoint_id = ? AND review_status IN ('auto_ok','approved')
    ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'upcoming' THEN 1 ELSE 2 END,
             COALESCE(end_date,'9999-12-31') ASC
  `, [e.id]).map(serializeActivity);

  // 同一模型的其他提供方 —— 这是"比价"视角：同一个模型还有谁免费给
  const alternatives = all(db, `
    SELECT e.*,
           p.slug AS provider_slug, p.name_zh AS provider_name, p.name_en AS provider_name_en,
           p.country, p.brand_color, p.website,
           m.slug AS model_slug, m.name AS model_name, m.capability AS model_capability,
           m.context_window AS model_context_window, m.is_open_weights AS model_is_open_weights
    FROM endpoints e
    JOIN providers p ON p.id = e.provider_id
    JOIN models m    ON m.id = e.model_id
    WHERE e.model_id = ? AND e.id <> ? AND e.enabled = 1
    ORDER BY e.requires_card ASC, p.name_zh
  `, [e.model_id, e.id]).map(serializeEndpoint);

  return {
    ...serializeEndpoint({ ...e, activity_count: activities.length }),
    activities,
    alternatives,
  };
}

/** GET /api/capabilities —— 能力分面（供前端筛选器） */
/**
 * GET /api/capabilities —— 三层结构下的能力分面
 *
 * ⚠️ 三个计数口径必须同时返回，前端按页面各取所需。混用会造成显示 bug：
 * 模型库按**模型**筛，端点库按**端点**筛，活动列表按**活动**筛。
 * 早期只返回 count（当时语义是端点数），模型库 chip 上的数字就对不上了
 * （chip 写"文本嵌入 7"、点进去只有 3 个模型）。
 *
 * 实现上刻意用**三条独立的按能力聚合查询**，再在 JS 侧按能力合并，
 * 而不是写一条 JOIN 一起算。原因：模型与端点是两套不同的多重关系
 * （端点按 model_id 关联、模型自身又带一个 capabilities 数组），
 * 塞进一条 SQL 会因笛卡尔积而重复计数，且极难验证。
 * 分开查虽然多两次查询，但每个数字都只来自一个明确的集合，可独立核对。
 */
function apiCapabilities(db) {
  // ① 按能力统计端点（一个端点归属一个模型，取模型的 capability 即可，不会重复计数）
  const epRows = all(db, `
    SELECT m.capability AS value,
           COUNT(*) AS endpoint_count,
           COUNT(DISTINCT e.provider_id) AS provider_count
    FROM endpoints e JOIN models m ON m.id = e.model_id
    WHERE e.enabled = 1
    GROUP BY m.capability
  `);
  const epMap = new Map(epRows.map((r) => [r.value, r]));

  // ② 按能力统计模型。
  // 模型的 capabilities 是 JSON 数组（可能一个模型横跨多个能力），
  // SQLite 的 json_each 可以把它展开成多行再计数。
  // 若 json 字段为空/非法，退回该模型自己的 capability 单值。
  const mdRows = all(db, `
    SELECT cap AS value, COUNT(DISTINCT id) AS model_count FROM (
      SELECT m.id AS id, je.value AS cap
      FROM models m, json_each(COALESCE(NULLIF(m.capabilities, ''), '["' || m.capability || '"]')) je
      WHERE m.capability IS NOT NULL
      UNION
      SELECT m.id AS id, m.capability AS cap FROM models m WHERE m.capability IS NOT NULL
    ) GROUP BY cap
  `);
  const mdMap = new Map(mdRows.map((r) => [r.value, r.model_count]));

  // ③ 按能力统计活动。
  // ⚠️ 必须查 v_activities 而非 activities：表上没有 status 列，
  // status 由视图按北京时间实时派生（见 schema.sql 的 CASE 表达式）。
  // 直接写 a.status 会报 no such column: a.status（实测踩过）。
  const actRows = all(db, `
    SELECT cap AS value, COUNT(DISTINCT id) AS c FROM (
      SELECT a.id AS id, je.value AS cap
      FROM v_activities a,
           json_each(COALESCE(NULLIF(a.model_capabilities, ''), '["' || a.model_capability || '"]')) je
      WHERE a.status IN ('active', 'upcoming')
    ) GROUP BY cap
  `);
  const actMap = new Map(actRows.map((r) => [r.value, r.c]));

  const values = new Set([...epMap.keys(), ...mdMap.keys(), ...actMap.keys()]);

  return CAPABILITY_ORDER
    .filter((c) => values.has(c))
    .map((c) => ({
      value: c,
      label: CAPABILITY_LABEL[c] || c,
      count: epMap.get(c)?.endpoint_count ?? 0,   // 兼容旧调用方，语义 = 端点数
      endpointCount: epMap.get(c)?.endpoint_count ?? 0,
      modelCount: mdMap.get(c) ?? 0,
      activityCount: actMap.get(c) ?? 0,
      providerCount: epMap.get(c)?.provider_count ?? 0,
    }));
}

// ---------------- 攻略栏目 ----------------

/** GET /api/guides —— 攻略列表（静态兜底用 config/guides.yaml） */
function apiGuides(db, q) {
  const rows = listGuides(db);
  let out = rows;
  if (q.provider) out = out.filter((g) => g.providerSlug === q.provider);
  if (q.model) out = out.filter((g) => g.modelSlug === q.model);
  if (q.q) {
    const kw = String(q.q).toLowerCase();
    out = out.filter((g) => [g.title, g.summary, (g.tags || []).join(' ')]
      .filter(Boolean).join(' ').toLowerCase().includes(kw));
  }
  // 列表页不需要全文，去掉 sections 以减小响应体积
  return out.map(({ sections, ...rest }) => rest);
}

/** GET /api/guides/:slug */
function apiGuideDetail(db, slug) {
  return listGuides(db).find((g) => g.slug === slug) || null;
}

/**
 * 攻略数据来源：优先 config/guides.yaml（人工/流水线维护），
 * 若不存在则回退到数据库表。这样攻略内容既能声明式维护，
 * 也支持未来由 pipeline 自动生成后落库。
 */
function listGuides(db) {
  const fromYaml = loadGuides();
  if (fromYaml.length) return fromYaml.map(serializeGuide);
  const hasTable = get(db, `SELECT name FROM sqlite_master WHERE type='table' AND name='guides'`);
  if (!hasTable) return [];
  return all(db, 'SELECT * FROM guides ORDER BY published_at DESC, slug').map(serializeGuide);
}

export {
  apiActivities, apiActivityDetail, apiStats, apiProviders, apiFilters,
  apiFetchRuns, apiFetchRunDetail, apiReviewQueue,
  apiModels, apiModelDetail, apiEndpoints, apiEndpointDetail, apiCapabilities,
  apiGuides, apiGuideDetail,
};

// ---------------- 路由 ----------------

async function handleApi(req, res, url) {
  const db = getDb();
  const p = url.pathname;
  const q = parseQuery(url);

  try {
    // 前端的能力探测端点（见 public/js/api.js 的 detectMode）。
    // 之所以单独开一个而不是复用 /api/stats：
    // 静态托管上探测必然 404，浏览器会把 404 记进 console.error，
    // 每个页面都刷一条 "Failed to load resource"，看起来像站点故障。
    // 用一个极轻量的 /api/ping 不影响这一点，但体积几乎为零，
    // 且语义上明确是"探活"而非"取数据"。
    if (req.method === 'GET' && p === '/api/ping') {
      return sendJson(res, { ok: true, service: 'token-free', mode: 'api' });
    }

    // 健康检查：供负载均衡 / 容器编排 / 外部监控探活。
    // 与 /api/ping 的区别：ping 只证明"进程在"，health 还会实际查一次库，
    // 并带上最近抓取时间——因为**抓取失败时服务仍然"活着"但数据是陈旧的**，
    // 只看进程存活的监控形同虚设。
    if (req.method === 'GET' && p === '/api/health') {
      let dbOk = false;
      let dbErr = null;
      try {
        dbOk = get(db, 'SELECT 1 AS ok')?.ok === 1;
      } catch (err) { dbErr = err.message; }
      const lastRun = get(db, 'SELECT started_at, status FROM fetch_runs ORDER BY id DESC LIMIT 1');
      return sendJson(res, {
        ok: dbOk,
        service: 'token-free',
        db: dbOk ? 'ok' : 'error',
        ...(dbErr ? { dbError: dbErr } : {}),
        uptime: Math.round(process.uptime()),
        memMB: Math.round(process.memoryUsage().rss / 1048576),
        lastCrawlAt: lastRun?.started_at || null,
        lastCrawlStatus: lastRun?.status || null,
        cronEnabled: process.env.CRON !== '0',
      }, dbOk ? 200 : 503);
    }
    if (req.method === 'GET' && p === '/api/activities') return sendJson(res, apiActivities(db, q));

    let m;
    if (req.method === 'GET' && (m = p.match(/^\/api\/activities\/(\d+)$/))) {
      const d = apiActivityDetail(db, parseInt(m[1], 10));
      return d ? sendJson(res, d) : sendJson(res, { error: '未找到该活动' }, 404);
    }
    if (req.method === 'GET' && p === '/api/stats') return sendJson(res, apiStats(db));
    if (req.method === 'GET' && p === '/api/providers') return sendJson(res, apiProviders(db));
    if (req.method === 'GET' && p === '/api/filters') return sendJson(res, apiFilters(db));
    if (req.method === 'GET' && p === '/api/fetch-runs') return sendJson(res, apiFetchRuns(db, q));
    if (req.method === 'GET' && (m = p.match(/^\/api\/fetch-runs\/(\d+)$/))) {
      const d = apiFetchRunDetail(db, parseInt(m[1], 10));
      return d ? sendJson(res, d) : sendJson(res, { error: '未找到该批次' }, 404);
    }
    if (req.method === 'GET' && p === '/api/review-queue') return sendJson(res, apiReviewQueue(db, q));

    // —— 三层结构：模型库 / 端点库 / 能力分面 ——
    if (req.method === 'GET' && p === '/api/models') return sendJson(res, apiModels(db, q));
    if (req.method === 'GET' && (m = p.match(/^\/api\/models\/([^/]+)$/))) {
      const d = apiModelDetail(db, decodeURIComponent(m[1]));
      return d ? sendJson(res, d) : sendJson(res, { error: '未找到该模型' }, 404);
    }
    if (req.method === 'GET' && p === '/api/endpoints') return sendJson(res, apiEndpoints(db, q));
    if (req.method === 'GET' && (m = p.match(/^\/api\/endpoints\/([^/]+)\/([^/]+)$/))) {
      const d = apiEndpointDetail(db, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
      return d ? sendJson(res, d) : sendJson(res, { error: '未找到该端点' }, 404);
    }
    if (req.method === 'GET' && p === '/api/capabilities') return sendJson(res, apiCapabilities(db));

    // —— 攻略栏目 ——
    if (req.method === 'GET' && p === '/api/guides') return sendJson(res, apiGuides(db, q));
    if (req.method === 'GET' && (m = p.match(/^\/api\/guides\/([^/]+)$/))) {
      const d = apiGuideDetail(db, decodeURIComponent(m[1]));
      return d ? sendJson(res, d) : sendJson(res, { error: '未找到该攻略' }, 404);
    }

    // 人工审核（写操作：需鉴权）
    if (req.method === 'POST' && (m = p.match(/^\/api\/review\/(\d+)$/))) {
      if (requireAdmin(req, res)) return;
      const body = await readBody(req);
      const id = parseInt(m[1], 10);
      let updated;
      try {
        updated = reviewActivity(db, id, {
          action: body.action, patch: body.patch || null, note: body.note || null,
        });
      } catch (err) {
        // 业务错误（如"活动不存在"）应回 404 而不是 500。
        // 此前这里走到 catch-all 统一返回 500，掩盖了真实的语义。
        if (/不存在|未找到|not found/i.test(err.message)) {
          return sendJson(res, { error: err.message }, 404);
        }
        throw err;
      }
      log.info(`人工审核 #${id} → ${body.action}`);
      return sendJson(res, { ok: true, activity: updated });
    }

    // 手动触发抓取（异步；写操作：需鉴权）
    if (req.method === 'POST' && p === '/api/crawl') {
      if (requireAdmin(req, res)) return;
      const body = await readBody(req).catch(() => ({}));
      log.info('收到手动抓取请求');
      runPipeline({ trigger: 'manual', onlyProvider: body.provider || null })
        .then(async (s) => {
          archiveExpired(db, { afterDays: settings.archive?.afterDays ?? 30 });
          writeFeeds(db, settings);
          log.info(`手动抓取完成：新增 ${s.itemsNew}，更新 ${s.itemsUpdated}`);
        })
        .catch((err) => log.error('手动抓取失败', { err: err.message }));
      return sendJson(res, { ok: true, message: '抓取任务已启动，请稍后刷新查看抓取日志' }, 202);
    }

    // 订阅
    if (req.method === 'POST' && p === '/api/subscribe') {
      const body = await readBody(req);
      const sub = saveSubscription(db, {
        endpoint: body.endpoint, keys: body.keys, filters: body.filters,
        userAgent: req.headers['user-agent'],
      });
      log.info('新增订阅', { id: sub.id });
      return sendJson(res, { ok: true, id: sub.id, message: '订阅成功，有新活动时会收到通知' });
    }
    if (req.method === 'DELETE' && p === '/api/subscribe') {
      // 退订虽是"减操作"，但拿到 endpoint 即可退订他人，故同样需鉴权。
      // 注：用户自行退订走前端本地清除 + 停推即可，不必暴露此接口。
      if (requireAdmin(req, res)) return;
      const body = await readBody(req).catch(() => ({}));
      const endpoint = body.endpoint || q.endpoint;
      if (!endpoint) return sendJson(res, { error: '缺少 endpoint' }, 400);
      const n = removeSubscription(db, endpoint);
      return sendJson(res, { ok: true, removed: n });
    }
    if (req.method === 'GET' && p === '/api/vapid-public-key') {
      return sendJson(res, { publicKey: getVapidPublicKey(db) });
    }
    if (req.method === 'GET' && p === '/api/subscriptions/count') {
      return sendJson(res, { count: get(db, 'SELECT COUNT(*) AS c FROM subscriptions WHERE active=1').c });
    }

    // 导出/feed
    if (req.method === 'GET' && (p === '/feed.xml' || p === '/api/feed.xml')) {
      return sendText(res, buildRss(db, settings), 200, 'application/rss+xml; charset=utf-8');
    }
    if (req.method === 'POST' && p === '/api/export') {
      if (requireAdmin(req, res)) return;
      writeFeeds(db, settings);
      return sendJson(res, { ok: true, message: '已导出静态数据到 public/data/' });
    }

    return sendJson(res, { error: '未知接口', path: p }, 404);
  } catch (err) {
    log.error(`API 异常 ${p}`, { err: err.message });
    return sendJson(res, { error: err.message }, 500);
  }
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  // 防目录穿越
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendText(res, '403 Forbidden', 403);

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA 回退到 index.html（hash 路由下通常不需要，但更稳）
      const fallback = path.join(PUBLIC_DIR, 'index.html');
      if (fs.existsSync(fallback)) {
        res.writeHead(200, { 'content-type': MIME['.html'] });
        return fs.createReadStream(fallback).pipe(res);
      }
      return sendText(res, '404 Not Found', 404);
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      // 标记"由本地服务提供"。前端的能力探测靠这个头区分
      // 「本地完整版」与「纯静态托管」（见 public/js/api.js 的 detectMode）。
      // 用响应头而不是探一个不存在的路径，是为了避免 404 污染浏览器控制台
      // —— 浏览器对任何 4xx 都会打一条 console.error，JS 无法抑制。
      'x-served-by': 'token-free-api',
      ...SECURITY_HEADERS,
    };
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
}

// ---------------- 启动 ----------------

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    return res.end();
  }

  if (url.pathname.startsWith('/api/') || url.pathname === '/feed.xml') {
    return handleApi(req, res, url);
  }
  return serveStatic(req, res, url);
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? `http://0.0.0.0:${PORT}` : `http://localhost:${PORT}`;
  log.info(`Token Free 服务已启动：${shown}`);
  log.info(`  首页      ${shown}/`);
  log.info(`  活动列表  ${shown}/#/activities`);
  log.info(`  RSS       ${shown}/feed.xml`);
  log.info(`  API       ${shown}/api/activities`);
});

// ---------------- 内置定时（可选） ----------------
// 用 CRON=0 关闭内置定时（改用 Windows 任务计划或 WorkBuddy 自动化时）。
if (process.env.CRON !== '0') {
  try {
    const cron = await import('node-cron');
    const expr = settings.cron || '0 10 * * *';
    cron.default.schedule(expr, async () => {
      log.info(`定时任务触发（${expr} ${settings.timezone}）`);
      try {
        const s = await runPipeline({ trigger: 'cron' });
        const db = getDb();
        archiveExpired(db, { afterDays: settings.archive?.afterDays ?? 30 });
        writeFeeds(db, settings);
        const { notifyNewActivities } = await import('./notify/push.js');
        if (s.itemsNew > 0) await notifyNewActivities(db, s.newIds, settings);
        log.info(`定时抓取完成：新增 ${s.itemsNew}`);
      } catch (err) {
        log.error('定时抓取失败', { err: err.message });
      }
    }, { timezone: settings.timezone || 'Asia/Shanghai' });
    log.info(`已注册定时任务：每天 ${expr}（${settings.timezone}）自动抓取`);
  } catch (err) {
    log.warn('定时任务注册失败（不影响服务）', { err: err.message });
  }
}

// ---------------- 优雅关闭 ----------------
//
// 为什么必须有：没有它时 `docker stop` / PM2 reload / 容器滚动更新会直接杀进程。
// 若此刻正在写 SQLite 事务或跑 runPipeline，会留下 WAL 未检查点、
// 孤立的 fetch_runs 记录、以及未释放的文件锁——下次启动可能读到半截状态。
//
// 设计要点：
//   - 幂等：重复信号只处理一次（否则第二次 close 会抛错）
//   - 兜底超时：10s 后强制退出，避免某个连接挂着导致永不退出
//   - uncaughtException 后**必须真的退出**：继续跑一个状态未知的进程更危险，
//     交给守护进程拉起干净的即可。

let shuttingDown = false;

function gracefulShutdown(signal) {
  return () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`收到 ${signal}，开始优雅关闭（等待现有请求结束）`);

    // 兜底：无论如何 10 秒后退出，防止 server.close 挂死
    const forceTimer = setTimeout(() => {
      log.warn('优雅关闭超时，强制退出');
      process.exit(1);
    }, 10_000);
    forceTimer.unref();

    server.close(() => {
      clearTimeout(forceTimer);
      try { getDb().close(); } catch { /* 已关闭则忽略 */ }
      log.info('已关闭 HTTP 服务与数据库连接');
      process.exit(0);
    });
  };
}

process.on('SIGTERM', gracefulShutdown('SIGTERM'));
process.on('SIGINT', gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  log.error('未处理的 Promise 拒绝', { err: String(reason?.stack || reason) });
});

process.on('uncaughtException', (err) => {
  log.error('未捕获异常，准备退出', { err: err.message, stack: err.stack });
  gracefulShutdown('uncaughtException')();
});
