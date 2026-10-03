/**
 * search.js — 搜索型数据源的检索器
 *
 * 背景：`providers.yaml` 里长期声明着大量 `kind: search` + `query:` 的源，
 * 但流水线入口对无 url 的源一律 `skipped`，全仓库从未有任何搜索实现，
 * 这些配置从未生效（详见 2026-10-03 的排查记录）。
 *
 * 本模块补上这一环：把 query 变成搜索结果列表，交给既有 discover/extract
 * 流程处理。搜索源的价值在于兜底——厂商没有稳定公告页时，
 * 靠搜索仍能发现发布在媒体、社区、第三方汇总站上的活动。
 *
 * 设计约束：
 *   1) 全程可失败降级：任何异常都返回空数组，绝不阻断主流程
 *   2) 不引入新依赖：直接用内置 fetch，解析 HTML 用 cheerio
 *   3) 引擎可换：通过 settings.search.provider 选择后端
 *   4) 结果必须带真实 URL，供后续域名白名单校验
 */

import { createLogger } from '../lib/logger.js';
import { normalizeUrl } from '../lib/fingerprint.js';

const log = createLogger('search');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * DuckDuckGo Lite 搜索（无需 API key，HTML 端点）。
 * 选它是因为：免费、无需注册、反爬较宽松，适合低频兜底检索。
 *
 * @param {string} query
 * @param {{maxResults:number, timeoutMs:number}} opts
 * @returns {Promise<Array<{title:string, url:string, snippet:string}>>}
 */
