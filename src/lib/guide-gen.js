/**
 * guide-gen.js — 攻略自动生成（规则模板，非 LLM）
 *
 * 设计取舍：为什么用规则模板而不是调 LLM？
 *   1) 离线可跑 —— 抓取流水线在 CI/无网环境下也要能产出一份可读草稿；
 *   2) 零成本、无 API Key 依赖 —— 生成 51 家厂商的攻略不该产生任何调用费用；
 *   3) 结果可预测、可 review —— 模板填空的内容边界明确，人工校对只需核对数字，
 *      而 LLM 每次措辞不同、且可能把"客户端额度"幻觉成"有 API Key"（最危险的错误）。
 *   真正的"踩坑经验"仍由手写攻略（config/guides.yaml）承载，自动稿只做第一版骨架。
 *
 * 幂等性保证：slug 由「厂商 slug + 活动 id」派生（auto-{provider}-{activityId}），
 * 同一活动无论生成多少次都是同一个 slug，故重复运行只会覆盖、不会追加。
 * 这里**不**用标题做 slug —— 抓取到的标题常带媒体后缀与日期（实测"…- LINUX DO"），
 * 会随每次抓取变化，用标题做 slug 必然导致重复条目。
 */

import fs from 'node:fs';
import path from 'node:path';
import { all, get, PROJECT_ROOT } from '../db/db.js';
import { parseYaml } from './config.js';

const CONFIG_DIR = path.join(PROJECT_ROOT, 'config');
export const AUTO_GUIDES_FILE = path.join(CONFIG_DIR, 'guides.auto.yaml');

// ---------------- 数值边界处理 ----------------
//
// 活动数据来自网页抽取，字段形态不可控（benefit 可能是对象/字符串/数字，
// confidence 可能是 null）。这里所有取用点都做归一化，**任何脏数据都不能抛错**，
// 否则一条脏活动会让整批生成失败（生成发生在每日流水线里，最怕这种全局崩溃）。

/** 安全转数字；非有限值返回 null（而不是 NaN，NaN 会污染后续比较） */
function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 稳妥取布尔：SQLite 存 0/1，但历史数据里也可能混入 "true"/"1" 字符串 */
function toBool(v) {
  if (v === true || v === 1 || v === '1' || v === 'true') return true;
  if (v === false || v === 0 || v === '0' || v === 'false') return false;
  return null;
}

/** 把可能为 JSON 字符串的数组字段解析成数组（复用 feed.js 同款容错思路） */
function toArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a : [v];
  } catch {
    return [String(v)];
  }
}

/**
 * 额度摘要：把 activity 的 benefit_* 字段压成一句人话。
 *
 * 优先用 benefit_amount/unit 拼（可算出"1 亿 tokens"这种最规范的表达），
 * 缺失时回退到 benefit_text（原文常常最有信息量），再缺失则给兜底文案 ——
 * 三级回退保证标题永远有内容，不会出现"xxx 怎么领："这种断尾标题。
 */
export function formatBenefit(a) {
  const unit = a.benefit_unit || '';
  const amount = toNum(a.benefit_amount);
  const kind = a.benefit_kind || '';

  if (amount != null) {
    if (unit === 'token' || kind === 'token') {
      // 1e8 → "1 亿"，1e4 → "1 万"，与 feed.js 的展示口径保持一致
      if (amount >= 1e8) return `${trimNum(amount / 1e8)} 亿 tokens`;
      if (amount >= 1e4) return `${trimNum(amount / 1e4)} 万 tokens`;
      return `${trimNum(amount)} tokens`;
    }
    if (unit === 'CNY' || kind === 'credit_cny') return `¥${trimNum(amount)}`;
    if (unit === 'USD' || kind === 'credit_usd') return `$${trimNum(amount)}`;
    if (unit === 'day' || unit === 'month') return `${trimNum(amount)} ${unit === 'day' ? '天' : '个月'}`;
    if (unit) return `${trimNum(amount)} ${unit}`;
  }
  // 计数型/纯文本型：原文往往写着"10 个快速克隆音色"，比裸数字强
  if (a.benefit_text) return String(a.benefit_text).slice(0, 40);
  return '免费额度';
}

const trimNum = (n) => (Math.round(n * 100) / 100).toString();

