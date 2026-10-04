// ============================================================
//  fetch-relays.mjs — 搜罗免费 Token 中转站，产出 public/data/relays.json
//
//  数据源（GitHub 上持续维护的公开目录仓库，多数自带定时探活）：
//    1. panxunying/ai-coding-welfare   data/sites.json + data/live.json
//    2. wynx1123/ai-welfare-hub        data/sites.json + data/live.json
//    3. 1sh1ro/ai-api-zhongzhuan       data/sites.json
//
//  为什么在 Actions 里跑：聚合服务器（国内节点）直连 GitHub 与多数中转站
//  均超时，Actions 的网络没问题。产出为纯静态 JSON：前端直接读，
//  服务器由 workflow 用 scp 推送到 /opt/token-free/public/data/。
//
//  设计要点：
//    - 三家 schema 不同，各自归一化成统一记录；
//    - 按域名去重合并（同一站点在多家都有时，字段互补、来源并列标注）；
//    - 探活结果（online/latency/models/公告/镜像）只叠加，不自行猜测；
//    - 任一源失败不阻断整体（记入 meta.sources 的 ok: false）。
// ============================================================

const SOURCES = [
  { repo: 'panxunying/ai-coding-welfare', branch: 'main', sites: 'data/sites.json', live: 'data/live.json', kind: 'welfare' },
  { repo: 'wynx1123/ai-welfare-hub', branch: 'main', sites: 'data/sites.json', live: 'data/live.json', kind: 'welfare' },
  { repo: '1sh1ro/ai-api-zhongzhuan', branch: 'main', sites: 'data/sites.json', kind: 'zhongzhuan' },
];

const RAW = (repo, branch, path) => `https://raw.githubusercontent.com/${repo}/${branch}/${path}`;

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'token-free-relay-discovery/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return null; } };
const truncate = (s, n = 140) => (s && String(s).length > n ? String(s).slice(0, n - 1) + '…' : (s || null));
const asList = (v) => (Array.isArray(v) ? v : (v != null && v !== '' ? [v] : []));

/** credits → "注册送 $100 · 邀请得 $50 · 每日签到 $25" */
function bonusText(c) {
  if (!c || (c.signup == null && c.invite == null && c.dailyCheckin == null)) return null;
  const unit = c.unit === 'cny' ? '¥' : '$';
  const parts = [];
  if (c.signup != null) parts.push(`注册送 ${unit}${c.signup}${c.approx ? ' 左右' : ''}`);
  if (c.invite != null) parts.push(`邀请得 ${unit}${c.invite}`);
  if (c.dailyCheckin != null) parts.push(`每日签到 ${unit}${c.dailyCheckin}`);
  return parts.join(' · ') || null;
}

/** caveats 可能是字符串或数组，取第一段有效文本 */
function firstText(v, n = 100) {
  if (v == null) return null;
  if (typeof v === 'string') return truncate(v, n);
  const arr = asList(v).map((x) => (typeof x === 'string' ? x : x && x.text)).filter(Boolean);
  return arr.length ? truncate(arr[0], n) : null;
}

/** live.json 兼容多种包装：数组 / {sites:[...]} / {"时间戳":[...]} */
function extractLive(live) {
  if (!live) return [];
  if (Array.isArray(live)) return live;
  if (Array.isArray(live.probes)) return live.probes;
  const arr = Object.values(live).find((v) => Array.isArray(v));
  return arr || [];
}

/** welfare / welfare-hub 两家的 sites.json 结构几乎一致 */
function fromWelfareLike(item, repo) {
  return {
    id: item.id || hostOf(item.homeUrl) || item.name,
    name: item.name,
    subtitle: item.subtitle || null,
    homeUrl: item.homeUrl || null,
    signupUrl: item.signupUrl || null,
    docsUrl: item.docsUrl || null,
    recommended: !!item.recommended,
    bonus: bonusText(item.credits),
    tags: asList(item.tags).slice(0, 6),
    highlights: asList(item.highlights).slice(0, 2),
    caveats: firstText(item.caveats, 100),
    online: null, latencyMs: null, checkedAt: null,
    models: null, modelsCount: 0, modelsNote: null,
    announcement: null, mirror: null,
    source: repo, sources: [repo],
  };
}

function fromZhongzhuan(item, repo) {
  return {
    id: item.id || hostOf(item.homepage) || item.name,
    name: item.name,
    subtitle: truncate(item.summary, 160),
    homeUrl: item.homepage || null,
    signupUrl: item.registrationUrl || null,
    docsUrl: null,
    recommended: false,
    bonus: null,
    tags: asList(item.tags).slice(0, 6),
    statusNote: item.status || null,
    highlights: [],
    caveats: null,
    online: null, latencyMs: null, checkedAt: item.verifiedAt || null,
    models: null, modelsCount: 0, modelsNote: null,
    announcement: null, mirror: null,
    source: repo, sources: [repo],
  };
}

