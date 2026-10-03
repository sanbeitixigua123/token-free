/**
 * discover.js — 从抓到的 HTML 中「发现」候选活动文本块
 *
 * 思路：
 *   1) 把 HTML 转成结构化文本块（标题 / 段落 / 列表项 / 表格行 / 链接），
 *      保留每个块所在的 <a> 链接。
 *   2) 用活动关键词打分，挑出最可能是活动的块，并与其邻接块合并成"候选上下文"。
 *   3) 输出候选项交给 extract.js 做字段抽取。
 *
 * 这样做的原因：规则提取需要"上下文足够但不冗余"的输入，
 * 直接把整页丢给正则会产生大量误报。
 */

import * as cheerio from 'cheerio';
import { cleanText, normalizeUrl } from '../lib/fingerprint.js';

// 活动强信号词（命中即加分）
const STRONG = ['赠送', '送', '免费', '白嫖', '试用', '体验金', '赠金', '额度', 'token', 'Token', 'TOKEN',
  '免费额度', '新用户', '注册即送', '学生', '校园', '优惠', '折扣', '半价', '限时', '领取', 'free',
  'credit', 'credits', 'trial', 'student', 'free tier', 'giveaway'];

// 活动弱信号词
const WEAK = ['活动', '福利', '补贴', '返现', '兑换', '礼包', '计划', 'promotion', 'offer', 'deal'];

// 排除信号：明显不是活动的噪音
const NEGATIVE = ['招聘', '岗位', '实习', '隐私政策', '服务条款', 'cookie', '登录', '注册账号',
  '价格对比', '企业版咨询', '联系我们', '版权所有'];

/**
 * "单价型"定价表排除。
 * 定价页大量出现 "$2.00 / 1M tokens"、"¥0.8 / 千 tokens"、"per 1M tokens"，
 * 这些是**价格**而不是**赠送额度**，若不过滤会污染活动列表。
 * 判据：数字后紧跟 "/" 或 "per" + 计量单位，且上下文没有"赠送/免费/送/额度"等赠予词。
 */
const PRICE_UNIT = /(?:per\s+\d|\/\s*\d?\s*(?:1M|1K|1k|M|K|千|万|百万)\s*(?:tokens?|token|字符|图片|次))/i;
const GIFT_WORDS = ['赠送', '送出', '送', '免费', '白嫖', '赠金', '体验金', '代金券', '免费额度',
  '注册即送', '领取', '领取额度', 'free credit', 'free tier', 'giveaway', 'credits for free'];

function isPriceTable(text) {
  if (!PRICE_UNIT.test(text)) return false;
  const hasGift = GIFT_WORDS.some((w) => text.includes(w) || text.toLowerCase().includes(w.toLowerCase()));
  return !hasGift;
}

function score(text) {
  const t = text || '';
  if (t.length < 12) return 0;
  let s = 0;
  for (const w of STRONG) if (t.includes(w)) s += 3;
  for (const w of WEAK) if (t.includes(w)) s += 1;
  for (const w of NEGATIVE) if (t.includes(w)) s -= 4;
  // 单价型定价表：直接判负，避免"$2/1M tokens"被当成活动
  if (isPriceTable(t)) s -= 8;
  // 调价公告："2026 年 12 月 31 日之前为 0.075 美元" —— 是价格变更，不是赠送
  if (/之前为\s*[\d.]+\s*(?:美元|元)|\d+\s*美元[/／]|起(?:为|调整)/.test(t)) s -= 6;
  // 含数字 + 额度单位，强信号
  if (/\d+\s*(亿|万|k|K|M)\s*(?:个)?\s*(?:token|Token|TOKEN)/.test(t)) s += 6;
  if (/(?:¥|￥|\$)\s*\d+/.test(t)) s += 3;
  if (/\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}[\/-]\d{1,2}/.test(t)) s += 2;
  // 长度惩罚
  if (t.length > 600) s -= 2;
  return s;
}

/**
 * 把 HTML 转成文本块数组。
 *
 * 实现要点（踩坑记录）：
 *   cheerio 的 `$.root()` 是文档节点，其子节点是 <html>，不是 <body>。
 *   早期版本直接对 root 做 children() 遍历，遇到 `<body><div>…全部内容…</div></body>`
 *   这种最常见结构时会整体跳过（div 未被识别为需要下钻的容器），导致 0 文本块。
 *   现改为：
 *     1) 优先在 <body>（或 scopeSelector）内取"叶子级"块元素
 *     2) 对每个块元素向上寻找最近的标题作为上下文
 *     3) 兜底：若块数量过少，退回整页纯文本切段
 *
 * @returns {Array<{text:string, href:string|null, tag:string, heading:string|null}>}
 */