/**
 * 判断额度是否"仅限客户端/IDE 内使用"。
 *
 * 为什么单独抽出来：这是本站最核心的避坑点 —— 领到的 Token 能不能通过 API Key 调，
 * 决定了一条活动对开发者是"有用"还是"没用"。而这一信息**不在结构化字段里**，
 * 只能从 benefit_text / summary / source_excerpt 的措辞里嗅探。
 *
 * ⚠️ 实测坑：最初要求「客户端语境 AND 强限制词」才算命中，结果
 * "DeepSeek Harness 桌面版登录可领 6 元赠金" 这类活动全部漏判 ——
 * 它们含"桌面端/harness"却没有任何"仅限/不提供 API"的字样（抽取到的文本本就不全）。
 * 但对一个**桌面客户端专属**的活动，"登录客户端/桌面端即送"本身就等于额度只在客户端内，
 * 故改为：只要命中客户端专属语境 + 赠送动作，即判定为客户端额度。
 */
export function detectClientOnly(a) {
  const hay = [a.benefit_text, a.summary, a.title, a.source_excerpt]
    .filter(Boolean).join(' ').toLowerCase();
  if (!hay) return false;

  // 客户端/桌面端专属语境：出现这些词，说明额度绑定在某个 App 里
  const clientCtx = /客户端|桌面端|桌面版|desktop|harness|\bide\b|插件内|编辑器内/.test(hay);
  if (!clientCtx) return false;

  // 强限制词：官方明说了不能在外部调 API
  const strongOnly = /仅限|不支持\s*api|不提供\s*api|无\s*api\s*key|没有\s*api\s*key|不能调用|无法调用|只能在.{0,8}内/.test(hay);
  if (strongOnly) return true;

  // 桌面客户端专属赠送动作：登录/注册 + 客户端 的组合，等价于"额度在客户端里"
  const claimInClient = /登录|注册|下载|安装|首次|赠|领/.test(hay);
  return claimInClient;
}

/**
 * 从活动字段推断"关键限制"短语，用于拼标题。
 * 顺序即优先级：先挑对用户最致命的限制（绑卡 > 不能调 API > 国内不可直连 > 限速）。
 */
export function inferKeyLimit(a, ep) {
  const requiresCard = toBool(a.requires_card) ?? toBool(ep?.requires_card) ?? false;
  if (requiresCard) return '需绑定国际信用卡';

  if (detectClientOnly(a)) return '额度仅限客户端内、不给 API Key';

  const cnAccessible = toBool(ep?.cn_accessible ?? a.cn_accessible);
  if (cnAccessible === false) return '国内不可直连';

  const rpm = toNum(ep?.quota_rpm);
  const rpd = toNum(ep?.quota_rpd);
  if (rpm || rpd) {
    const parts = [];
    if (rpm) parts.push(`${rpm}/分钟`);
    if (rpd) parts.push(`${rpd}/天`);
    return `限速 ${parts.join('、')}`;
  }
  return '先到先得，注意有效期';
}

// ---------------- 段落模板 ----------------

/**
 * 生成「核心速览」的 bullet 列表。
 * 这一节是全文信息密度最高的地方，用户多半只看这里，故把关键数字全摆出来。
 */
function buildOverviewBullets(a, prov, model, ep) {
  const b = [];
  const benefit = formatBenefit(a);
  b.push(`**额度**：${benefit}${a.benefit_text && !String(benefit).includes(String(a.benefit_text)) ? `（官方表述：${String(a.benefit_text).slice(0, 60)}）` : ''}`);
  b.push(`**厂商**：${prov?.name || a.provider_name || '未知厂商'}`);
  if (model) {
    const ctx = toNum(model.context_window);
    const cn = ctx ? `，上下文窗口 ${trimNum(ctx / 1000)}K` : '';
    b.push(`**模型**：${model.name}（${model.capability || '通用'}${cn}）`);
  } else {
    b.push('**模型**：本条活动未绑定具体模型，属账户级赠额');
  }
  b.push(`**是否需绑卡**：${((toBool(a.requires_card) ?? toBool(ep?.requires_card)) ? '✅ 需要' : '❌ 不需要')}`);
  b.push(`**国内可直连**：${(toBool(ep?.cn_accessible ?? a.cn_accessible) === false ? '❌ 需要网络方案' : '✅ 可直连')}`);
  if (ep) {
    b.push(`**可否调 API**：${(toBool(ep.openai_compatible) ? 'OpenAI 兼容，改 base_url 即可接入' : '非 OpenAI 兼容，需适配')}`);
  }
  if (a.end_date) b.push(`**截止日期**：${a.end_date}`);
  if (a.start_date) b.push(`**开始日期**：${a.start_date}`);
  return b;
}

