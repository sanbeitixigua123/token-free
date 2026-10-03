/**
 * validate.js — 校验与审核状态判定
 *
 * 目的：在落库前挡掉明显不可信 / 不合理的条目，并决定
 *       review_status（auto_ok / pending）。
 *
 * 校验项：
 *   V0 价格页识别（中英文计价结构，定价页整页挡掉）
 *   V1 标题非空、长度合理、且不是导航项 / 报价句 / 句子片段
 *   V1b 赠予语义（只认 title/summary/benefit 三个内容字段，不认整页快照）
 *   V2 领取链接必须为 http(s)，且落在厂商域名白名单（防幻觉）
 *   V3 起止日期合理（不得早于 2015，不得晚于参考年 + 2 年）
 *   V4 额度数值量级 sanity check（> 1e13 token 视为可疑）
 *   V5 置信度阈值
 */

import { createLogger } from '../lib/logger.js';

const log = createLogger('validate');

export const REJECT = 'reject';
export const PENDING = 'pending';
export const AUTO_OK = 'auto_ok';

/**
 * 赠予语义判据。
 * 一个真正的"免费活动"必须同时具备：
 *   (a) 赠予/免费信号词，或 明确的额度数值
 *   (b) 不是"单价型定价"（$2/1M tokens 这类是价格不是赠送）
 */
const GIFT_SIGNALS = [
  '赠送', '送出', '免费', '白嫖', '赠金', '体验金', '代金券', '免费额度', '免费试用',
  '注册即送', '领取', '新用户', '试用', '体验', '福利', '零成本', '不限量', '无限',
  'free', 'credit', 'trial', 'giveaway', 'no cost', 'complimentary', 'bonus',
];

// 单价结构：$2 / 1M tokens、¥0.5/千次、per 1M tokens
const PRICE_UNIT_RE = /(?:per\s+\d|\/\s*\d*\s*(?:1M|1K|1k|M|K|千|万|百万)\s*(?:tokens?|字符|图片|次|calls?))/i;
// 价格表特征：多个金额 + 斜杠单价 + 货币符号密集出现
const PRICE_DENSE_RE = /(?:\$\s*[\d.]+\s*\/\s*|¥\s*[\d.]+\s*\/|per\s+\d+\s*(?:million|1M|1K|千|万))/gi;

/**
 * 中文计价结构（定价页最常见的表述）：
 *   "X 美元/100 万个 token"、"Y 元/千次"、"每 1,000 次请求 14 美元"
 *   "0.075 美元"、"自 2027 年 1 月 1 日起为 0.15 美元"
 * 这类文本是【报价】，不是【赠送】。
 */
const CN_PRICE_RE = new RegExp(
  [
    // 金额 + 单位 + 斜杠 + 计量（含中文计数）
    String.raw`\d[\d,.]*\s*(?:美元|元|美金|美分)\s*\/\s*\d[\d,.]*\s*(?:万|千|百)?\s*个?\s*(?:tokens?|token|字符|图片|次|条|小时)`,
    // "每 1000 次请求 14 美元" / "每 1,000 次 14 美元"
    String.raw`每\s*[\d,.]+\s*(?:万|千)?\s*(?:次|个|条|tokens?)[^。；\n]{0,12}?\d[\d,.]*\s*(?:美元|元|美金)`,
    // "自 2027 年 1 月 1 日起为 0.15 美元" —— 未来生效的价格调整
    String.raw`(?:之前为|起为|起调整为|生效\s*为)\s*\d[\d,.]*\s*(?:美元|元|美金)`,
    // "超出后按 ... 计费"
    String.raw`超出[^。；\n]{0,20}?计费`,
    // 密集的"X 美元"出现（≥2 次）＝ 价格表
  ].join('|'),
  'gi'
);

/** 统计"金额+货币"出现次数（中英文货币都算） */
function countMoneyMentions(text) {
  const m = text.match(/(?:\d[\d,.]*\s*(?:美元|元|美金|美分))|(?:\$\s*\d[\d,.]*)|(?:¥\s*\d[\d,.]*)/g);
  return m ? m.length : 0;
}

