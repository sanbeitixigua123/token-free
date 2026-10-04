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
/** 探测的并发合并：首屏可能有多个调用方同时调 detectMode()，
 *  若不合并就会发出重复探测请求。 */
let probing = null;

/**
 * 探测后端可用性。
 *
 * 关键：区分「确认无后端」与「探测失败」。
 * 原实现一旦探测失败就把 mode 永久写成 'static'——若只是后端冷启动慢
 * 或网络抖动，用户会一直停在只读模式直到刷新页面。
 * 现在：探测失败时不写死，允许后续调用重试（最多 3 次）。
 *
 * ⚠️ 探测路径的选择很关键（踩过两次）：
 *
 * 1) 最初用 `/api/stats` —— 但它是**真实数据端点**，首屏 renderHome 也要调它，
 *    两者叠加导致每个页面发 2 次请求。
 *
 * 2) 改用专用的 `/api/ping` —— 解决了叠加问题，但**静态托管上它必然 404**，
 *    而浏览器对任何 4xx/5xx 都会在 console 打一条 "Failed to load resource"。
 *    用户在 DevTools 里看到满屏红色 404，会以为站点坏了。这是无法通过
 *    JS 抑制的（浏览器层面的日志，与 fetch 的 catch 无关）。
 *
 * 3) 最终方案：探测一个**两种模式下都存在**的静态文件（/manifest.webmanifest）。
 *    · 静态站：返回 200 + `application/manifest+json`
 *    · 本地服务：同样返回该静态文件（server.js 的静态文件服务会命中）
 *    两者都是 200，**没有 404，控制台干净**。
 *    再用一个本地服务独有的标记来区分：server.js 会给静态响应加
 *    `x-served-by: token-free-api` 头（见 server.js 的静态文件分支）。
 *    有该头 → api 模式；没有 → static 模式。
 *
 *    这样既不产生 404 噪音，也不与任何真实数据端点冲突，
 *    并且探测的是"有没有本地服务"这一真正想回答的问题。
 */
export async function detectMode() {
  if (state.cached) return state.mode;
  if (location.protocol === 'file:') { state.mode = 'static'; state.cached = true; return state.mode; }

  // 复用进行中的探测，避免同一时刻并发重复请求
  if (probing) return probing;
  probing = (async () => {
    try {
      probeAttempts++;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch('manifest.webmanifest', {
        signal: ctrl.signal,
        cache: 'no-store',
      });
      clearTimeout(timer);

      if (res.ok) {
        // 本地服务会给静态资源打这个头；纯静态托管（GitHub Pages）不会有。
        const byApi = res.headers.get('x-served-by') === 'token-free-api';
        state.mode = byApi ? 'api' : 'static';
        state.cached = true;
        return state.mode;
      }
      // 连静态资源都拿不到（例如路径不对）：保守判定为 static，但不缓存，
      // 允许后续重试 —— 避免把"临时故障"误判成"确定没有后端"。
      state.mode = 'static';
      return state.mode;
    } catch {
      /* 网络异常 / 超时：不缓存结论，允许重试 */
      // 三次探测都失败后，才降级为 static（但允许下次调用继续尝试）
      const fallback = probeAttempts >= 3 ? 'static' : 'api';
      state.mode = state.mode || fallback;
      if (probeAttempts >= 3) state.mode = 'static';
      return state.mode;
    } finally {
      probing = null;
    }
  })();
  return probing;
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
  if (p.has_model === '1') items = items.filter((a) => !!a.model);
  if (p.capability) {
    const set = new Set(String(p.capability).split(','));
    items = items.filter((a) => {
      const caps = a.model ? (a.model.capabilities?.length ? a.model.capabilities : [a.model.capability]) : [];
      return caps.some((c) => set.has(c));
    });
  }

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

// ---------------- 三层结构：模型库 / 端点库 / 攻略 ----------------

/**
 * 模型库。静态模式下在浏览器内完成筛选 —— 与活动列表同一套策略。
 * 模型仅 55 个，全量加载后本地过滤的开销可忽略。
 */
export async function getModels(params = {}) {
  const mode = await detectMode();
  if (mode === 'api') {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== ''))
    );
    return fetchJson(`/api/models?${qs}`);
  }
  const all = await fetchJson('data/models.json');
  return filterModelsLocally(all, params);
}

