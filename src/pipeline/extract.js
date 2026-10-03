/**
 * extract.js — 规则提取：从候选上下文里抽出结构化字段
 *
 * 输出字段与 activities 表对齐：
 *   title, summary, category, benefit{kind,amount,unit,text},
 *   audience[], audienceNote, startDate, endDate, isRecurring,
 *   requiresCard, requiresVerification, claimUrl, region, confidence
 *
 * 置信度规则：
 *   起始 0.3
 *   + 命中额度（含数值归一化）    +0.25
 *   + 命中明确起止时间            +0.2
 *   + 命中领取链接（同域）        +0.15
 *   + 命中人群限定                +0.1
 *   + 上下文长度合理（40~800）    +0.05
 *   - 上下文过长 / 噪音词过多     -0.15
 */

import { loadExtractionRules } from '../lib/config.js';
import { cleanText, normalizeDate, normalizeUrl, parseAmount } from '../lib/fingerprint.js';

const RULES = loadExtractionRules();

// ---------------- 单位换算（配置可覆盖） ----------------
const UNIT_MULT = {
  亿: 1e8, 万: 1e4, 千: 1e3,
  k: 1e3, K: 1e3, m: 1e6, M: 1e6, b: 1e9, B: 1e9,
  ...(RULES.units || {}),
};

// ---------------- 类别识别 ----------------
// 顺序即优先级：学生 > 试用 > 折扣 > 免费额度 > 周期刷新
// 说明：'免费额度' 先于 '周期刷新'，因为 "每日发放 1 亿 Token" 本质是额度活动，
//       周期只是它的附加属性（另有 isRecurring 字段表达）。
const CATEGORY_RULES = [
  { cat: 'student', kw: ['学生', '校园', '在校', '学信网', 'edu 邮箱', 'edu邮箱', '.edu', '教育优惠', 'student', 'education'] },
  { cat: 'trial', kw: ['试用', '体验', '免费试用', 'trial', 'free trial', 'pilot'] },
  { cat: 'discount', kw: ['折扣', '半价', '优惠价', '打折', '促销', 'discount', 'off ', 'coupon', '立减'] },
  { cat: 'free_credit', kw: ['赠送', '送', '白嫖', '免费额度', '赠金', '体验金', '代金券', '免费', '发放', '领取', 'credit', 'free', 'giveaway'] },
  { cat: 'refreshable', kw: ['每日', '每月', '每周', '周期性', '刷新', '重置', 'daily', 'monthly', 'weekly', 'renew'] },
];

// ---------------- 人群识别 ----------------
const AUDIENCE_RULES = [
  { a: 'new_user', kw: ['新用户', '首次注册', '新注册', '新客', '首次登录', '注册即送', 'new user', 'new account', 'sign up'] },
  { a: 'student', kw: ['学生', '校园', '在校', '学信网', 'edu 邮箱', 'edu邮箱', '.edu', 'student'] },
  { a: 'teacher', kw: ['教师', '老师', '教职工', 'teacher', 'educator', 'faculty'] },
  { a: 'open_source', kw: ['开源', '维护者', 'maintainer', 'open source'] },
  { a: 'startup', kw: ['初创', '创业', '创业公司', 'startup'] },
  { a: 'enterprise', kw: ['企业', '团队版', 'enterprise', 'business'] },
  { a: 'verified', kw: ['实名', '实名认证', '实名制', '绑卡', 'verification', 'verify'] },
];

const CARD_KW = ['信用卡', '绑卡', '需要银行卡', 'credit card', 'visa', 'mastercard', '需绑定支付'];
const NO_CARD_KW = ['无需绑卡', '不用绑卡', '无需信用卡', 'no credit card', 'without credit card'];

const RECURRING_RULES = [
  { r: 'daily', kw: ['每日', '每天', 'daily', 'every day'] },
  { r: 'weekly', kw: ['每周', 'weekly'] },
  { r: 'monthly', kw: ['每月', 'monthly'] },
];