/** 「活动规则」正文 */
function buildRuleParagraphs(a, prov, model) {
  const rows = [];
  const desc = (a.summary || a.title || '').trim();
  if (desc) rows.push(`活动要点：${desc}`);
  if (a.audience_note) rows.push(`适用人群：${a.audience_note}`);
  const benefit = formatBenefit(a);
  rows.push(`据抓取到的公开信息，该活动提供的免费额度为 **${benefit}**。`);
  // ⚠️ 必须提醒额度会过期：多数赠额默认 1 个月有效，是本类活动投诉最多的点
  rows.push('额度通常在领取后设有有效期（常见为 1 个月），过期不结转、不作废重发，请领到后尽快消耗。');
  if (model) rows.push(`本活动对应模型 **${model.name}**，如需了解其能力与其它免费提供方，可在「模型库」中查看。`);
  return rows.join('\n\n');
}

/** 「领取流程」bullet */
function buildClaimSteps(a, ep, prov) {
  const steps = [];
  const claimUrl = ep?.claim_url || a.claim_url;
  const docsUrl = ep?.docs_url;
  if (claimUrl) steps.push(`打开活动/领取页：${claimUrl}`);
  if (docsUrl) steps.push(`查阅官方文档确认最新规则：${docsUrl}`);
  steps.push('注册并登录厂商账号（多数需手机号验证码，部分需实名认证）');
  if ((toBool(a.requires_card) ?? toBool(ep?.requires_card))) {
    steps.push('按提示绑定支付方式（此时不会扣费，但需注意下文避坑提示）');
  }
  steps.push('在控制台「费用中心 / 赠额管理」确认额度到账');
  if (ep?.api_base) {
    steps.push(`在代码或客户端中把 Base URL 指向：${ep.api_base}`);
  }
  steps.push('先发一条测试请求验证额度可用，再投入正式开发');
  return steps;
}

/**
 * 「避坑提示」——按条件分支生成，是本文最有价值的一节。
 *
 * 每条提示都对应一类**真实高频失败**：绑卡后忘关自动续费被扣钱、
 * 以为客户端额度能提 API Key、国内直连超时、并发一高就 429。
 * 无条件的提示（如"活动会过期"）只保留一条，避免凑字数降低可信度。
 */
function buildPitfalls(a, ep, prov) {
  const out = [];
  const requiresCard = toBool(a.requires_card) ?? toBool(ep?.requires_card) ?? false;
  const cnAccessible = toBool(ep?.cn_accessible ?? a.cn_accessible);

  if (requiresCard) {
    out.push('⚠️ **绑卡 ≠ 免费**：多数海外厂商在绑卡时默认勾选自动续费，试用额度用尽后会直接扣费。领取后请立刻到账单设置里关闭自动续费/删除支付方式。');
    out.push('⚠️ 部分厂商绑卡时会发起 1 美元小额预授权验证，属正常现象，通常会在数日内自动撤销。');
  }
  if (cnAccessible === false) {
    out.push('⚠️ **国内网络无法直连**：该厂商服务在国内访问会超时。若只是体验，可先用其海外节点；若要长期接入，请自行解决网络，并注意稳定性与合规性。');
  }
  if (detectClientOnly(a)) {
    out.push('⚠️ **最大的坑：额度仅限客户端，不提供外部 API Key**。以为领到的 Token 能通过 API 调进 VSCode / Cline / Continue 的会白忙一场。想接编辑器，请改用该厂商的开放平台账号（另行注册）。');
  }
  const rpm = toNum(ep?.quota_rpm);
  const rpd = toNum(ep?.quota_rpd);
  if (rpm || rpd) {
    out.push(`⚠️ **有频率上限**：${rpm ? `每分钟 ${rpm} 次` : ''}${rpm && rpd ? '、' : ''}${rpd ? `每天 ${rpd} 次` : ''}。批量跑任务时务必串行化并加退避重试，并发一高就会 429。`);
  }
  if (ep && toBool(ep.openai_compatible) === false) {
    out.push('⚠️ 该端点**非 OpenAI 协议兼容**，无法用 OPENAI_BASE_URL 直接切换，需按其私有 SDK 或文档适配。');
  }
  out.push('⚠️ 活动规则随时可能调整，额度的最终解释权归厂商所有；领取前请以官方页面为准。');
  return out;
}