/** 是否是单价型定价行（价格，而非赠送） */
export function isPriceOnly(item) {
  const text = `${item.title || ''} ${item.summary || ''} ${item.benefitText || ''} ${item.sourceExcerpt || ''}`;

  // 1) 英文单价结构
  const denseHits = (text.match(PRICE_DENSE_RE) || []).length;
  if (denseHits >= 2) return true;

  // 2) 中文计价结构
  const cnHits = (text.match(CN_PRICE_RE) || []).length;
  if (cnHits >= 1) {
    // 若整段几乎全是报价（金额出现 ≥3 次且无强赠予动作），判定为定价
    const strongGift = /(?:赠送|送出|注册即送|免费领取|赠金|体验金|代金券|免费额度|免费试用|giveaway|free credit)/;
    if (!strongGift.test(text)) return true;
    // 有强赠予词，但金额密集（≥3 处）且报价结构 ≥2 处 → 仍是价格页
    if (countMoneyMentions(text) >= 3 && cnHits >= 2) return true;
  }

  // 3) 兜底：金额密集（≥4 处）且没有任何赠予动作 → 定价页
  if (countMoneyMentions(text) >= 4) {
    const strongGift = /(?:赠送|送出|注册即送|免费领取|赠金|体验金|代金券|免费额度|免费试用|giveaway|free credit)/;
    if (!strongGift.test(text)) return true;
  }

  // 4) 英文单价结构（单处）
  if (PRICE_UNIT_RE.test(text)) {
    const strongGift = /(?:赠送|送出|注册即送|免费领取|领取|赠金|体验金|代金券|giveaway|free credit)/;
    return !strongGift.test(text);
  }

  return false;
}

/**
 * 标题质量判据：过滤掉导航项 / 菜单项 / 纯句子片段这类"不是标题的标题"。
 * 返回 {ok, reason}
 */
// 序号前缀：阿拉伯数字（1. / 2、/ 3)）与圈码（①②③…）、中文数字（一、二、）
const ORDINAL_PREFIX = /^(?:[0-9]+[.、)）]|[①②③④⑤⑥⑦⑧⑨⑩]|[一二三四五六七八九十][、.])\s*/;
const NAV_TITLE_RE = /^(?:平台操作|模型服务|应用开发|组件广场|系统管理|控制台|文档|产品|价格|定价|登录|注册|首页|更多|查看详情|立即购买|立即开通|了解详情|服务条款|隐私政策|联系我们|全部|其他|概览|简介|快速开始|操作指南|使用说明|平台说明|产品简介|购买指南|计费说明|注意事项)$/;

/**
 * 付费层级 / 定价档位标签。
 * 定价页里"付费层级（美元/100 万个 token）"这类是**档位名称**，不是活动。
 * 判据：以付费语义开头 + 含计价结构。
 */
const PAID_TIER_RE = /^(?:付费|收费|计费|标准价|原价|按量|超量|超额|超出|基础版|专业版|企业版|旗舰版)\s*(?:层级|档位|套餐|版本|方案|价格)?/;

export function isPaidTier(title) {
  const t = String(title || '').trim();
  if (!PAID_TIER_RE.test(t)) return false;
  // 同时含计价结构（美元/token、元/次），才判定为档位标签
  return /(?:美元|元|美金)\s*\/|per\s+\d|\/\s*\d*\s*(?:万|千|个)?\s*(?:token|tokens|次|个)/i.test(t);
}

/**
 * 泛化标题黑名单：脱离上下文后**不携带任何活动信息**的标题。
 *
 * 来源（实测踩坑）：定价页/文档站的栏目名与英文页面标题会被规则抽取当成活动标题，
 * 例如 GitHub Student Pack 页抽出的 "Offer"、阿里云定价页的 "新用户免费额度"。
 * 它们恰好含赠予词（offer / 免费额度），因而能通过赠予语义检查，
 * 但作为活动标题对用户毫无价值 —— 用户无法从中得知"送什么、给谁、多少"。
 *
 * 判据：纯英文单词表命中，或中文泛词**完全等于**标题（不做包含匹配，
 * 否则 "新用户免费额度领取攻略" 这类正常标题会被误杀）。
 */
const GENERIC_TITLE_EN = new Set([
  'offer', 'offers', 'free', 'free tier', 'free trial', 'free plan',
  'pricing', 'plans', 'credits', 'credit', 'promo', 'promotion',
  'sign up', 'signup', 'get started', 'learn more', 'bonus',
]);
const GENERIC_TITLE_ZH = new Set([
  '免费额度', '免费试用', '免费套餐', '新用户免费额度', '新用户专享',
  '赠送额度', '活动详情', '优惠活动', '领取', '立即领取', '免费领取',
  '福利', '试用', '体验', '套餐', '价格', '定价',
]);

