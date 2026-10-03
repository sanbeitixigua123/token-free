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

export function skeletonBlocks(n = 6, cls = 'card') {
  return Array.from({ length: n }, () => `<div class="${cls} skeleton" style="height:170px"></div>`).join('');
}

// ---------------- 三层结构：能力 / 模型 / 端点 / 攻略 ----------------

/**
 * 能力色板。与 freeaiapi 的 12 类对齐，但只保留本站实际收录的 10 类。
 *
 * 为什么用固定色而非按哈希取色：同一能力在活动卡片、模型库、端点库三处出现，
 * 颜色必须一致才能形成"视觉索引"。哈希取色在数据增减时会整体漂移。
 */
export const CAP_COLOR = {
  'text-generation': '#2563eb',
  'code-generation': '#7c3aed',
  'image-generation': '#db2777',
  'image-understanding': '#c026d3',
  'video-generation': '#ea580c',
  'speech-to-text': '#0891b2',
  'text-to-speech': '#0d9488',
  'text-embeddings': '#65a30d',
  'translation': '#ca8a04',
  'rerank': '#64748b',
};

/** 未知能力兜底色 —— 新能力上线时不至于渲染成透明 */
const CAP_FALLBACK = '#6b7280';

export function capColor(cap) {
  return CAP_COLOR[cap] || CAP_FALLBACK;
}

export function capabilityBadge(cap, label, count = null) {
  const c = capColor(cap);
  return `<span class="badge badge--cap" style="--cap-color:${c}">${esc(label || cap)}${count != null ? ` <b>${count}</b>` : ''}</span>`;
}

/**
 * 端点门槛徽章组。
 *
 * 这三个字段来自 endpoint 层（长期稳定的额度政策），而非活动层。
 * 活动层的 requiresCard 可能因某个限时活动而不同，所以两处都要显示、不可互相替代。
 */
export function endpointFlags(e, { compact = false } = {}) {
  const out = [];
  if (e.requiresCard) out.push('<span class="badge badge--warn">需绑卡</span>');
  else out.push('<span class="badge badge--ok">免绑卡</span>');
  if (e.cnAccessible) out.push('<span class="badge badge--ok">国内直连</span>');
  else out.push('<span class="badge badge--warn">需海外网络</span>');
  if (e.openaiCompatible) out.push('<span class="badge badge--neutral">OpenAI 兼容</span>');
  if (!compact) {
    if (e.requiresPhone) out.push('<span class="badge badge--neutral">需手机号</span>');
    if (e.requiresSignup) out.push('<span class="badge badge--neutral">需注册</span>');
  }
  return out.join('');
}

/** 额度摘要：RPM/RPD 与金额/单价两种口径统一成一行文本 */
export function quotaDisplay(e) {
  if (e.quotaText) return e.quotaText;
  const parts = [];
  if (e.quotaAmount != null) parts.push(`${e.quotaAmount}${e.quotaUnit || ''}`);
  if (e.quotaRpm) parts.push(`${e.quotaRpm} RPM`);
  if (e.quotaRpd) parts.push(`${e.quotaRpd} RPD`);
  if (e.quotaTpm) parts.push(`${e.quotaTpm} TPM`);
  return parts.length ? parts.join(' · ') : '免费';
}

/** 评分环：score 为 null 时显示"—"，避免把"未评分"渲染成 0 分 */
export function scoreRing(score, source = null) {
  if (score == null) {
    return `<span class="score-ring is-none" title="暂无评分"><span>—</span></span>`;
  }
  const v = Math.max(0, Math.min(100, Number(score)));
  const tone = v >= 80 ? 'is-high' : v >= 60 ? 'is-mid' : 'is-low';
  return `<span class="score-ring ${tone}" title="${esc(source || '综合评分')} ${v}" style="--v:${v}"><span>${v}</span></span>`;
}

