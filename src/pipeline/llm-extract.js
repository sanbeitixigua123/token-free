/**
 * llm-extract.js — LLM 结构化提取适配器（可选增强）
 *
 * 设计：走 OpenAI 兼容的 /chat/completions 接口，因此可对接
 *   Gemini / DeepSeek / 智谱 GLM / 阿里百炼 / Moonshot / OpenAI / 任何兼容网关。
 *
 * 未配置 key 时 enabled=false，本模块被流水线自动跳过，不影响主流程。
 * 凭据来源见 src/lib/config.js 的 applySecrets()：
 *   config/secrets.json（本地，已 gitignore）或环境变量 TOKENFREE_LLM_API_KEY（CI）。
 *
 * 当前配置（2026-10-03 实测）：
 *   baseUrl https://generativelanguage.googleapis.com/v1beta/openai
 *   model   gemini-3.8-flash
 *   ⚠️ 注意：gemini-2.5-flash 对**新用户**已停用（API 返回 404 并提示改用 3.8）。
 *      列在 /v1beta/models 里 ≠ 可调用，必须实际发一次请求验证。
 *
 * 防幻觉三道闸：
 *   1) 提示词强制"只抽原文，缺失返回 null"
 *   2) claim_url 必须逐字来自原文链接列表，且落在厂商域名白名单内
 *   3) 必需字段低置信 → 转人工待审，不直接发布
 */

import { createLogger } from '../lib/logger.js';
import { cleanText, normalizeDate, normalizeUrl } from '../lib/fingerprint.js';

const log = createLogger('llm');

const SYSTEM_PROMPT = `你是一个严谨的信息抽取引擎，专门从网页文本中抽取「AI 厂商免费活动/优惠」信息。

【最重要规则】
1. 只允许抽取文本中【明确出现】的信息。文本没写的，一律返回 null。禁止任何推断、补全或猜测。
2. claim_url 只能逐字复制文本中出现的链接，不允许拼接、改写或猜测域名。找不到就返回 null。
3. source_excerpt 必须是原文的连续片段（用于人工核验），不得改写。
4. 如果这段文本根本不是「免费活动/优惠」（例如公司介绍、招聘、条款），返回 {"isActivity": false}。

【输出】严格输出单个 JSON 对象，不要 markdown 代码块，不要解释。字段：
{
  "isActivity": boolean,
  "title": string|null,            // 活动标题，原文措辞，≤80 字
  "summary": string|null,          // 一句话概括，≤120 字
  "category": "free_credit"|"trial"|"student"|"discount"|"refreshable"|null,
  "benefitKind": "token"|"credit_cny"|"credit_usd"|"duration"|"unlimited"|null,
  "benefitAmount": number|null,    // 归一化数值，如「1亿 Token」→ 100000000；「6元」→ 6
  "benefitUnit": "token"|"CNY"|"USD"|"day"|"month"|null,
  "benefitText": string|null,      // 原文表述，如「每日 1 亿 GLM-5.3-Flash Token」
  "audience": ("all"|"new_user"|"student"|"teacher"|"open_source"|"startup"|"enterprise"|"verified")[],
  "audienceNote": string|null,
  "region": "CN"|"GLOBAL"|null,
  "requiresCard": boolean|null,
  "requiresVerification": "phone"|"student_id"|"identity"|"payment"|"github"|null,
  "startDate": "YYYY-MM-DD"|null,  // 无年份时用参考年份补全
  "endDate": "YYYY-MM-DD"|null,
  "isRecurring": "daily"|"weekly"|"monthly"|null,
  "claimUrl": string|null,
  "sourceExcerpt": string,         // 原文连续片段
  "confidence": number,            // 0~1，你对该条目整体准确性的自评
  "fieldConfidence": {             // 每个关键字段的置信度 0~1
    "title": number, "benefit": number, "dates": number, "claimUrl": number, "audience": number
  }
}`;

/**
 * 调用 LLM 抽取一批候选活动。
 * @param {Array<object>} candidates
 * @param {{provider:object, source:object, refYear:number, settings:object, allowedHosts:string[]}} ctx
 * @returns {Promise<Array<object>>} 抽取结果（已过滤 isActivity=false）
 */