// ---------------- 额度提取 ----------------
// 注意顺序：Token 类在前（更具体）；「N 元赠金」这类能被 CNY 规则命中。
// 每条规则的 multGroup 指明单位落在哪个捕获组，由 resolveAmount 统一换算。
//
// 关键点：额度与单位词之间常夹着型号名，例如
//   "1亿 GLM-5.3-Flash Token" / "500 万 tokens" / "100 万 Qwen-Max 词元"
// 因此允许中间出现一段「不含标点、长度有限」的型号描述。
const MODEL_NAME = '[A-Za-z0-9][A-Za-z0-9\\.\\-_/]{0,30}(?:\\s+[A-Za-z0-9][A-Za-z0-9\\.\\-_/]{0,30}){0,2}\\s*';
const BENEFIT_PATTERNS = [
  // 1 亿 Token / 1亿 GLM-5.3-Flash Token / 100 万 tokens / 1M tokens
  {
    re: new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(亿|万|千|k|K|m|M|b|B)?\\s*(?:个)?\\s*(?:${MODEL_NAME})?(?:token|tokens|Token|TOKEN|词元)`),
    kind: 'token', unit: 'token', multGroup: 2,
  },
  // ¥6 / ￥2000 / RMB 500
  { re: /(?:¥|￥|RMB\s*)\s*(\d+(?:\.\d+)?)\s*(亿|万|千)?/, kind: 'credit_cny', unit: 'CNY', multGroup: 2 },
  // 6 元 / 6块钱 / 2000 元人民币
  { re: /(\d+(?:\.\d+)?)\s*(亿|万|千)?\s*(?:元|块钱|人民币)/, kind: 'credit_cny', unit: 'CNY', multGroup: 2 },
  // $5 / $5,000 / $5M
  { re: /\$\s*(\d+(?:\.\d+)?)\s*(k|K|m|M|b|B)?/, kind: 'credit_usd', unit: 'USD', multGroup: 2 },
  // 5 美元 / 5 USD
  { re: /(\d+(?:\.\d+)?)\s*(k|K|m|M|b|B)?\s*(?:美元|美金|USD)/i, kind: 'credit_usd', unit: 'USD', multGroup: 2 },
  // 30 天免费
  { re: /(\d+)\s*(?:天|日)\s*(?:免费|试用|体验)/, kind: 'duration', unit: 'day', multGroup: null },
  // 1 个月免费
  { re: /(\d+)\s*个?\s*月\s*(?:免费|试用|体验)/, kind: 'duration', unit: 'month', multGroup: null },
  // 通用计数型赠送：赠送 10 个快速克隆音色 / 送 5 个席位 / 赠 1000 次调用 / 赠送 3 张券
  // 放在最后作为兜底，避免抢走前面更具体规则（token/货币）的匹配。
  {
    re: /(?:赠送|送出|赠|送)\s*(\d+(?:\.\d+)?)\s*(亿|万|千)?\s*(?:个|张|次|条|份|名|位|台|套)?\s*([^\s，。；、,;!?！？]{2,12})/,
    kind: 'count', unit: 'count', multGroup: 2,
  },
];

/** 用规则的 multGroup 从匹配结果统一换算数值 */
function resolveAmount(match, rule) {
  const base = parseFloat(match[1]);
  if (!isFinite(base) || base <= 0) return null;
  const prefix = rule.multGroup ? match[rule.multGroup] : null;
  const mult = prefix ? (UNIT_MULT[prefix] || 1) : 1;
  return base * mult;
}

// ---------------- 时间提取 ----------------
function extractDates(text, refYear) {
  const t = cleanText(text);
  let start = null, end = null;

  // 1) 明确区间：9/28-10/7、2026-09-28 至 2026-10-07、9月28日至10月7日
  const rangeRe = /(\d{4}[-/年])?\s*(\d{1,2})[-/月]\s*(\d{1,2})日?\s*[-–—~至到]{1,2}\s*(\d{4}[-/年])?\s*(\d{1,2})[-/月]\s*(\d{1,2})日?/;
  const rm = t.match(rangeRe);
  if (rm) {
    const y1 = rm[1] ? rm[1].replace(/[-/年]/g, '') : refYear;
    const y2 = rm[4] ? rm[4].replace(/[-/年]/g, '') : (rm[1] ? y1 : refYear);
    start = normalizeDate(`${y1}-${rm[2]}-${rm[3]}`);
    end = normalizeDate(`${y2}-${rm[5]}-${rm[6]}`);
    // 跨年修正（如 12/20-1/5）
    if (start && end && end < start) end = normalizeDate(`${parseInt(y2, 10) + 1}-${rm[5]}-${rm[6]}`);
  }

  // 2) 只有截止：截至 10/7、至10月7日、10月7日截止、有效期至...、用到 10/6
  if (!end) {
    const endRe =
      /(?:截至|截止到?|有效期至|用到|持续到|活动时间?至|至|到|by|until|ends?|valid\s+until)\s*(\d{4}[-/年])?\s*(\d{1,2})[-/月]\s*(\d{1,2})日?/;
    const em = t.match(endRe);
    if (em) end = normalizeDate(`${em[1] ? em[1].replace(/[-/年]/g, '') : refYear}-${em[2]}-${em[3]}`);
  }
  // 2b) 兜底：句中任何 mm/dd 或 m月d日 视作截止日（歧义时取较晚者）
  if (!end) {
    const all = [...t.matchAll(/(?:^|[^\d])(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*日?/g)]
      .map((m) => normalizeDate(`${refYear}-${m[1]}-${m[2]}`))
      .filter(Boolean)
      .sort();
    if (all.length) end = all[all.length - 1];
  }
  // 2c) 纯斜杠日期兜底：10/6
  if (!end) {
    const m = t.match(/(?:^|[^\d])(\d{1,2})\/(\d{1,2})(?![\d\/])/);
    if (m) end = normalizeDate(`${refYear}-${m[1]}-${m[2]}`);
  }
  if (!start) {
    const startRe = /(?:自|从|即日起|开始于|from|starts?)\s*(\d{4}[-/年])?\s*(\d{1,2})[-/月]\s*(\d{1,2})日?/;
    const sm = t.match(startRe);
    if (sm) start = normalizeDate(`${sm[1] ? sm[1].replace(/[-/年]/g, '') : refYear}-${sm[2]}-${sm[3]}`);
  }

  return { start, end };
}

// ---------------- 标题修复 ----------------

/**
 * 当候选块自带的标题不可用时，从上下文中"提拔"出真正的活动标题。
 *
 * 背景（真实缺陷）：百度千帆页面的候选块 heading 落在导航项"平台操作"上，
 * 而真正的活动句"当前新用户注册…即送20元代金券"躺在正文里。
 * 腾讯混元同理，标题被截成半句条款。
 *
 * 策略（按优先级）：
 *   1) 上下文里含"赠送/免费/送"且含额度数值的最短句子
 *   2) 含"注册/新用户 + 送/赠"的句子
 *   3) 兜底：第一句足够长且不以句读结尾的句子
 */
const PROMOTE_GIFT_RE = /(?:赠送|送出|赠金|体验金|代金券|免费额度|免费试用|注册即送|白嫖|免费领取|即送|可领|领取)/;
const PROMOTE_AMOUNT_RE = /\d[\d,.]*\s*(?:亿|万|千|百|k|K|M)?\s*(?:个)?\s*(?:tokens?|token|Token|TOKEN|元|美元|次|条|字符)|\d+\s*折/;

/**
 * 标题清洗：去掉从抓取块首尾带进来的技术性噪音。
 *
 * 典型场景（MiniMax）：块文本把接口规格和活动拼在一起 ——
 *   "支持 T2A v2 / T2A async v2 接口RPM：60支持 HD 系列模型赠送 10 个快速克隆音色"
 * 真正有意义的标题应从"赠送/送"这个动作所在的小句开始。
 */
export function cleanTitle(raw, isBadTitle) {
  let t = cleanText(raw || '');
  if (!t) return t;

  // 若标题里出现"赠送/送/免费领取"等动作词，且动作词之前有较长的技术前缀，
  // 则截取动作词所在的小句起点。
  // 注意：仅当"动作词之前的那段"看起来是技术规格（含接口/RPM/参数等）时才裁剪，
  // 否则会把"当前新用户注册…即送20元代金券"这类完整句子切坏。
  const GIFT_START = /(?:赠送|送出|免费领取|注册即送|即送|领取|白送|赠)/;
  const gi = t.search(GIFT_START);
  if (gi > 8) {
    const head = t.slice(0, gi);
    // 前缀含技术规格标记才认定是噪音
    const looksTechnical = /(?:接口|RPM|QPS|API|v\d|异步|同步|频率|限制|参数|协议|HTTP|SDK)/i.test(head);
    if (looksTechnical) {
      const cut = Math.max(
        head.lastIndexOf('支持'),
        head.lastIndexOf('接口'),
        head.lastIndexOf('：'),
        head.lastIndexOf(':'),
        head.lastIndexOf('，'),
        head.lastIndexOf('、'),
        head.lastIndexOf('/'),
      );
      if (cut >= 0) {
        const candidate = cleanText(t.slice(cut).replace(/^(?:支持|接口|：|:|，|、|\/|\s)+/, ''));
        // 切完必须仍是"像标题"的字符串，且比原串更短
        if (candidate.length >= 6 && candidate.length < t.length && isBadTitle(candidate).ok) {
          t = candidate;
        }
      }
    }
  }

  // 去掉首尾的序号/项目符号
  t = t.replace(/^[\s\-–—•·]+/, '').replace(/[\s\-–—•·]+$/, '');
  // 去掉尾部的孤立句号（"100万 tokens。" → "100万 tokens"）
  t = t.replace(/[。．.]+$/, '');
  // 去掉末尾的展开链接文字（"Usage creditsMore information" → "Usage credits"）
  t = t.replace(/(?:More\s+information|Learn\s+more|Read\s+more|了解更多|查看详情|更多信息|详情)\s*$/i, '').trim();
  // 去掉首尾残留的标点
  t = t.replace(/^[，、,;；]+/, '').replace(/[，、,;；]+$/, '');

  return t;
}

export function promoteTitle(candidateTitle, context, isBadTitle) {
  // 原标题可用 → 直接用（保留"干净标题"的语义）
  if (candidateTitle && isBadTitle(candidateTitle).ok) return candidateTitle;

  const sentences = String(context || '')
    .split(/\n+|(?<=[。！？；])/)
    .map((s) => cleanText(s))
    .filter((s) => s.length >= 6 && s.length <= 80);

  const scored = sentences.map((s, idx) => {
    let sc = 0;
    if (PROMOTE_GIFT_RE.test(s)) sc += 5;
    if (PROMOTE_AMOUNT_RE.test(s)) sc += 4;
    if (/新用户|注册|首次|学生|认证/.test(s)) sc += 3;
    // 条款句/导航句降权
    if (/(?:有效期|过期作废|共享消耗|不结转|不可转让|依次递减|资源包)/.test(s)) sc -= 4;
    if (/^[①-⑩0-9]+[.、)）]?\s*(?:平台|模型|应用|组件|系统|控制台|文档|产品)/.test(s)) sc -= 5;
    if (s.length < 12) sc -= 2;
    // 越靠前越可能是主标题
    sc -= idx * 0.3;
    return { s, sc, idx };
  });

  scored.sort((a, b) => b.sc - a.sc || a.idx - b.idx);

  // 优先选"同时含赠予动作 + 额度数值"的句子作为标题；
  // 仅当不存在这种句子时，才退而求其次（避免选出"100万 tokens。"这类裸片段，
  // 既有信息量又不像标题——腾讯混元就是这样退化的）。
  const idealIdx = scored.findIndex((x) =>
    PROMOTE_GIFT_RE.test(x.s) && PROMOTE_AMOUNT_RE.test(x.s) && !/(?:有效期|过期作废|资源包)/.test(x.s));

  if (idealIdx >= 0) {
    // 若命中句短且其前一句也是同一活动的一部分（不含条款/条款语义），
    // 合并前一句以获得更完整的标题（百度千帆："当前新用户注册…" + "实名认证后即送20元代金券！"）。
    const hit = scored[idealIdx];
    const original = sentences[hit.idx];
    const prev = hit.idx > 0 ? sentences[hit.idx - 1] : null;
    if (prev && prev.length >= 8 && !/(?:有效期|过期作废|资源包|共享消耗)/.test(prev)
      && (PROMOTE_GIFT_RE.test(prev) || /新用户|注册|首次|学生|认证/.test(prev))
      && (prev.length + original.length) <= 90) {
      return `${prev}${original}`.slice(0, 150);
    }
    return original.slice(0, 150);
  }

  const best = scored[0];
  if (best && best.sc > 0) return best.s.slice(0, 150);

  // 完全没找到合适句子 → 回退到原标题（即使不完美，也好过空标题）
  return candidateTitle || '';
}

// ---------------- 主提取函数 ----------------

/**
 * @param {{title:string, context:string, href:string|null}} candidate
 * @param {{provider:object, source:{url:string,kind:string}, refYear:number, allowedHosts:string[]}} ctx
 * @returns {object} 结构化活动（含 confidence），无法确定字段为 null
 */
export function extractActivity(candidate, ctx) {
  const {
    provider, source, refYear, allowedHosts = [],
    isBadTitle = () => ({ ok: true }), skipHostCheck = false,
  } = ctx;
  // 搜索型源的候选把正文放在 text 里（见 pipeline/index.js 的 processSearchSource），
  // 固定页源的候选用 context。两者都兼容，否则搜索源会拿到空文本。
  const body = candidate.context || candidate.text || '';
  const text = cleanText(`${candidate.title}\n${body}`);
  const lower = text.toLowerCase();

  // ---- 类别 ----
  let category = 'free_credit';
  for (const r of CATEGORY_RULES) {
    if (r.kw.some((k) => text.includes(k) || lower.includes(k.toLowerCase()))) { category = r.cat; break; }
  }
  // 学生类优先（更强的限定）
  if (AUDIENCE_RULES[1].kw.some((k) => text.includes(k) || lower.includes(k.toLowerCase()))) category = 'student';

  // ---- 额度 ----
  let benefit = null;
  for (const p of BENEFIT_PATTERNS) {
    const m = text.match(p.re);
    if (!m) continue;
    const amount = resolveAmount(m, p);
    if (amount == null) continue;
    benefit = {
      kind: p.kind,
      amount,
      unit: p.unit,
      text: cleanText(m[0]).slice(0, 80),
    };
    break;
  }

  // ---- 时间 ----
  const { start, end } = extractDates(text, refYear);

  // ---- 人群 ----
  const audience = [];
  const audienceNotes = [];
  for (const r of AUDIENCE_RULES) {
    if (r.kw.some((k) => text.includes(k) || lower.includes(k.toLowerCase()))) {
      audience.push(r.a);
      const hit = r.kw.find((k) => text.includes(k) || lower.includes(k.toLowerCase()));
      if (hit && !audienceNotes.includes(hit)) audienceNotes.push(hit);
    }
  }
  if (!audience.length) audience.push('all');

  // ---- 绑卡 ----
  let requiresCard = 0;
  if (NO_CARD_KW.some((k) => lower.includes(k.toLowerCase()))) requiresCard = 0;
  else if (CARD_KW.some((k) => lower.includes(k.toLowerCase()))) requiresCard = 1;

  // ---- 周期刷新 ----
  let isRecurring = null;
  for (const r of RECURRING_RULES) {
    if (r.kw.some((k) => text.includes(k) || lower.includes(k.toLowerCase()))) { isRecurring = r.r; break; }
  }

  // ---- 领取链接 ----
  // 搜索型源（skipHostCheck）的链接本就指向外部站点（媒体/社区/第三方汇总），
  // 白名单在此不适用：若照常丢弃，搜索结果里最有价值的"详情页链接"就全没了。
  // 故此处对搜索源保留原链接，安全性由渲染侧的 safeUrl() 协议白名单兜底。
  let claimUrl = candidate.href || candidate.url || null;
  let linkOk = false;
  if (claimUrl) {
    if (skipHostCheck) {
      claimUrl = normalizeUrl(claimUrl);
      linkOk = true;
    } else {
      const host = safeHost(claimUrl);
      linkOk = allowedHosts.some((h) => host === h || host.endsWith('.' + h)) || host === safeHost(source.url);
      if (!linkOk) claimUrl = null; // 不同域 → 丢弃，避免幻觉/外链
      else claimUrl = normalizeUrl(claimUrl);
    }
  }

  // ---- 置信度 ----
  // 设计目标：让"抽到明确额度 + 有链接 + 标题干净"的真实活动能越过
  // auto_ok 阈值（0.8），同时让缺字段的模糊条目停在 pending 区间接受人工复核。
  // 原公式上限偏低（多数真实活动只有 0.60~0.65，被迫长驻待审队列），
  // 导致公开发布的 feed 长期稀疏——这是本次重新配平的原因。
  let conf = 0.30;

  // 额度是最核心的证据
  if (benefit) conf += 0.28;

  // 时间：有明确起止最好；仅有截止或仅有开始也给部分分
  if (start && end) conf += 0.18;
  else if (end || start) conf += 0.10;

  // 链接：指向厂商白名单域名内
  if (linkOk) conf += 0.14;
  else if (claimUrl) conf += 0.06;   // 有链接但域名未验证，给一点点分

  // 受众限定（新用户/学生等）本身就是强信号
  if (audience.length && audience[0] !== 'all') conf += 0.12;

  // 上下文长度合理
  const len = text.length;
  if (len >= 40 && len <= 800) conf += 0.05;
  if (len > 1500) conf -= 0.15;

  // 标题质量加分：标题已通过 isBadTitle 才会走到这里，
  // 但"长度适中 + 不以句读结尾"的标题可信度更高
  const titleStr = String(candidate.title || '');
  if (titleStr.length >= 8 && titleStr.length <= 60 && !/[，。；、]$/.test(titleStr)) conf += 0.06;

  // 强受众限定 + 明确赠予动作 → 即使没抽到数值额度，也是真实活动（如
  // "Dedicated API credits and educational features for student learning"）。
  // 这类条目没有任何数字，仅靠数值规则永远进不了候选，但业务上是高价值的学生优惠。
  const strongAudience = audience.some((a) => a !== 'all');
  const hasGiftWord = /(?:赠送|送出|赠金|体验金|代金券|免费额度|免费试用|注册即送|即送|白嫖|免费领取|free credit|credits|free tier|trial|giveaway)/i.test(text);
  if (!benefit && strongAudience && hasGiftWord) conf += 0.22;
  // 有赠予动作但无受众限定的裸赠送（"赠送 10 个快速克隆音色"）
  if (benefit && benefit.kind === 'count') conf += 0.05;

  conf = Math.max(0, Math.min(1, conf));

  // ---- 摘要 ----
  // 摘要取"除标题以外"的正文行，避免摘要与标题完全重复。
  const bodyLines = String(candidate.context || '')
    .split('\n')
    .map((l) => cleanText(l))
    .filter((l) => l.length > 8);

  const resolvedTitle = cleanTitle(promoteTitle(candidate.title, candidate.context, isBadTitle), isBadTitle);

  const summaryParts = bodyLines
    .filter((l) => l !== resolvedTitle && !resolvedTitle.includes(l) && !l.includes(resolvedTitle))
    .slice(0, 2);
  let summary = cleanText(summaryParts.join(' ')).slice(0, 200);
  if (!summary) {
    // 兜底：若摘要被过滤空，用标题所在句以外的首句
    summary = cleanText(bodyLines.filter((l) => l !== resolvedTitle).slice(0, 1).join(' ')).slice(0, 200)
      || cleanText(candidate.context).slice(0, 200);
  }

  return {
    providerSlug: provider.slug,
    title: cleanText(resolvedTitle).slice(0, 150) || cleanText(summary).slice(0, 60),
    summary,
    category,
    benefit,
    audience,
    audienceNote: audienceNotes.join('、') || null,
    startDate: start,
    endDate: end,
    isRecurring,
    requiresCard,
    requiresVerification: audience.includes('verified') ? 'identity'
      : audience.includes('student') ? 'student_id'
        : requiresCard ? 'payment' : null,
    claimUrl,
    sourceUrl: source.url,
    sourceExcerpt: cleanText(candidate.context).slice(0, 500),
    region: provider.country === 'CN' ? 'CN' : 'GLOBAL',
    confidence: Math.round(conf * 100) / 100,
    rawScore: candidate.score,
  };
}

function safeHost(u) {
  try { return new URL(u).host.toLowerCase(); } catch { return ''; }
}

export { BENEFIT_PATTERNS, CATEGORY_RULES, AUDIENCE_RULES, extractDates };