export function isBadTitle(title) {
  const t = String(title || '').trim();
  if (!t) return { ok: false, reason: '标题为空' };
  if (t.length < 4) return { ok: false, reason: '标题过短' };

  // 泛化标题：仅当"整条标题"就是泛词时才判负（精确匹配，非包含）
  const lowerT = t.toLowerCase().replace(/[：:·—\-\s]+$/, '').trim();
  if (GENERIC_TITLE_EN.has(lowerT) || GENERIC_TITLE_ZH.has(t)) {
    return { ok: false, reason: '标题为泛化栏目名（不含活动信息）' };
  }

  // 去掉序号前缀后再判导航词（"③平台操作" → "平台操作"）
  const bare = t.replace(ORDINAL_PREFIX, '').trim();
  if (NAV_TITLE_RE.test(bare)) return { ok: false, reason: '标题疑似导航项 / 菜单项' };
  if (NAV_TITLE_RE.test(t)) return { ok: false, reason: '标题疑似导航项 / 菜单项' };
  if (isPaidTier(t)) return { ok: false, reason: '标题为付费档位标签' };

  // 英文长句片段：以连接词/标点截断的英文页面标题
  // 例："Dedicated API credits and educational features for student lea"
  // 特征：全英文 + 长度偏大 + 含介词/连词（说明是被截断的完整句子）
  if (!/[\u4e00-\u9fa5]/.test(t) && t.length > 40) {
    if (/\b(?:and|for|with|the|to|of|in|on|your|our|all)\b/i.test(t)) {
      return { ok: false, reason: '标题为英文长句片段（疑被截断）' };
    }
  }

  // 标题是"报价句"——以金额结尾且含价格语义词
  if (/(?:美元|元|美金)\s*$/.test(t) && countMoneyMentions(t) >= 1) {
    return { ok: false, reason: '标题疑似报价句' };
  }

  // 标题是长句片段：以逗号/句号结尾，或长度 > 90 且含多个句读
  if (t.length > 90) {
    const punct = (t.match(/[，。；、！？]/g) || []).length;
    if (punct >= 2) return { ok: false, reason: '标题过长且为句子片段' };
  }
  if (/[，。；、]$/.test(t) && t.length > 26) {
    return { ok: false, reason: '标题为不完整句子' };
  }
  // 条款句：含"有效期/资源包/共享消耗/过期作废"等条款语义 + 句子偏长
  // 不要求以句读结尾（抓取时尾标点常被切掉）
  if (/(?:有效期|资源包|共享消耗|过期作废|不结转|不可转让|依次递减)/.test(t) && t.length > 24) {
    return { ok: false, reason: '标题为条款句' };
  }
  // 含"共…，…。…"这类内部句读的复合句，长度偏大 → 不像标题
  if (t.length > 40 && (t.match(/[，。；]/g) || []).length >= 2) {
    return { ok: false, reason: '标题为复合长句' };
  }

  return { ok: true };
}

/** 是否具备赠予语义 */
export function hasGiftSemantics(item) {
  // 赠予词必须出现在"内容主体"（title/summary/benefit）里才算数。
  // sourceExcerpt 是整页文本快照，里面往往混着定价表里的"免费"字样，
  // 因此不能作为赠予语义的依据 —— 这是 Google 定价页被误判的根因。
  const core = `${item.title || ''} ${item.summary || ''} ${item.benefitText || ''}`;
  const lower = core.toLowerCase();
  if (GIFT_SIGNALS.some((w) => core.includes(w) || lower.includes(w.toLowerCase()))) return true;

  // 没有赠予词但有明确额度数值 + 明确受众限定，也接受（如"新用户可得 500 万 tokens"）
  if (item.benefitAmount != null && Array.isArray(item.audience) && item.audience.some((a) => a !== 'all')) return true;
  return false;
}

/**
 * @returns {{ok:boolean, action:'auto_ok'|'pending'|'reject', reasons:string[], notes:string[], item:object}}
 *
 * reasons 与 notes 的区别（重要）：
 *   reasons —— 硬性问题，会阻塞 auto_ok（如链接域名不在白名单、额度量级异常）
 *   notes   —— 说明性备注，仅供人工审阅参考，不参与 auto_ok 判定
 * 此前二者混用，导致搜索源的条目因"链接来自搜索结果"这条纯说明被永久
 * 挡在待审门外（置信度 0.95 也无法发布），是 ZCode 未被收录的直接原因。
 */