// ---------------- 主流程 ----------------

/**
 * 从数据库挑出「高置信度 + 已发布 + 尚未生成过攻略」的活动，生成草稿。
 *
 * @param {object} db           已打开的数据库连接
 * @param {{minConfidence?:number, limit?:number, existing?:Array}} opts
 *   existing 允许调用方传入"已存在的攻略"以避免重复读盘（批量场景），省一次 IO
 * @returns {{drafts:Array, scanned:number, total:number}}
 */
export function generateGuideDrafts(db, { minConfidence = 0.75, limit = 20, existing = null } = {}) {
  const minConf = toNum(minConfidence);
  const threshold = minConf == null ? 0.75 : minConf;
  const max = Math.max(1, toNum(limit) ?? 20);

  // 只取已发布（auto_ok/approved）且未归档的条目：pending 的内容未经审核，
  // 自动生成攻略再对外发布等于绕过了审核环节。
  // confidence 用 COALESCE 兜底：schema 里该列 NOT NULL DEFAULT 0.5，
  // 但防御性地处理 NULL，避免 SQL 比较遇到 NULL 时整行被静默丢弃。
  const rows = all(db, `
    SELECT * FROM v_activities
    WHERE review_status IN ('auto_ok','approved')
      AND archived_at IS NULL
      AND COALESCE(confidence, 0) >= ?
    ORDER BY confidence DESC, id ASC
    LIMIT ?
  `, [threshold, max]);

  // 已存在的标识：既要避开同 slug，也要避开**同主题**（见下方 topicSeen 注释）。
  // 只判 slug 是不够的 —— 同一活动的多篇报道各自有不同 slug，第一个被生成后，
  // 第二次运行会因为"另一条报道的 slug 尚未出现"而继续补入同主题文章（实测连跑 3 次
  // 每次都多出 1 篇，文件从 4 篇涨到 7 篇）。故把此前生成时记录的主题键也纳入去重。
  const src = existing || loadAutoGuidesRaw();
  const existingSlugs = new Set(src.map((g) => g && g.slug).filter(Boolean));
  const existingTopics = new Set(src.map((g) => g && g.topic_key).filter(Boolean));

  const drafts = [];
  // 批内去重：同一条活动常被多个来源报道（实测 DeepSeek 6 元赠金被 4 家媒体各发一篇，
  // 标题几乎一样）。若逐个生成，攻略列表会出现 4 篇同名文章 —— 对用户是噪音。
  // 故按「厂商 + 额度 + 是否客户端额度」归并，同组只保留 confidence 最高的一条。
  // 归并键会随草稿一起落盘（topic_key），使去重逻辑跨运行仍然成立。
  const topicSeen = new Set();
  for (const a of rows) {
    const prov = get(db, 'SELECT slug, name_zh, cn_accessible FROM providers WHERE id=?', [a.provider_id]);
    const providerSlug = prov?.slug || a.provider_slug || `p${a.provider_id}`;
    // 稳定 slug：厂商 + 活动主键，重复运行结果一致
    const slug = `auto-${providerSlug}-${a.id}`;
    if (existingSlugs.has(slug)) continue;

    // 归并键：同一厂商、同一额度摘要、同一"客户端/API"属性 → 视为同一活动
    const topicKey = `${providerSlug}::${formatBenefit(a)}::${detectClientOnly(a) ? 'client' : 'api'}`;
    if (existingTopics.has(topicKey)) continue; // 该主题此前已生成过
    if (topicSeen.has(topicKey)) continue;     // 本批内重复报道
    topicSeen.add(topicKey);

    // 端点/模型关联可能缺失（账户级普惠活动），必须容错
    const ep = a.endpoint_slug
      ? {
        slug: a.endpoint_slug,
        quota_kind: a.endpoint_quota_kind,
        quota_text: a.endpoint_quota_text,
        quota_rpm: a.endpoint_quota_rpm,
        quota_rpd: a.endpoint_quota_rpd,
        api_base: a.endpoint_api_base,
        requires_card: a.endpoint_requires_card,
        cn_accessible: a.endpoint_cn_accessible,
        openai_compatible: a.endpoint_openai_compatible,
        claim_url: a.endpoint_claim_url,
        docs_url: a.endpoint_docs_url,
      }
      : null;
    const model = a.model_slug
      ? { slug: a.model_slug, name: a.model_name, capability: a.model_capability, context_window: a.model_context_window }
      : null;
    const provider = { slug: providerSlug, name: a.provider_name || prov?.name_zh || providerSlug };

    drafts.push(buildGuide({ a, provider, model, ep, slug, topicKey }));
  }

  return { drafts, scanned: rows.length, total: rows.length };
}