function filterModelsLocally(all, p) {
  let items = all.slice();
  if (p.capability) {
    const set = new Set(String(p.capability).split(','));
    items = items.filter((m) => (m.capabilities || [m.capability]).some((c) => set.has(c)));
  }
  if (p.vendor) {
    const set = new Set(String(p.vendor).split(','));
    items = items.filter((m) => set.has(m.vendorSlug));
  }
  if (p.q) {
    const kw = String(p.q).trim().toLowerCase();
    if (kw) {
      items = items.filter((m) => [m.name, m.slug, m.description, m.vendorSlug]
        .filter(Boolean).join(' ').toLowerCase().includes(kw));
    }
  }
  if (p.has_endpoint === '1') items = items.filter((m) => m.endpointCount > 0);
  return items;
}

export async function getModel(slug) {
  const mode = await detectMode();
  if (mode === 'api') {
    try {
      return await fetchJson(`/api/models/${encodeURIComponent(slug)}`);
    } catch (err) {
      if (/\b404\b/.test(String(err.message))) return null;
      throw err;
    }
  }
  const [models, endpoints, activities] = await Promise.all([
    fetchJson('data/models.json'),
    fetchJson('data/endpoints.json').catch(() => []),
    fetchJson('data/activities.json').catch(() => []),
  ]);
  const model = models.find((m) => m.slug === slug);
  if (!model) return null;
  const eps = endpoints.filter((e) => e.model.slug === slug);
  return {
    ...model,
    endpoints: eps,
    activities: activities.filter((a) => a.model && a.model.slug === slug),
  };
}

export async function getEndpoints(params = {}) {
  const mode = await detectMode();
  if (mode === 'api') {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== ''))
    );
    return fetchJson(`/api/endpoints?${qs}`);
  }
  const all = await fetchJson('data/endpoints.json');
  return filterEndpointsLocally(all, params);
}

function filterEndpointsLocally(all, p) {
  let items = all.slice();
  if (p.provider) {
    const set = new Set(String(p.provider).split(','));
    items = items.filter((e) => set.has(e.provider.slug));
  }
  if (p.model) {
    const set = new Set(String(p.model).split(','));
    items = items.filter((e) => set.has(e.model.slug));
  }
  if (p.capability) {
    const set = new Set(String(p.capability).split(','));
    items = items.filter((e) => set.has(e.model.capability));
  }
  if (p.no_card === '1') items = items.filter((e) => !e.requiresCard);
  if (p.cn_accessible === '1') items = items.filter((e) => e.cnAccessible);
  if (p.openai_compatible === '1') items = items.filter((e) => e.openaiCompatible);
  if (p.q) {
    const kw = String(p.q).trim().toLowerCase();
    if (kw) {
      items = items.filter((e) => [e.model.name, e.model.slug, e.provider.name, e.quotaText]
        .filter(Boolean).join(' ').toLowerCase().includes(kw));
    }
  }
  // 排序：与后端保持一致的四种口径
  const sorters = {
    score: (a, b) => (b.score ?? -1) - (a.score ?? -1) || a.provider.name.localeCompare(b.provider.name, 'zh'),
    card: (a, b) => (a.requiresCard - b.requiresCard) || a.provider.name.localeCompare(b.provider.name, 'zh'),
    provider: (a, b) => a.provider.name.localeCompare(b.provider.name, 'zh') || a.model.name.localeCompare(b.model.name),
  };
  if (p.sort && sorters[p.sort]) items.sort(sorters[p.sort]);
  return items;
}