export function validateItem(item, { allowedHosts = [], sourceUrl = null, settings = {}, skipHostCheck = false } = {}) {
  const reasons = [];
  const notes = [];
  const review = settings.review || {};
  const autoApprove = review.autoApproveConfidence ?? 0.8;
  const pendingFloor = review.pendingConfidence ?? 0.5;
  const refYear = new Date(Date.now() + 8 * 3600 * 1000).getUTCFullYear();

  // V1 标题
  if (!item.title || item.title.length < 4) {
    return { ok: false, action: REJECT, reasons: ['标题缺失或过短'], notes, item };
  }
  // V1a 标题质量（挡掉导航项、报价句、句子片段）
  const titleCheck = isBadTitle(item.title);
  if (!titleCheck.ok) {
    return { ok: false, action: REJECT, reasons: [`标题质量不合格：${titleCheck.reason}`], notes, item };
  }

  // V1b 赠予语义（核心质量闸门）
  // 定价页的"$2.00 / 1M tokens"必须挡掉；没有赠予语义的条目一律拒绝。
  if (isPriceOnly(item)) {
    return { ok: false, action: REJECT, reasons: ['单价型定价行，非赠送活动'], notes, item };
  }
  // 付费档位标签（"付费层级（美元/100 万个 token）"）
  if (isPaidTier(item.title) || isPaidTier(item.summary)) {
    return { ok: false, action: REJECT, reasons: ['付费档位标签，非活动'], notes, item };
  }
  if (!hasGiftSemantics(item)) {
    return { ok: false, action: REJECT, reasons: ['缺少赠予/免费语义'], notes, item };
  }

  // V2 链接
  if (!item.claimUrl) {
    // 缺链接是"信息不完整"，不是"内容不可信" —— 记入 notes 而非 reasons，
    // 避免把内容翔实但暂无直达链接的活动一律压在待审。
    notes.push('缺少领取链接');
  } else if (!/^https?:\/\//i.test(String(item.claimUrl).trim())) {
    // 占位链接（"#"、"javascript:void(0)"）等价于"没有链接"：
    // 规则抓取常把 a[href="#"] 的"立即领取"按钮当成链接带出，
    // 若直接判为"非 http(s)"整条拒绝，会把活动本身一起丢掉。
    // 故降级为"缺链接"处理（记 notes、不阻塞 auto_ok），而非 reject。
    if (/^(?:#|javascript:)/i.test(String(item.claimUrl).trim())) {
      notes.push('领取链接为占位锚点，视同缺失');
      item.claimUrl = null;
    } else {
      return { ok: false, action: REJECT, reasons: ['领取链接非 http(s)'], notes, item };
    }
  } else if (skipHostCheck) {
    // 搜索型源的结果天然指向媒体/社区/第三方站，白名单在此不适用。
    // 不降置信度，仅记一条说明，便于人工审阅时知道链接是外部来源。
    notes.push('链接来自搜索结果（外部站点）');
  } else {
    const host = safeHost(item.claimUrl);
    const srcHost = sourceUrl ? safeHost(sourceUrl) : '';
    // 子域后缀匹配：白名单存的是域名，实际链接常带多级子域
    //（如白名单 aliyun.com → 实际 myaccount.console.aliyun.com）。
    // 因此判定条件是「host 等于白名单项 或 是其后代子域」，而非精确相等。
    const allowed = !!host && (
      host === srcHost ||
      allowedHosts.some((h) => host === h || host.endsWith('.' + h))
    );
    if (!allowed) {
      // 不在白名单 → 降级待审（可能被抓到了第三方转述页）
      reasons.push(`链接域名 ${host || '(无法解析)'} 不在厂商白名单`);
      item.confidence = Math.min(item.confidence, 0.55);
    }
  }
  // V3 日期
  for (const [k, v] of [['startDate', item.startDate], ['endDate', item.endDate]]) {
    if (!v) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      reasons.push(`${k} 格式非法`);
      item[k] = null;
      continue;
    }
    const y = parseInt(v.slice(0, 4), 10);
    if (y < 2015 || y > refYear + 2) {
      reasons.push(`${k} 年份异常（${v}）`);
      item[k] = null;
    }
  }

  // V4 额度量级
  if (item.benefitAmount != null) {
    if (!isFinite(item.benefitAmount) || item.benefitAmount <= 0) {
      reasons.push('额度数值非法');
      item.benefitAmount = null;
    } else if (item.benefitUnit === 'token' && item.benefitAmount > 1e13) {
      reasons.push(`额度量级异常（${item.benefitAmount} token）`);
      item.confidence = Math.min(item.confidence, 0.5);
    } else if ((item.benefitUnit === 'CNY' || item.benefitUnit === 'USD') && item.benefitAmount > 1e6) {
      reasons.push(`金额量级异常（${item.benefitAmount} ${item.benefitUnit}）`);
      item.confidence = Math.min(item.confidence, 0.5);
    }
  }

  // V5 置信度 → 审核状态
  let action;
  if (item.confidence >= autoApprove && !reasons.length) {
    action = AUTO_OK;
  } else if (item.confidence >= pendingFloor) {
    action = PENDING;
  } else {
    action = REJECT;
    // 让每条拒绝都有可追溯的原因（此前"未知"拒绝无法回溯，是审计盲点）
    reasons.push(`置信度不足（${Number(item.confidence).toFixed(2)} < ${pendingFloor}）`);
  }
  // 有硬性问题（链接域名异常、额度量级异常等）时，即使置信度高也转待审。
  // 注意：这里只看 reasons，notes 是说明性备注，不阻塞发布。
  if (action === AUTO_OK && reasons.length) action = PENDING;

  if (reasons.length) log.debug(`校验提示：${item.title}`, { reasons: reasons.join('; ') });

  return { ok: action !== REJECT, action, reasons, notes, item };
}

function safeHost(u) {
  try { return new URL(u).host.toLowerCase(); } catch { return ''; }
}