/** 探活结果叠加到记录上（只叠加观测值，不推断） */
function overlayLive(rec, probe) {
  if (!probe) return rec;
  if (typeof probe.online === 'boolean') rec.online = probe.online;
  else if (probe.error) rec.online = false;
  rec.latencyMs = probe.latencyMs ?? rec.latencyMs;
  rec.checkedAt = probe.checkedAt ?? rec.checkedAt;
  if (probe.registerOpen != null) rec.registerOpen = probe.registerOpen;
  if (Array.isArray(probe.loginMethods) && probe.loginMethods.length) rec.loginMethods = probe.loginMethods.slice(0, 4);
  if (probe.checkinEnabled != null) rec.checkinEnabled = probe.checkinEnabled;
  const models = Array.isArray(probe.models) ? probe.models.map((m) => m && m.name).filter(Boolean) : [];
  if (models.length) {
    rec.models = models.slice(0, 8);
    rec.modelsCount = models.length;
  } else if (probe.modelsSource === 'login-required') {
    rec.modelsNote = '模型列表需登录后查看';
  }
  const ann = (Array.isArray(probe.announcements) ? probe.announcements : []).find((a) => a && a.text);
  if (ann) rec.announcement = { date: ann.date || null, text: truncate(ann.text, 130) };
  const mirror = (Array.isArray(probe.mirrors) ? probe.mirrors : []).find((m) => m && m.homeUrl && m.online !== false);
  if (mirror) rec.mirror = mirror.homeUrl;
  return rec;
}

console.log('[relays] 开始抓取社区目录…');
const relays = [];
const srcMeta = [];

for (const src of SOURCES) {
  try {
    const sitesRaw = await fetchJson(RAW(src.repo, src.branch, src.sites));
    const sites = Array.isArray(sitesRaw) ? sitesRaw : (sitesRaw.sites || sitesRaw.stations || []);
    let liveArr = [];
    if (src.live) {
      try {
        liveArr = extractLive(await fetchJson(RAW(src.repo, src.branch, src.live)));
      } catch (e) {
        console.warn(`[relays] ${src.repo} live.json 拉取失败（不影响收录）：${e.message}`);
      }
    }
    const liveById = new Map(liveArr.filter((p) => p && p.id).map((p) => [p.id, p]));

    for (const item of sites) {
      if (!item) continue;
      let rec = src.kind === 'welfare' ? fromWelfareLike(item, src.repo) : fromZhongzhuan(item, src.repo);
      rec = overlayLive(rec, liveById.get(rec.id));
      relays.push(rec);
    }
    srcMeta.push({ repo: src.repo, ok: true, sites: sites.length, live: liveArr.length });
    console.log(`[relays] ${src.repo}: ${sites.length} 站点, ${liveArr.length} 条探活`);
  } catch (e) {
    srcMeta.push({ repo: src.repo, ok: false, error: e.message });
    console.error(`[relays] ${src.repo} 抓取失败：${e.message}`);
  }
}

// ---- 按域名去重合并（字段互补，来源并列标注）----
const byHost = new Map();
for (const rec of relays) {
  const host = hostOf(rec.homeUrl) || rec.id;
  const exist = byHost.get(host);
  if (!exist) { byHost.set(host, rec); continue; }
  exist.sources.push(rec.source);
  if (!exist.bonus && rec.bonus) exist.bonus = rec.bonus;
  if (!exist.subtitle && rec.subtitle) exist.subtitle = rec.subtitle;
  if (!exist.signupUrl && rec.signupUrl) exist.signupUrl = rec.signupUrl;
  if (!exist.docsUrl && rec.docsUrl) exist.docsUrl = rec.docsUrl;
  if (!exist.mirror && rec.mirror) exist.mirror = rec.mirror;
  if (!exist.models && rec.models) { exist.models = rec.models; exist.modelsCount = rec.modelsCount; }
  if (rec.online === true && exist.online !== true) {
    exist.online = true;
    exist.checkedAt = rec.checkedAt || exist.checkedAt;
    exist.latencyMs = exist.latencyMs ?? rec.latencyMs;
  }
  if (!exist.announcement && rec.announcement) exist.announcement = rec.announcement;
  exist.tags = [...new Set([...(exist.tags || []), ...(rec.tags || [])])].slice(0, 6);
}

const merged = [...byHost.values()].sort((a, b) =>
  (b.recommended - a.recommended)
  || ((b.online === true) - (a.online === true))
  || String(a.name).localeCompare(String(b.name), 'zh-CN')
);

const out = {
  generatedAt: new Date().toISOString(),
  meta: {
    total: merged.length,
    online: merged.filter((r) => r.online === true).length,
    offline: merged.filter((r) => r.online === false).length,
    recommended: merged.filter((r) => r.recommended).length,
    sources: srcMeta,
  },
  relays: merged,
};

const outPath = new URL('../public/data/relays.json', import.meta.url);
const { writeFileSync } = await import('node:fs');
writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`[relays] 完成：共 ${merged.length} 个站点（在线 ${out.meta.online}）→ public/data/relays.json`);