async function searchDuckDuckGoLite(query, opts) {
  const { maxResults, timeoutMs } = opts;
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let html;
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) {
      log.warn(`搜索返回非 200：${res.status}`);
      return [];
    }
    html = await res.text();
  } catch (err) {
    log.warn(`搜索请求失败：${err.message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }

  // 反爬识别（2026-10-03 实测）：高频请求后 DDG 会返回 HTTP 202 + 挑战页，
  // 页面体积极小（约 14KB）且**不含任何 result-link**。
  // 若不识别这种情况，会被误判成"该 query 没有结果"，掩盖限流事实。
  // 这里显式区分"被限流"与"确实无结果"，并把限流事件记录下来。
  if (isBotChallenge(html)) {
    log.warn(`搜索被反爬拦截（疑似限流）：${query}`);
    return [];
  }

  return parseDdgLite(html, maxResults);
}

/**
 * 判断响应是否为反爬挑战页。
 * 判据：含 challenge / anomaly / captcha 关键词，或结果容器缺失且体积异常小。
 */
function isBotChallenge(html) {
  if (!html) return false;
  if (/(?:anomaly|challenge|captcha|bot[- ]?detect|unusual traffic)/i.test(html)) return true;
  // 兜底：正常结果页必然含 result-link / result__a 之一
  const hasResults = /class=['"](?:result-link|result__a)['"]/i.test(html);
  return !hasResults && html.length < 20000 && !/<table/i.test(html);
}

/**
 * 解析 DuckDuckGo Lite 的结果表格。
 *
 * 实测踩过的三个坑（2026-10-03）：
 *   1) 属性用**单引号**（class='result-link'），早期按双引号写的正则会全部漏匹配
 *   2) href 是 DDG 的**跳转包装**（//duckduckgo.com/l/?uddg=<URL编码的真实地址>），
 *      必须解出 uddg 参数才是真实站点；早期版本会把真实地址连同包装一起丢掉
 *   3) 因为 (2)，不能简单"含 duckduckgo.com 就跳过"——那会把所有结果都过滤掉。
 *      正确做法是先解包，再看解出的真实域名。
 */
function parseDdgLite(html, maxResults) {
  const out = [];
  // 兼容单/双引号两种写法，避免再次因引号风格变化而漏匹配
  const hrefRe = /href=['"]([^'"]+)['"]/i;
  const snippetRe = /<td[^>]+class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi;

  // 需要连同 <a ...>整段一起取，才能同时拿到 href 与标题
  const tagRe = /<a[^>]+class=['"]result-link['"][^>]*>[\s\S]*?<\/a>/gi;
  const tags = [];
  let m;
  while ((m = tagRe.exec(html)) !== null) tags.push(m[0]);

  const snippets = [];
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push(stripTags(m[1]).trim());
  }

  for (let i = 0; i < tags.length && out.length < maxResults; i++) {
    const raw = tags[i];
    const href = (raw.match(hrefRe) || [])[1];
    if (!href) continue;
    const url = unwrapDdgRedirect(decodeEntities(href));
    if (!url) continue;
    const title = stripTags(raw.replace(/<a[^>]*>/i, '').replace(/<\/a>/i, '')).trim();
    out.push({ title, url, snippet: snippets[i] || '' });
  }
  return out;
}

/**
 * 解开 DuckDuckGo 的跳转包装，返回真实目标 URL。
 * 形如：//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=...
 * 非包装形式则原样返回（需自身已是 http(s)）。
 * 无法确定为真实站点时返回 null，由调用方丢弃。
 */
function unwrapDdgRedirect(href) {
  let candidate = String(href).trim();
  // 协议相对 → 补 https
  if (candidate.startsWith('//')) candidate = 'https:' + candidate;

  try {
    const u = new URL(candidate);
    if (/(^|\.)duckduckgo\.com$/i.test(u.hostname)) {
      const real = u.searchParams.get('uddg');
      if (!real) return null; // 没有 uddg 说明不是结果跳转（可能是广告位）
      candidate = real;
    }
  } catch {
    return null;
  }

  if (!/^https?:\/\//i.test(candidate)) return null;
  return normalizeUrl(candidate);
}

/** 去标签 + 归一空白 */
function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 解码搜索结果里常见的 HTML 实体 */
function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * 对一批 query 执行检索，返回候选链接。
 *
 * @param {string[]} queries
 * @param {object} settings  全局配置（读 settings.search）
 * @returns {Promise<Array<{title,url,snippet,query}>>}
 */
export async function searchCandidates(queries, settings = {}) {
  const cfg = settings.search || {};
  if (cfg.enabled === false) return [];
  const provider = cfg.provider || 'duckduckgo-lite';
  const maxResults = cfg.maxResultsPerQuery ?? 5;
  const timeoutMs = cfg.timeoutMs ?? 15000;
  // 请求间隔：DDG 对连续请求敏感，实测无间隔连发 N 次后立刻被 202 挑战页拦截。
  // 默认 1.5s，宁可慢也不触发反爬（搜索源本就是兜底路径）。
  const delayMs = cfg.delayMs ?? 1500;
  // 连续被拦截达到该次数即判定"本轮搜索不可用"，直接放弃剩余 query，
  // 避免对已被限流的端点做无谓的 38 次重试（既耗时又加重封禁）。
  const maxConsecutiveBlocks = cfg.maxConsecutiveBlocks ?? 3;

  const fn = provider === 'duckduckgo-lite' ? searchDuckDuckGoLite : null;
  if (!fn) {
    log.warn(`未知的搜索后端：${provider}，已跳过搜索源`);
    return [];
  }

  const out = [];
  let consecutiveBlocks = 0;
  let blocked = 0;

  // 串行执行：搜索端点对并发敏感，且搜索源本就是兜底，不追求速度
  for (const q of queries) {
    const rows = await fn(q, { maxResults, timeoutMs });
    log.info(`搜索「${q}」→ ${rows.length} 条`);
    // 无法区分"真无结果"与"被拦截"，用连续零结果近似判断限流。
    // 真无结果的 query 通常不会连续出现 3 次以上。
    consecutiveBlocks = rows.length === 0 ? consecutiveBlocks + 1 : 0;
    for (const r of rows) out.push({ ...r, query: q });

    if (consecutiveBlocks >= maxConsecutiveBlocks) {
      blocked++;
      const rest = queries.length - queries.indexOf(q) - 1;
      log.warn(
        `连续 ${consecutiveBlocks} 次搜索无结果，判定搜索端点不可用，放弃本轮剩余 ${rest} 个 query`
      );
      break;
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  if (blocked) {
    log.warn('本轮搜索源整体降级：搜索端点疑似限流，仅依赖声明式源（pricing/announcement/docs）');
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 把单条搜索结果转成正文块文本，便于复用既有 extractBlocks/discoverCandidates。
 * 搜索结果本身标题+摘要已是很强的活动信号，故直接拼成一段文本喂给候选发现器。
 */
export function searchResultToText(result) {
  return [result.title, result.snippet].filter(Boolean).join('\n');
}
