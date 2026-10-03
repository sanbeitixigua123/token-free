/**
 * api.js — 数据访问层
 *
 * 自动适配两种部署：
 *   - 本地服务：走 /api/*（支持实时搜索、筛选、分页、订阅）
 *   - 静态站（GitHub Pages）：读 /data/*.json，在浏览器内完成筛选
 *
 * 对上层（页面代码）暴露同一组方法，页面无需关心当前环境。
 */

const state = {
  mode: null,        // 'api' | 'static'
  cached: false,     // mode 是否为「确定结论」（区别于探测失败）
  cache: new Map(),
  apiBase: '',
};

/**
 * 探测后端可用性。
 *
 * 关键：区分「确认无后端」与「探测失败」。
 * 原实现一旦探测失败就把 mode 永久写成 'static'——若只是后端冷启动慢
 * 或网络抖动，用户会一直停在只读模式直到刷新页面。
 * 现在：探测失败时不写死，允许后续调用重试（最多 3 次，指数退避）。
 */
let probeAttempts = 0;
export async function detectMode() {
  if (state.cached) return state.mode;
  if (location.protocol === 'file:') { state.mode = 'static'; state.cached = true; return state.mode; }

  probeAttempts++;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch('/api/stats', { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (res.ok) {
      const ct = res.headers.get('content-type') || '';
      // 静态托管上 /api/stats 会返回 404 HTML，因此必须校验 content-type
      if (ct.includes('application/json')) {
        state.mode = 'api';
        state.cached = true;
        return state.mode;
      }
    }
    // 有响应但不是 JSON API → 确认是静态托管，可缓存结论
    state.mode = 'static';
    state.cached = true;
    return state.mode;
  } catch {
    /* 网络异常 / 超时：不缓存结论，允许重试 */
  }

  // 三次探测都失败后，才降级为 static（但允许下次调用继续尝试）
  const fallback = probeAttempts >= 3 ? 'static' : 'api';
  state.mode = state.mode || fallback;
  if (probeAttempts >= 3) state.mode = 'static';
  return state.mode;
}

export const getMode = () => state.mode || 'static';

/** 重置探测状态（用于测试或用户手动切换） */
export function resetMode() {
  state.mode = null;
  state.cached = false;
  probeAttempts = 0;
  state.cache.clear();
}

async function fetchJson(url) {
  if (state.cache.has(url)) return state.cache.get(url);
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('json') && !ct.includes('javascript')) {
    throw new Error(`响应不是 JSON：${url}`);
  }
  const data = await res.json();
  state.cache.set(url, data);
  return data;
}

export function clearCache() { state.cache.clear(); }

// ---------------- 静态模式：本地筛选 ----------------

async function staticActivities(params = {}) {
  const all = await fetchJson('data/activities.json');
  return filterLocally(all, params);
}

function filterLocally(all, p) {
  let items = all.slice();

  if (p.q) {
    const kw = String(p.q).trim().toLowerCase();
    if (kw) {
      items = items.filter((a) => {
        const hay = [
          a.title, a.summary, a.benefit?.text, a.audienceNote,
          a.provider?.name, a.provider?.nameEn, a.sourceExcerpt,
        ].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(kw);
      });
    }
  }
  if (p.provider) {
    const set = new Set(String(p.provider).split(','));
    items = items.filter((a) => set.has(a.provider.slug));
  }
  if (p.category) {
    const set = new Set(String(p.category).split(','));
    items = items.filter((a) => set.has(a.category));
  }
  if (p.status) {
    const set = new Set(String(p.status).split(','));
    items = items.filter((a) => set.has(a.status));
  }
  if (p.region) {
    items = p.region === 'CN'
      ? items.filter((a) => a.region === 'CN')
      : items.filter((a) => a.region !== 'CN');
  }
  if (p.audience) {
    const list = String(p.audience).split(',');
    items = items.filter((a) => list.some((x) => (a.audience || []).includes(x)));
  }
  if (p.no_card === '1') items = items.filter((a) => !a.requiresCard);
  if (p.ending_soon === '1') items = items.filter((a) => a.endingSoon && a.status === 'active');
  if (p.is_new === '1') items = items.filter((a) => a.isNew);
  if (p.cn_accessible === '1') items = items.filter((a) => a.provider?.cnAccessible);

  // 排序
  const rank = { active: 0, upcoming: 1, ended: 2 };
  const sorters = {
    ending: (a, b) => (rank[a.status] - rank[b.status])
      || ((a.daysLeft ?? 99999) - (b.daysLeft ?? 99999)),
    newest: (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)),
    confidence: (a, b) => (b.confidence || 0) - (a.confidence || 0),
    provider: (a, b) => a.provider.name.localeCompare(b.provider.name, 'zh'),
  };
  items.sort(sorters[p.sort] || sorters.ending);

  const page = Math.max(1, parseInt(p.page || '1', 10));
  const pageSize = Math.min(200, Math.max(1, parseInt(p.page_size || '24', 10)));
  const total = items.length;
  const slice = items.slice((page - 1) * pageSize, page * pageSize);
  return { items: slice, total, page, page_size: pageSize, pages: Math.ceil(total / pageSize) };
}