/** 单条活动的模板填空 */
function buildGuide({ a, provider, model, ep, slug, topicKey }) {
  const benefit = formatBenefit(a);
  const keyLimit = inferKeyLimit(a, ep);

  // 标题模板：{厂商} {额度摘要} 怎么领：{关键限制}
  // 用「怎么领」而非「完全指南」，因为自动稿只覆盖规则与流程，
  // 不假装拥有手写稿才有的实测经验，避免标题过度承诺。
  const title = `${provider.name} ${benefit} 怎么领：${keyLimit}`;

  // 摘要：一句话说清"能拿什么 + 最大坑在哪"
  const pit = keyLimit;
  const summary = `${provider.name}现提供 ${benefit} 的免费额度`
    + (model ? `（${model.name}）` : '')
    + `。最大的坑：${pit}。本文拆解活动规则、领取步骤与避坑要点。`;

  const tags = [provider.name];
  if (model) tags.push(model.name);
  const capLabel = { 'text-generation': '文本生成', 'code-generation': '代码生成', 'image-generation': '图像生成', 'video-generation': '视频生成', 'speech-to-text': '语音识别', 'text-to-speech': '语音合成' };
  if (model?.capability) tags.push(capLabel[model.capability] || model.capability);
  tags.push(detectClientOnly(a) ? '客户端额度' : 'API 额度');

  const sections = [
    { title: '核心速览', body: buildOverviewBullets(a, provider, model, ep).map((x) => `- ${x}`).join('\n') },
    { title: '一、活动规则', body: buildRuleParagraphs(a, provider, model) },
    { title: '二、领取流程', body: buildClaimSteps(a, ep, provider).map((x, i) => `${i + 1}. ${x}`).join('\n') },
    { title: '三、避坑提示', body: buildPitfalls(a, ep, provider).map((x) => `- ${x}`).join('\n') },
  ];

  // 来源标注：自动稿必须可溯源，读者能自己复核（与本站"数据可追溯"的定位一致）
  const src = a.source_url || a.claim_url;
  if (src) sections.push({ title: '附：信息来源', body: `本文由规则模板根据公开信息自动生成，原始来源：${src}\n\n> 自动生成的内容可能存在偏差，活动规则请以官方页面为准。` });

  return {
    slug,
    title,
    summary,
    provider: provider.slug,
    model: model?.slug || null,
    tags,
    published_at: (a.created_at || '').slice(0, 10) || beijingTodayStr(),
    // 记住来源活动，便于日后回查/失效清理
    source_activity_id: a.id,
    // 主题键：让"同一活动的多篇报道只生成一篇"这一去重规则能跨运行生效（幂等关键）
    topic_key: topicKey,
    confidence: toNum(a.confidence) ?? null,
    sections,
  };
}

function beijingTodayStr() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// ---------------- YAML 序列化 / 读取 ----------------
//
// 项目刻意不引入 yaml 依赖（见 config.js 顶部注释），因此这里也要自己写序列化。
// 只覆盖生成器实际用到的形态：字符串 / 数字 / null / 字符串数组 / 对象数组（sections）。
// 关键点是**文本转义**：正文含换行、冒号、#、引号，必须用 YAML 双引号块（"..." +
// 转义 \n / \" / \\ ），否则行内的 "：" 会被解析器当成 key 分隔符（实测会把整段 body 截断）。