export async function getEndpoint(providerSlug, modelSlug) {
  const mode = await detectMode();
  if (mode === 'api') {
    try {
      return await fetchJson(`/api/endpoints/${encodeURIComponent(providerSlug)}/${encodeURIComponent(modelSlug)}`);
    } catch (err) {
      if (/\b404\b/.test(String(err.message))) return null;
      throw err;
    }
  }
  const [endpoints, activities] = await Promise.all([
    fetchJson('data/endpoints.json'),
    fetchJson('data/activities.json').catch(() => []),
  ]);
  const ep = endpoints.find((e) => e.provider.slug === providerSlug && e.model.slug === modelSlug);
  if (!ep) return null;
  return {
    ...ep,
    activities: activities.filter((a) => a.endpoint && a.endpoint.slug === ep.slug),
    alternatives: endpoints.filter((e) => e.model.slug === modelSlug && e.slug !== ep.slug),
  };
}

export async function getCapabilities() {
  try {
    if (await detectMode() === 'api') return fetchJson('/api/capabilities');
  } catch { /* 降级到静态 */ }
  return fetchJson('data/capabilities.json').catch(() => []);
}

/**
 * 能力分面的本地兜底计算。
 *
 * 为什么必须从 models/endpoints 现算而不是只读 capabilities.json：
 * 静态站可能只更新了 models.json（例如增量导出），capabilities.json 会滞后。
 * 现算保证 chip 上的数字与下方实际列出的条目**永远一致** —— 这正是
 * 之前踩过的 bug（chip 写 7、点进去只有 3 条）。数据源不同步时，
 * 一致性比"少算一次"重要得多。
 */
export function deriveCapabilitiesLocally(models, endpoints) {
  const ORDER = [
    'text-generation', 'code-generation', 'image-generation', 'image-understanding',
    'video-generation', 'speech-to-text', 'text-to-speech', 'text-embeddings',
    'translation', 'rerank',
  ];
  const LABEL = {
    'text-generation': '文本生成', 'code-generation': '代码生成',
    'image-generation': '图像生成', 'image-understanding': '图像理解',
    'video-generation': '视频生成', 'speech-to-text': '语音识别',
    'text-to-speech': '语音合成', 'text-embeddings': '文本嵌入',
    'translation': '翻译', 'rerank': '重排序',
  };
  const acc = new Map();
  for (const e of endpoints || []) {
    const c = e.model.capability;
    const cur = acc.get(c) || { eps: 0, providers: new Set() };
    cur.eps++;
    cur.providers.add(e.provider.slug);
    acc.set(c, cur);
  }
  return ORDER.filter((c) => acc.has(c)).map((c) => {
    const v = acc.get(c);
    const mods = (models || []).filter((m) =>
      (m.capabilities?.length ? m.capabilities : [m.capability]).includes(c));
    return {
      value: c,
      label: LABEL[c] || c,
      count: v.eps,
      endpointCount: v.eps,
      modelCount: mods.length,
      activityCount: 0,
      providerCount: v.providers.size,
    };
  });
}

export async function getGuides(params = {}) {
  const mode = await detectMode();
  if (mode === 'api') {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== ''))
    );
    return fetchJson(`/api/guides?${qs}`);
  }
  const all = await fetchJson('data/guides.json').catch(() => []);
  return all.map(({ sections, ...rest }) => rest);
}

export async function getGuide(slug) {
  const mode = await detectMode();
  if (mode === 'api') {
    try {
      return await fetchJson(`/api/guides/${encodeURIComponent(slug)}`);
    } catch (err) {
      if (/\b404\b/.test(String(err.message))) return null;
      throw err;
    }
  }
  const all = await fetchJson('data/guides.json').catch(() => []);
  return all.find((g) => g.slug === slug) || null;
}

export async function getMeta() {
  try {
    return await fetchJson('data/meta.json');
  } catch {
    return null;
  }
}

/**
 * 免费 Token 中转站目录。
 * 数据由 GitHub Actions 定期从社区目录仓库采集合并（见 scripts/fetch-relays.mjs），
 * 两种部署模式下都直接读静态文件 —— 应用侧没有对应 API。
 */
export async function getRelays() {
  try {
    return await fetchJson('data/relays.json');
  } catch {
    return { generatedAt: null, meta: { total: 0, online: 0, offline: 0, recommended: 0, sources: [] }, relays: [] };
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
