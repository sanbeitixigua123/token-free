/**
 * discover-urls.js — 用 LLM 发现厂商的免费活动页候选 URL
 *
 * 为什么需要它：
 *   项目长期依赖两类发现手段，两者当前都受限——
 *     1) 声明式配置（providers.yaml 里手写 URL）—— 覆盖有限，且新厂商要人工找
 *     2) 搜索引擎兜底（search.js）—— DuckDuckGo 已实测被反爬封禁（403）
 *   免费额度活动发布在**公告/博客/新闻页**，而这恰恰是最难自动定位的一类页面：
 *   路径五花八门（/blog /news /announcements /changelog /updates ...），
 *   靠模板穷举既慢又会撞上 SPA 的 catch-all 兜底路由（见 probe-sources.js 的教训）。
 *
 *   本模块让 LLM 凭自身对各家厂商的了解**直接给出候选 URL**，绕开搜索引擎。
 *   注意这不是"让模型编造"——所有候选都要经 HTTP 实测验证后才可用
 *   （verifyCandidates），编造出来的 URL 会自然被验证环节淘汰。
 *
 * 安全边界（沿用 llm-extract.js 的防幻觉思路）：
 *   - 只让模型输出 URL 与理由，不允许它在无来源时臆断额度数值
 *   - 所有 URL 必须经真实请求验证，且正文指纹不能与首页雷同（防 catch-all）
 *   - 结果只写报告，不自动改配置 —— 由人复核（与 probe-sources.js 一致）
 *
 * 用法：
 *   node scripts/discover-urls.js                 # 全部厂商
 *   node scripts/discover-urls.js --only-missing   # 只处理当前无 announcement 源的厂商
 *   node scripts/discover-urls.js zhipu groq       # 指定厂商
 */

import { loadProviders, loadSettings } from '../src/lib/config.js';
import { createHash } from 'node:crypto';

const UA = loadSettings().fetch?.userAgent
  || 'TokenFreeBot/1.0 (+https://github.com/sanbeitixigua123/token-free)';
const TIMEOUT_MS = 12000;
const MIN_TEXT_LEN = 400;

const SYSTEM_PROMPT = `你是 AI 行业情报分析助手。任务：给定一个 AI 厂商，列出该厂商**可能发布「免费额度 / 免费试用 / 赠送 token / 学生优惠 / 促销活动」公告的页面 URL**。

【严格要求】
1. 只输出你认为**真实存在**的 URL。不确定就不要输出，宁缺毋滥。
2. 优先输出这类页面：官方博客、新闻中心、公告页、更新日志、活动专题页、开发者文档的 changelog。
3. 不要输出定价页（/pricing）——定价页只说明"怎么收费"，不发布赠送活动，对我们无用。
4. 不要臆造路径。如果你只确定域名、不确定具体路径，就输出你最确定的那个。
5. 必须输出 JSON，不要 markdown 代码块，不要解释。

【输出格式】
{
  "urls": [
    { "url": "https://...", "kind": "announcement", "reason": "官方博客，历史上发布过额度活动", "confidence": 0.9 }
  ]
}
confidence 是你对该 URL 真实存在且与活动相关的自评（0~1）。`;

/**
 * 向 LLM 询问单个厂商的候选 URL。
 * @returns {Promise<Array<{url,kind,reason,confidence}>>}
 */
async function askLLM(provider, cfg) {
  const userPrompt = `厂商名称：${provider.name_zh}${provider.name_en ? ` / ${provider.name_en}` : ''}
厂商标识：${provider.slug}
国别/地区：${provider.country}
官网：${provider.website || '（未知）'}
${provider.pricing_url ? `已知定价页：${provider.pricing_url}` : ''}
${provider.announcement_url ? `已知公告页：${provider.announcement_url}` : ''}

请列出该厂商发布免费额度/赠送活动公告的候选页面 URL。`;

  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      max_tokens: 900,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 60000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LLM HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || '';
  return parseUrls(text);
}

