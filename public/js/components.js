/**
 * components.js — 通用渲染组件（卡片、徽章、分页、空态）
 */

// ---------------- 工具 ----------------

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * 安全的 URL 输出：仅放行 http/https。
 *
 * 为什么 esc() 不够：`esc()` 只转义 HTML 实体，浏览器在解析 href 属性时
 * 会先做实体解码，因此 `javascript:alert(1)` 会原样通过并执行。
 * 这些链接来自抓取的第三方页面，属于不可信输入，必须做协议白名单。
 * 非法 URL 一律降级为 '#'，并标记 data-unsafe 以便调试。
 */
export function safeUrl(u) {
  const raw = String(u ?? '').trim();
  if (!raw) return '#';
  // 先去掉控制字符与空白（可绕过 naive 匹配，如 "java\nscript:"）
  const cleaned = raw.replace(/[\u0000-\u001f\u007f\s]+/g, '');
  if (/^https?:\/\//i.test(cleaned)) return raw;
  // 站内锚点路由允许（本项目所有内页都是 #/ 形式）
  if (/^#/.test(cleaned)) return raw;
  // 显式相对路径允许，但禁止协议相对 URL（//evil.com 会跳到外站）
  if (/^\.{1,2}\//.test(cleaned)) return raw;
  return '#';
}

export function h(strings, ...vals) {
  return strings.reduce((acc, s, i) => acc + s + (vals[i] ?? ''), '');
}

export function relTime(iso) {
  if (!iso) return '';
  const t = Date.parse(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z'));
  if (isNaN(t)) return iso;
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export function fmtDate(d) {
  if (!d) return '';
  return String(d).slice(5); // MM-DD
}

/** 额度展示：null 安全 */
export function benefitDisplay(a) {
  if (a.benefit?.display) return a.benefit.display;
  if (a.benefit?.text) return a.benefit.text;
  return '免费';
}

// ---------------- 徽章 ----------------

export function statusBadge(a) {
  if (a.status === 'ended') {
    return `<span class="badge badge--status-ended">已结束</span>`;
  }
  if (a.status === 'upcoming') {
    return `<span class="badge badge--status-upcoming badge--dot">即将开始</span>`;
  }
  if (a.endingSoon && typeof a.daysLeft === 'number' && a.daysLeft >= 0) {
    const d = a.daysLeft === 0 ? '今天截止' : `剩 ${a.daysLeft} 天`;
    return `<span class="badge badge--status-ending badge--dot">${esc(d)}</span>`;
  }
  return `<span class="badge badge--status-active badge--dot">进行中</span>`;
}

const CAT_COLOR = {
  free_credit: '#2563eb', trial: '#7c3aed', student: '#0891b2',
  discount: '#ea580c', refreshable: '#16a34a',
};

export function categoryBadge(a) {
  const c = CAT_COLOR[a.category] || '#6b7280';
  return `<span class="badge badge--category" style="--cat-text:${c}">${esc(a.categoryLabel || a.category)}</span>`;
}

export function audienceBadges(a, max = 3) {
  const list = a.audience || ['all'];
  // 注意：原实现先 slice 再用 indexOf 反查标签，当 audience 超过 max 时
  // 索引会错位（第二个徽章拿到错误的标签）。改为先映射再截断。
  return list.slice(0, max).map((x, i) => {
    const label = (a.audienceLabels && a.audienceLabels[i]) || x;
    return `<span class="badge badge--audience is-${esc(x)}">${esc(label)}</span>`;
  }).join('');
}

export function regionBadge(a) {
  const cn = a.region === 'CN';
  return `<span class="badge badge--region">${cn ? '国内' : '海外'}${a.provider?.cnAccessible === false && cn ? '' : ''}</span>`;
}

export function providerDot(a) {
  const color = a.provider?.color || '#2563eb';
  return `<span class="card__dot" style="background:${esc(color)}"></span>`;
}

// ---------------- 活动卡片 ----------------

export function activityCard(a) {
  const catColor = CAT_COLOR[a.category] || '#2563eb';
  const dateRange = a.startDate || a.endDate
    ? `${a.startDate ? fmtDate(a.startDate) : '—'} ~ ${a.endDate ? fmtDate(a.endDate) : '长期'}`
    : '';
  const flags = [];
  if (a.provider?.cnAccessible) flags.push('国内直连');
  else flags.push('需海外网络');
  if (a.requiresCard) flags.push('需绑卡');
  else flags.push('无需绑卡');
  if (a.isRecurring) flags.push({ daily: '每日刷新', weekly: '每周刷新', monthly: '每月刷新' }[a.isRecurring]);

  return `
<article class="card" style="--cat-color:${catColor}">
  <div class="card__top">
    <span class="card__provider">${providerDot(a)}${esc(a.provider?.name || '')}</span>
    ${categoryBadge(a)}
    ${a.isNew ? '<span class="badge badge--new">NEW</span>' : ''}
    <span class="card__status">${statusBadge(a)}</span>
  </div>

  <h3 class="card__title">
    <a href="#/activity/${a.id}">${esc(a.title)}</a>
  </h3>

  ${a.summary ? `<p class="card__summary">${esc(a.summary)}</p>` : ''}

  <div class="card__meta">
    <span class="meta-item meta-item--benefit"><span aria-hidden="true">🎁</span> ${esc(benefitDisplay(a))}</span>
    ${dateRange ? `<span class="meta-item ${a.endingSoon && a.status === 'active' ? 'meta-item--warn' : ''}"><span aria-hidden="true">🗓</span> ${esc(dateRange)}</span>` : ''}
  </div>

  <div class="card__tags">
    ${audienceBadges(a)}
    ${regionBadge(a)}
  </div>

  <div class="card__foot">
    <span title="来源"><span aria-hidden="true">📄</span> ${esc(a.provider?.name || '')}</span>
    <span title="最后核验"><span aria-hidden="true">✓</span> ${esc(relTime(a.lastVerifiedAt || a.updatedAt))}</span>
    <span class="spacer"></span>
    <a class="btn btn--primary btn--sm" href="${esc(safeUrl(a.claimUrl))}" target="_blank" rel="noopener noreferrer">领取 →</a>
  </div>
</article>`;
}

export function skeletonCards(n = 6) {
  return Array.from({ length: n }, () => `<div class="card card--skeleton skeleton"></div>`).join('');
}

// ---------------- 空态 ----------------

export function emptyState({ icon = '🔍', title = '没有匹配的活动', desc = '试试调整筛选条件或清空搜索关键词' } = {}) {
  return `<div class="empty" style="grid-column:1/-1">
    <div class="empty__icon">${icon}</div>
    <div class="empty__title">${esc(title)}</div>
    <div class="empty__desc">${esc(desc)}</div>
  </div>`;
}

export function errorState(msg) {
  return `<div class="empty" style="grid-column:1/-1">
    <div class="empty__icon">⚠️</div>
    <div class="empty__title">加载失败</div>
    <div class="empty__desc">${esc(msg)}</div>
  </div>`;
}

// ---------------- 分页 ----------------

export function pager({ page, pages, total, pageSize }, makeHref) {
  if (pages <= 1) {
    return `<div class="pager__info">共 ${total} 条</div>`;
  }
  const btns = [];
  // 禁用态用 <span aria-disabled> 而非伪链接：
  // 原先的 `href="javascript:void 0)"` 语法有误且 <a> 无 disabled 属性，
  // 键盘/读屏用户无法区分可点与不可点，点击还会报错。
  const add = (p, label, disabled = false, current = false) => {
    if (disabled) {
      btns.push(`<span class="pager__btn is-disabled" aria-disabled="true">${label}</span>`);
    } else if (current) {
      btns.push(`<a class="pager__btn is-current" href="${esc(safeUrl(makeHref(p)))}" aria-current="page">${label}</a>`);
    } else {
      btns.push(`<a class="pager__btn" href="${esc(safeUrl(makeHref(p)))}">${label}</a>`);
    }
  };
  add(page - 1, '‹', page <= 1);

  const win = 2;
  const nums = new Set([1, pages]);
  for (let i = page - win; i <= page + win; i++) if (i >= 1 && i <= pages) nums.add(i);
  const sorted = [...nums].sort((a, b) => a - b);
  let prev = 0;
  for (const n of sorted) {
    if (n - prev > 1) btns.push(`<span class="pager__info">…</span>`);
    add(n, String(n), false, n === page);
    prev = n;
  }
  add(page + 1, '›', page >= pages);

  return `<nav class="pager" aria-label="分页">${btns.join('')}<span class="pager__info">共 ${total} 条 · 第 ${page}/${pages} 页</span></nav>`;
}

// ---------------- 统计卡 ----------------

export function statCard({ label, value, hint, variant = '', icon = '' }) {
  return `<div class="stat">
    <div class="stat__label">${icon ? esc(icon) + ' ' : ''}${esc(label)}</div>
    <div class="stat__value ${variant ? 'stat__value--' + variant : ''}">${esc(value)}</div>
    ${hint ? `<div class="stat__hint">${esc(hint)}</div>` : ''}
  </div>`;
}

export { CAT_COLOR };