export function extractBlocks(html, baseUrl, scopeSelector = null) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, iframe, template').remove();
  // 去除常见噪音区域
  $('nav, footer, [role="navigation"], .sidebar, .menu, .breadcrumb, .toc').remove();

  let $scope;
  if (scopeSelector) {
    const s = $(scopeSelector).first();
    $scope = s.length ? s : $('body');
  } else {
    $scope = $('body').length ? $('body') : $.root();
  }

  const blocks = [];
  const BLOCK_TAGS = 'h1, h2, h3, h4, h5, h6, p, li, td, th, dd, dt, blockquote, pre, figcaption, summary';

  // 收集标题，用于建立"标题 → 后续块"的归属关系
  const headings = [];
  $scope.find('h1, h2, h3, h4, h5, h6').each((_, el) => {
    headings.push({ el, text: cleanText($(el).text()) });
  });

  const nearestHeading = (el) => {
    // 文档顺序中最后一个出现在 el 之前的标题
    let last = null;
    for (const h of headings) {
      const cmp = h.el.compareDocumentPosition
        ? h.el.compareDocumentPosition(el)
        : null;
      if (cmp === null) break;
      // DOCUMENT_POSITION_FOLLOWING = 4 → h 在 el 之前
      if (cmp & 4) last = h.text;
      else break;
    }
    return last;
  };

  $scope.find(BLOCK_TAGS).each((_, el) => {
    const $el = $(el);
    // 若该块内含更细的块级子元素，跳过它，避免与子块重复
    if (/^(p|li|td|th|dd|dt|blockquote)$/.test((el.tagName || '').toLowerCase())
      && $el.find('p, li, table').length > 0) return;
    const text = cleanText($el.text());
    if (!text) return;
    let href = null;
    if ($el.is('a')) href = $el.attr('href');
    else href = $el.find('a').first().attr('href') || $el.closest('a').attr('href') || null;
    blocks.push({
      text,
      href: href ? absolutize(href, baseUrl) : null,
      tag: (el.tagName || '').toLowerCase(),
      heading: nearestHeading(el),
    });
  });

  // 表格行：定价页常见，整行合并成一条更有信息量
  $scope.find('table').each((_, table) => {
    $(table).find('tr').each((__, tr) => {
      const cells = $(tr).children('td,th').map((___, c) => cleanText($(c).text())).get().filter(Boolean);
      if (cells.length >= 2) {
        const href = $(tr).find('a').first().attr('href');
        blocks.push({
          text: cells.join(' | ').slice(0, 800),
          href: href ? absolutize(href, baseUrl) : null,
          tag: 'tr',
          heading: nearestHeading(tr),
        });
      }
    });
  });

  // 兜底：块太少或总字数过低，说明是 SPA 空壳或结构异常 → 整页文本切段
  const totalChars = blocks.reduce((s, b) => s + b.text.length, 0);
  if (totalChars < 200) {
    const bodyText = cleanText($scope.text());
    if (bodyText.length > 200) {
      blocks.length = 0;
      for (const seg of splitText(bodyText)) {
        blocks.push({ text: seg, href: null, tag: 'text', heading: null });
      }
    }
  }

  return blocks;
}

/** 纯文本切段：按换行/句号，合并过短片段 */
function splitText(text) {
  const raw = String(text).split(/\n+|(?<=[。！？；])/).map((s) => cleanText(s)).filter(Boolean);
  const out = [];
  let buf = '';
  for (const seg of raw) {
    if ((buf + seg).length > 500) { if (buf) out.push(buf); buf = seg; }
    else buf = buf ? buf + seg : seg;
  }
  if (buf) out.push(buf);
  return out.filter((s) => s.length >= 10);
}

/**
 * 从文本块中发现候选活动（带回溯上下文合并）。
 * @returns {Array<{title:string, context:string, href:string|null, score:number}>}
 */
export function discoverCandidates(blocks, { minScore = 6, maxCandidates = 25 } = {}) {
  const scored = blocks.map((b, i) => ({ ...b, i, score: score(b.text) }));
  // 表格行（定价表）本质是价格信息，极少是"赠送活动"，直接排除，
  // 否则 "$2.50 | 免费层级" 这类行会污染活动列表。
  const hits = scored.filter((b) => b.score >= minScore && b.tag !== 'tr');

  const candidates = [];
  const used = new Set();

  for (const hit of hits) {
    if (used.has(hit.i)) continue;
    // 以命中块为中心，向后合并到下一个标题为止，向前吸收一个标题
    let j = hit.i;
    const parts = [];
    let href = hit.href;
    let title = hit.heading || firstLine(hit.text);
    // 先向前找标题
    for (let k = hit.i - 1; k >= Math.max(0, hit.i - 3); k--) {
      if (blocks[k].tag && /^h[1-6]$/.test(blocks[k].tag)) { title = hit.heading || blocks[k].text; break; }
    }
    // 向后合并直到遇到新标题或超过 5 块
    let count = 0;
    while (j < blocks.length && count < 5) {
      const b = blocks[j];
      if (j > hit.i && b.tag && /^h[1-6]$/.test(b.tag)) break;
      if (!used.has(j) || j === hit.i) {
        parts.push(b.text);
        used.add(j);
        if (!href && b.href) href = b.href;
      }
      count++;
      j++;
    }
    const context = cleanText(parts.join('\n'));
    if (context.length < 12) continue;

    candidates.push({
      title: cleanText(title || '未命名活动').slice(0, 120),
      context: context.slice(0, 2000),
      href: href || null,
      score: Math.max(hit.score, score(context)),
      blockIndex: hit.i,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, maxCandidates);
}

function firstLine(t) {
  return String(t || '').split('\n')[0].slice(0, 90);
}

function absolutize(href, base) {
  if (!href) return null;
  try { return new URL(href, base).href; } catch { return null; }
}

export { score as scoreBlock };