export async function extractWithLLM(candidates, ctx) {
  const { provider, source, refYear, settings, allowedHosts = [] } = ctx;
  const cfg = settings.llm || {};
  if (!cfg.enabled || !cfg.apiKey || !cfg.baseUrl) return [];

  const maxItems = cfg.maxItemsPerSource ?? 15;
  const batch = candidates.slice(0, maxItems);
  const out = [];

  for (const [idx, cand] of batch.entries()) {
    // 逐个调用以保证字段级可控与失败隔离（模型对单条上下文更专注）
    try {
      const userPrompt = buildUserPrompt(cand, provider, source, refYear);
      const raw = await callChat(cfg, SYSTEM_PROMPT, userPrompt);
      const parsed = parseJsonLoose(raw);
      if (!parsed || parsed.isActivity === false) continue;

      const item = postProcess(parsed, { provider, source, refYear, allowedHosts, cand });
      if (item) out.push(item);
    } catch (err) {
      log.warn(`LLM 抽取失败（${provider.slug} #${idx}）`, { err: err.message });
    }
  }
  return out;
}

function buildUserPrompt(cand, provider, source, refYear) {
  return `厂商：${provider.name_zh}（${provider.slug}，国别 ${provider.country}）
来源页面：${source.url}
参考年份（用于补全不带年份的日期）：${refYear}
原文候选链接：${cand.href || '（无）'}

----- 待抽取文本开始 -----
${cand.context}
----- 待抽取文本结束 -----

请按规则输出 JSON。`;
}

async function callChat(cfg, system, user) {
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      max_tokens: 1200,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 60000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LLM HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

/** 容忍模型偶尔裹 markdown 代码块 */
function parseJsonLoose(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** 后处理：链接白名单校验 + 字段归一化 + 低置信标记 */
function postProcess(p, { provider, source, refYear, allowedHosts, cand }) {
  const fc = p.fieldConfidence || {};
  const conf = clamp01(Number(p.confidence ?? 0.5));

  // 闸门 2：claim_url 必须落在允许域名内，否则丢弃该链接
  let claimUrl = null;
  if (p.claimUrl) {
    const host = safeHost(p.claimUrl);
    const ok = allowedHosts.some((h) => host === h || host.endsWith('.' + h)) || host === safeHost(source.url);
    if (ok) claimUrl = normalizeUrl(p.claimUrl);
    else log.warn('LLM 返回了非白名单链接，已丢弃', { url: String(p.claimUrl).slice(0, 80), host });
  }

  // 日期补年份
  const startDate = p.startDate ? normalizeDate(p.startDate, { year: refYear }) : null;
  const endDate = p.endDate ? normalizeDate(p.endDate, { year: refYear }) : null;

  // 闸门 3：必需字段低置信 → 降低整体置信度（交给 validate 判定是否转待审）
  let adj = conf;
  if ((fc.title ?? 1) < 0.6) adj -= 0.25;
  if ((fc.benefit ?? 1) < 0.6) adj -= 0.15;
  if ((fc.claimUrl ?? 1) < 0.6) adj -= 0.15;
  if (!claimUrl) adj -= 0.1; // 无链接的活动可用性差

  const audience = Array.isArray(p.audience) && p.audience.length ? p.audience : ['all'];

  return {
    providerSlug: provider.slug,
    title: cleanText(p.title || cand.title || '').slice(0, 150) || '未命名活动',
    summary: cleanText(p.summary || '').slice(0, 200) || null,
    category: p.category || 'free_credit',
    benefit: p.benefitKind
      ? {
        kind: p.benefitKind,
        amount: Number.isFinite(Number(p.benefitAmount)) ? Number(p.benefitAmount) : null,
        unit: p.benefitUnit || null,
        text: cleanText(p.benefitText || '').slice(0, 80) || null,
      }
      : null,
    audience,
    audienceNote: p.audienceNote || null,
    startDate,
    endDate,
    isRecurring: p.isRecurring || null,
    requiresCard: p.requiresCard === true ? 1 : 0,
    requiresVerification: p.requiresVerification || null,
    claimUrl,
    sourceUrl: source.url,
    sourceExcerpt: cleanText(p.sourceExcerpt || cand.context).slice(0, 500),
    region: p.region || (provider.country === 'CN' ? 'CN' : 'GLOBAL'),
    confidence: Math.round(clamp01(adj) * 100) / 100,
    extractedBy: 'llm',
  };
}

const clamp01 = (n) => Math.max(0, Math.min(1, isFinite(n) ? n : 0.5));
function safeHost(u) {
  try { return new URL(u).host.toLowerCase(); } catch { return ''; }
}

export { SYSTEM_PROMPT };