export function modelCard(m) {
  const caps = (m.capabilities && m.capabilities.length) ? m.capabilities : [m.capability];
  const labels = m.capabilityLabels || caps;
  const color = capColor(caps[0]);
  const vendors = m.providerCount > 1 ? ` · ${m.providerCount} 家厂商` : '';

  return `
<a class="card card--link" style="--cat-color:${color}" href="#/model/${esc(m.slug)}">
  <div class="card__top">
    <span class="card__provider">${esc(m.name)}</span>
    <span class="card__status">${m.isOpenWeights ? '<span class="badge badge--ok">开源权重</span>' : ''}</span>
  </div>

  ${m.description ? `<p class="card__summary">${esc(m.description)}</p>` : ''}

  <div class="card__tags">
    ${caps.slice(0, 3).map((c, i) => capabilityBadge(c, labels[i])).join('')}
  </div>

  <div class="card__meta">
    ${m.contextWindow ? `<span class="meta-item"><span aria-hidden="true">📐</span> ${fmtTokens(m.contextWindow)} 上下文</span>` : ''}
  </div>

  <div class="card__foot">
    <span title="可领取的端点"><span aria-hidden="true">🔌</span> ${
      m.endpointCount > 0
        ? `${m.endpointCount} 个免费端点${vendors}`
        : '<span style="color:var(--text-faint)">暂无免费端点</span>'
    }</span>
    <span class="spacer"></span>
    <span class="btn btn--ghost btn--sm">查看详情 →</span>
  </div>
</a>`;
}

export function endpointCard(e) {
  const color = capColor(e.model.capability);
  return `
<a class="card card--link" style="--cat-color:${color}" href="#/endpoint/${esc(e.provider.slug)}/${esc(e.model.slug)}">
  <div class="card__top">
    <span class="card__provider">
      <span class="card__dot" style="background:${esc(e.provider.color || '#2563eb')}"></span>${esc(e.provider.name)}
    </span>
    <span class="card__status">${scoreRing(e.score, e.scoreSource)}</span>
  </div>

  <h3 class="card__title">${esc(e.model.name)}</h3>

  <div class="card__meta">
    <span class="meta-item meta-item--benefit"><span aria-hidden="true">🎁</span> ${esc(quotaDisplay(e))}</span>
  </div>

  <div class="card__tags">
    ${capabilityBadge(e.model.capability, e.model.capabilityLabel)}
    ${endpointFlags(e, { compact: true })}
  </div>

  <div class="card__foot">
    <span title="额度类型">${esc(e.quotaKindLabel || e.quotaKind || '')}</span>
    ${e.activityCount ? `<span title="关联活动"><span aria-hidden="true">✨</span> ${e.activityCount} 条活动</span>` : ''}
    <span class="spacer"></span>
    <span class="btn btn--ghost btn--sm">查看 →</span>
  </div>
</a>`;
}

export function guideCard(g) {
  return `
<a class="card card--link" style="--cat-color:#2563eb" href="#/guide/${esc(g.slug)}">
  <div class="card__top">
    <span class="card__provider">攻略</span>
    ${g.publishedAt ? `<span class="card__status" style="font-size:12px;color:var(--text-faint)">${esc(fmtDate(g.publishedAt))}</span>` : ''}
  </div>

  <h3 class="card__title">${esc(g.title)}</h3>

  ${g.summary ? `<p class="card__summary">${esc(g.summary)}</p>` : ''}

  <div class="card__tags">
    ${(g.tags || []).slice(0, 4).map((t) => `<span class="badge badge--neutral">${esc(t)}</span>`).join('')}
  </div>

  <div class="card__foot">
    ${g.providerName ? `<span>${esc(g.providerName)}</span>` : '<span></span>'}
    <span class="spacer"></span>
    <span class="btn btn--ghost btn--sm">阅读 →</span>
  </div>
</a>`;
}

/** 1000000 → 1M，方便在卡片里读 */
export function fmtTokens(n) {
  const v = Number(n);
  if (!isFinite(v) || v <= 0) return '';
  if (v >= 1000000) return `${+(v / 1000000).toFixed(v % 1000000 ? 1 : 0)}M`;
  if (v >= 1000) return `${+(v / 1000).toFixed(v % 1000 ? 1 : 0)}K`;
  return String(v);
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
