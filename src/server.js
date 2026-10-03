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
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, all, get, run, PROJECT_ROOT } from './db/db.js';
import { loadSettings } from './lib/config.js';
import { createLogger } from './lib/logger.js';
import { searchActivityIds } from './lib/search.js';
import { runPipeline } from './pipeline/index.js';
import { archiveExpired, reviewActivity } from './pipeline/persist.js';
import { saveSubscription, removeSubscription, getVapidPublicKey } from './notify/push.js';
import { buildRss, writeFeeds } from './notify/feed.js';
import { serializeActivity, CATEGORY_LABEL, AUDIENCE_LABEL, STATUS_LABEL } from './notify/feed.js';

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

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

function sendText(res, text, status = 200, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type });
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

export { apiActivities, apiActivityDetail, apiStats, apiProviders, apiFilters, apiFetchRuns, apiFetchRunDetail, apiReviewQueue };

// ---------------- 路由 ----------------

async function handleApi(req, res, url) {
  const db = getDb();
  const p = url.pathname;
  const q = parseQuery(url);

  try {
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

    // 人工审核
    if (req.method === 'POST' && (m = p.match(/^\/api\/review\/(\d+)$/))) {
      const body = await readBody(req);
      const updated = reviewActivity(db, parseInt(m[1], 10), {
        action: body.action, patch: body.patch || null, note: body.note || null,
      });
      log.info(`人工审核 #${m[1]} → ${body.action}`);
      return sendJson(res, { ok: true, activity: updated });
    }

    // 手动触发抓取（异步）
    if (req.method === 'POST' && p === '/api/crawl') {
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