/** YAML 双引号字符串：转义 \ " 换行 */
function yamlStr(s) {
  const str = String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '');
  return `"${str}"`;
}

/** 值可能是字符串/数字/布尔/null */
function yamlScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return yamlStr(v);
}

/** 把 [{slug, title, ...}] 序列化为本项目极简解析器**能读回**的 YAML */
export function serializeGuidesYaml(guides) {
  const L = [];
  const stamp = new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  L.push('# ============================================================');
  L.push('#  guides.auto.yaml —— 自动生成的攻略草稿');
  L.push('#');
  L.push('#  ⚠️ 本文件由 src/lib/guide-gen.js 自动生成，请勿手工编辑。');
  L.push('#     手写攻略请写 config/guides.yaml（loadGuides 会合并两者，手写优先）。');
  L.push('#     每次生成都会整体重写本文件 —— 这也是幂等性的来源：');
  L.push('#     slug 由活动 id 派生，同一条活动只会有一个条目。');
  L.push(`#  最近生成：${stamp}（北京时间）`);
  L.push(`#  条目数：${guides.length}`);
  L.push('# ============================================================');
  L.push('');
  L.push('guides:');

  for (const g of guides) {
    L.push(`  - slug: ${yamlScalar(g.slug)}`);
    L.push(`    title: ${yamlScalar(g.title)}`);
    L.push(`    summary: ${yamlScalar(g.summary)}`);
    if (g.provider) L.push(`    provider: ${yamlScalar(g.provider)}`);
    if (g.model) L.push(`    model: ${yamlScalar(g.model)}`);
    if (g.tags?.length) L.push(`    tags: [${g.tags.map((t) => yamlScalar(t)).join(', ')}]`);
    if (g.published_at) L.push(`    published_at: ${yamlScalar(g.published_at)}`);
    if (g.source_activity_id != null) L.push(`    source_activity_id: ${yamlScalar(g.source_activity_id)}`);
    if (g.topic_key) L.push(`    topic_key: ${yamlScalar(g.topic_key)}`);
    if (g.confidence != null) L.push(`    confidence: ${yamlScalar(g.confidence)}`);
    L.push('    sections:');
    for (const s of g.sections || []) {
      L.push(`      - title: ${yamlScalar(s.title)}`);
      L.push(`        body: ${yamlScalar(s.body)}`);
    }
  }
  L.push('');
  return L.join('\n');
}

/** 读取 guides.auto.yaml（不用 loadGuides，避免与手写稿合并后互相干扰判断） */
export function loadAutoGuidesRaw() {
  if (!fs.existsSync(AUTO_GUIDES_FILE)) return [];
  try {
    const doc = parseYaml(fs.readFileSync(AUTO_GUIDES_FILE, 'utf8'));
    return Array.isArray(doc.guides) ? doc.guides.filter((g) => g && g.slug && g.title) : [];
  } catch (err) {
    console.warn(`[guide-gen] guides.auto.yaml 解析失败，已忽略：${err.message}`);
    return [];
  }
}

/**
 * 生成并写盘。
 *
 * ⚠️ 幂等策略（重要）：每次都是「已有条目 ∪ 新草稿」整体重写，而不是覆盖或追加。
 *   - 纯追加：每天抓取都会新增重复章节（任务明确要求避免）；
 *   - 纯覆盖：旧活动不再满足 minConfidence 时会被整体丢弃，内容忽有忽无；
 *   - 合并重写：已生成过的稳定保留，新达标的活动增量补入，结果只增不减且不重复。
 * draftOnly=true（--dry）时只计算不写盘。
 */
export function generateAndSave(db, { minConfidence = 0.75, limit = 20, draftOnly = false } = {}) {
  const existing = loadAutoGuidesRaw();
  const { drafts, scanned, total } = generateGuideDrafts(db, { minConfidence, limit, existing });

  // 合并：既有在前（保持稳定顺序），新草稿追加在后
  const merged = [...existing, ...drafts];

  if (!draftOnly) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(AUTO_GUIDES_FILE, serializeGuidesYaml(merged), 'utf8');
  }

  return {
    drafts,          // 本次新增的条数
    existingCount: existing.length,
    total: merged.length,
    scanned,
    candidates: total,
    written: !draftOnly,
    file: AUTO_GUIDES_FILE,
  };
}