function parseUrls(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s === -1 || e === -1) return [];
  try {
    const obj = JSON.parse(t.slice(s, e + 1));
    return Array.isArray(obj.urls) ? obj.urls.filter((u) => u && u.url) : [];
  } catch {
    return [];
  }
}

// ---------------- 验证（与 probe-sources.js 同一套判据） ----------------

function textOf(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function verifyOne(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, 'Accept': 'text/html' },
    });
    const html = res.ok ? await res.text() : '';
    const text = html ? textOf(html) : '';
    return {
      url, status: res.status, textLen: text.length,
      hash: text ? createHash('sha256').update(text).digest('hex').slice(0, 16) : '',
      ok: res.ok && text.length >= MIN_TEXT_LEN,
    };
  } catch (err) {
    return { url, status: 0, textLen: 0, ok: false, err: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 验证候选 URL 列表，剔除不可达与 catch-all 外壳。
 * 与首页内容雷同的判为 catch-all（SPA 兜底路由）。
 */
async function verifyCandidates(cands, homepage) {
  const homeHash = homepage ? await (async () => {
    const r = await verifyOne(homepage);
    return r.hash;
  })() : '';

  const results = [];
  for (const c of cands) {
    const v = await verifyOne(c.url);
    const isCatchAll = v.hash && (v.hash === homeHash || results.some((x) => x.hash === v.hash));
    results.push({ ...c, ...v, catchAll: isCatchAll, usable: v.ok && !isCatchAll });
    await new Promise((r) => setTimeout(r, 500));
  }
  return results;
}

async function main() {
  const argv = process.argv.slice(2);
  const onlyMissing = argv.includes('--only-missing');
  const filter = argv.filter((a) => !a.startsWith('-'));

  const settings = loadSettings();
  const cfg = settings.llm || {};
  if (!cfg.enabled || !cfg.apiKey || !cfg.baseUrl || !cfg.model) {
    console.error('❌ LLM 未配置完整（需要 enabled / baseUrl / apiKey / model）。');
    console.error('   apiKey 请放到 config/secrets.json，或设环境变量 TOKENFREE_LLM_API_KEY。');
    process.exit(2);
  }

  const all = loadProviders();
  let targets = filter.length ? all.filter((p) => filter.includes(p.slug)) : all;
  if (onlyMissing) {
    targets = targets.filter((p) => !(p.sources || []).some((s) => s.kind === 'announcement' && s.url));
  }

  console.log(`对 ${targets.length} 家厂商询问候选 URL（模型 ${cfg.model}）\n`);

  const report = [];
  for (const p of targets) {
    let cands = [];
    try {
      cands = await askLLM(p, cfg);
    } catch (err) {
      console.log(`[${p.slug}] ❌ 询问失败：${err.message}`);
      report.push({ slug: p.slug, error: err.message });
      continue;
    }

    if (!cands.length) {
      console.log(`[${p.slug}] 模型未给出候选`);
      report.push({ slug: p.slug, candidates: [] });
      continue;
    }

    const verified = await verifyCandidates(cands, p.website);
    const usable = verified.filter((v) => v.usable);
    const tag = usable.length ? `✅ ${usable.length}/${verified.length} 条验证通过` : `❌ ${verified.length} 条候选均未通过`;
    console.log(`[${p.slug}] ${tag}`);
    for (const u of usable) {
      console.log(`    OK  ${u.status}  ${String(u.textLen).padStart(6)}字  ${u.url}   (${u.kind}, LLM置信 ${u.confidence ?? '-'})`);
    }
    for (const v of verified.filter((x) => !x.usable)) {
      const why = v.catchAll ? 'catch-all 外壳' : (v.ok ? '?' : `HTTP ${v.status}${v.err ? ' ' + v.err : ''}`);
      console.log(`    ✗   ${v.url}   [${why}]`);
    }
    console.log('');
    report.push({ slug: p.slug, verified, usable: usable.map((u) => u.url) });
  }

  console.log('\n---- 建议写入 providers.yaml（仅验证通过的） ----');
  for (const r of report) {
    if (!r.usable?.length) continue;
    console.log(`${r.slug}:`);
    for (const u of r.usable) console.log(`  - ${u}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
