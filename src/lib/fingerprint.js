/**
 * fingerprint.js — 去重指纹与文本归一化
 *
 * 指纹构成 = SHA256( provider_slug | 归一化标题 | 归一化链接 | 归一化起始日 )
 * 目的：同一活动无论被抓到多少次，都只落一条记录。
 */

import crypto from 'node:crypto';

/** 标题归一化：去噪词、统一标点、压空白、转小写 */
const NOISE_WORDS = [
  '限时', '最新', '官方', '公告', '通知', '重磅', '上线', '来袭', '开启',
  '正式', '全新', '独家', '首发', '火热', '进行中', '活动',
];

export function normalizeTitle(s) {
  if (!s) return '';
  let t = String(s).normalize('NFKC').toLowerCase();
  // 全角标点 → 半角
  t = t.replace(/[【】《》「」『』""''（）()[\]]/g, ' ');
  for (const w of NOISE_WORDS) t = t.split(w).join('');
  // 仅保留中英数字
  t = t.replace(/[^\p{Script=Han}a-z0-9]+/gu, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

/** 链接归一化：去 utm/ref 参数与 fragment，保留 host+path */
export function normalizeUrl(u) {
  if (!u) return '';
  try {
    const url = new URL(u);
    url.hash = '';
    const drop = [];
    for (const k of url.searchParams.keys()) {
      if (/^utm_/i.test(k) || /^(ref|source|from|share|spm|scm|fbclid|gclid)$/i.test(k)) drop.push(k);
    }
    drop.forEach((k) => url.searchParams.delete(k));
    let s = url.origin + url.pathname.replace(/\/+$/, '');
    const q = url.searchParams.toString();
    if (q) s += '?' + q;
    return s.toLowerCase();
  } catch {
    return String(u).toLowerCase().trim();
  }
}

/** 日期归一化：支持 2026/10/7、10-07、2026年10月7日 → YYYY-MM-DD */
export function normalizeDate(s, { year } = {}) {
  if (!s) return null;
  if (s instanceof Date) return s.toISOString().slice(0, 10);
  let t = String(s).normalize('NFKC').trim();
  // 2026年10月7日
  let m = t.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
  if (m) return pad(m[1], m[2], m[3]);
  // 2026-10-07 / 2026/10/7
  m = t.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return pad(m[1], m[2], m[3]);
  // 10月7日（无年份，用参考年）
  m = t.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
  if (m && year) return pad(year, m[1], m[2]);
  // 10-07 / 10/7（无年份）
  m = t.match(/^(\d{1,2})[-/.](\d{1,2})$/);
  if (m && year) return pad(year, m[1], m[2]);
  return null;
}

function pad(y, mo, d) {
  const mm = parseInt(mo, 10);
  const dd = parseInt(d, 10);
  // 月份 1-12、日期 1-31 校验，避免生成 2026-00-01 这类非法日期
  if (!(mm >= 1 && mm <= 12)) return null;
  if (!(dd >= 1 && dd <= 31)) return null;
  return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

/** 生成指纹 */
export function makeFingerprint({ providerSlug, title, claimUrl, startDate }) {
  const parts = [
    (providerSlug || '').toLowerCase().trim(),
    normalizeTitle(title),
    normalizeUrl(claimUrl),
    normalizeDate(startDate) || '',
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

/** 内容哈希（用于判断页面是否变化） */
export function contentHash(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 32);
}

/** 文本清洗：HTML 实体、压缩空白 */
export function cleanText(s) {
  if (!s) return '';
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 额度数值归一化：'1亿' → {amount:1e8, unit:'token'} */
const UNIT_MULT = { 亿: 1e8, 万: 1e4, k: 1e3, K: 1e3, m: 1e6, M: 1e6, b: 1e9, B: 1e9 };

export function parseAmount(numStr, unitStr) {
  const n = parseFloat(String(numStr).replace(/,/g, ''));
  if (!isFinite(n)) return null;
  const mult = UNIT_MULT[unitStr] || 1;
  return n * mult;
}