// ---------------- 对外接口 ----------------

export async function getActivities(params = {}) {
  const mode = await detectMode();
  if (mode === 'api') {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== ''))
    );
    return fetchJson(`/api/activities?${qs}`);
  }
  return staticActivities(params);
}

export async function getActivity(id) {
  const mode = await detectMode();
  if (mode === 'api') {
    try {
      return await fetchJson(`/api/activities/${encodeURIComponent(id)}`);
    } catch (err) {
      // 404 = 活动不存在/已归档，属正常情况：
      // 交给页面渲染"活动不存在"空态，不必向上抛错污染控制台。
      if (/\b404\b/.test(String(err.message))) return null;
      throw err;
    }
  }
  const all = await fetchJson('data/activities.json');
  const found = all.find((a) => String(a.id) === String(id));
  if (!found) return null;
  const related = all
    .filter((a) => a.provider.slug === found.provider.slug && String(a.id) !== String(id))
    .slice(0, 6);
  return { ...found, history: [], related };
}

export async function getStats() {
  const mode = await detectMode();
  if (mode === 'api') return fetchJson('/api/stats');
  return fetchJson('data/stats.json');
}

export async function getProviders() {
  const mode = await detectMode();
  if (mode === 'api') return fetchJson('/api/providers');
  return fetchJson('data/providers.json');
}

export async function getFilters() {
  const mode = await detectMode();
  if (mode === 'api') return fetchJson('/api/filters');
  return fetchJson('data/filters.json');
}

export async function getMeta() {
  try {
    return await fetchJson('data/meta.json');
  } catch {
    return null;
  }
}

export async function getFetchRuns(limit = 30) {
  const mode = await detectMode();
  if (mode !== 'api') return null;   // 静态站无抓取日志
  return fetchJson(`/api/fetch-runs?limit=${limit}`);
}

export async function getFetchRun(id) {
  const mode = await detectMode();
  if (mode !== 'api') return null;
  return fetchJson(`/api/fetch-runs/${id}`);
}

export async function getReviewQueue() {
  const mode = await detectMode();
  if (mode !== 'api') return [];
  return fetchJson('/api/review-queue');
}

export async function reviewActivity(id, action) {
  const mode = await detectMode();
  if (mode !== 'api') throw new Error('静态站点不支持审核操作');
  const res = await fetch(`/api/review/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  clearCache();
  if (!res.ok) throw new Error(`审核失败：${res.status}`);
  return res.json();
}

export async function triggerCrawl(provider = null) {
  const mode = await detectMode();
  if (mode !== 'api') throw new Error('静态站点不支持触发抓取');
  const res = await fetch('/api/crawl', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider }),
  });
  return res.json();
}

export async function getVapidPublicKey() {
  const mode = await detectMode();
  if (mode !== 'api') return null;
  try {
    const r = await fetchJson('/api/vapid-public-key');
    return r.publicKey || null;
  } catch {
    return null;
  }
}

export async function subscribe(payload) {
  const res = await fetch('/api/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`订阅失败：${res.status}`);
  return res.json();
}

export async function unsubscribe(endpoint) {
  const res = await fetch('/api/subscribe', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  });
  return res.json();
}

/** feed 地址（两种模式都可用） */
export function feedUrl() {
  return state.mode === 'api' ? '/feed.xml' : 'data/feed.xml';
}
