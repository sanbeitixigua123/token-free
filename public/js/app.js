/**
 * app.js — 应用入口：hash 路由 + 页面渲染
 *
 * 路由：
 *   #/                 首页仪表盘
 *   #/activities       活动列表（筛选/搜索/分页）
 *   #/activity/:id     活动详情
 *   #/providers        厂商总览
 *   #/provider/:slug   单厂商活动
 *   #/timeline         时间线
 *   #/models           模型库（按能力/厂商筛选）
 *   #/model/:slug      模型详情（含可领取端点）
 *   #/endpoints        免费端点库（额度/速率/门槛一览）
 *   #/endpoint/:provider/:model  端点详情
 *   #/guides           攻略 / 解读
 *   #/guide/:slug      攻略正文
 *   #/logs             抓取日志（仅本地服务）
 *   #/review           待审队列（仅本地服务）
 *   #/subscribe        订阅管理
 *   #/about            关于
 */

import * as api from './api.js';
import {
  esc, safeUrl, activityCard, skeletonCards, skeletonBlocks, emptyState, errorState, pager, statCard,
  statusBadge, categoryBadge, audienceBadges, benefitDisplay, relTime, fmtDate,
  providerDot, CAT_COLOR,
  modelCard, endpointCard, guideCard, capabilityBadge, endpointFlags, quotaDisplay,
  scoreRing, capColor, fmtTokens,
} from './components.js';

const $app = document.getElementById('app');
let currentState = {};

// ---------------- 路由 ----------------

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const segs = pathPart.split('/').filter(Boolean);
  const query = Object.fromEntries(new URLSearchParams(queryPart || ''));
  return { name: segs[0] || 'home', param: segs[1] || null, param2: segs[2] || null, query };
}

/**
 * 静态模式下给页面挂一个全局标记类。
 *
 * 之前只有首页的说明文字里写了"当前为静态只读版"，其它页面（模型库、端点库…）
 * 完全没有提示 —— 用户会困惑为什么"抓取日志""待审"点进去是空的，
 * 也看不到"筛选在浏览器内完成"这个关键信息。
 * 这里统一挂 .is-static，由 CSS 显示一条顶部提示，不必每个页面各写一遍。
 */
function markStaticMode() {
  const isStatic = api.getMode() === 'static';
  document.documentElement.classList.toggle('is-static', isStatic);
  let el = document.getElementById('staticHint');
  if (!isStatic) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'staticHint';
    el.className = 'static-hint';
    el.innerHTML = '<span aria-hidden="true">📖</span>&nbsp;当前为<b>静态只读版</b>（GitHub Pages）——筛选与搜索在你的浏览器内完成，抓取日志与审核队列仅在本地运行时可用。';
    document.querySelector('.app-main')?.prepend(el);
  }
}

async function render() {
  const route = parseHash();
  currentState.route = route;
  setActiveNav(route.name);
  window.scrollTo({ top: 0, behavior: 'instant' });
  markStaticMode();

  try {
    switch (route.name) {
      case 'home': return await renderHome();
      case 'activities': return await renderActivities(route.query, false);
      case 'activity': return await renderDetail(route.param);
      case 'providers': return await renderProviders();
      case 'provider': return await renderProviderDetail(route.param);
      case 'timeline': return await renderTimeline();
      case 'models': return await renderModels(route.query);
      case 'model': return await renderModelDetail(route.param);
      case 'endpoints': return await renderEndpoints(route.query);
      case 'endpoint': return await renderEndpointDetail(route.param, route.param2);
      case 'guides': return await renderGuides();
      case 'guide': return await renderGuideDetail(route.param);
      case 'logs': return await renderLogs();
      case 'review': return await renderReview();
      case 'subscribe': return await renderSubscribe();
      case 'about': return await renderAbout();
      default: return await renderHome();
    }
  } catch (err) {
    // 用 warn 而非 error：避免把带内部路径的堆栈当作页面级错误抛到控制台；
    // 面向用户的提示不暴露内部 URL（err.message 可能含 /api/... 路径）。
    console.warn('[TokenFree] 页面渲染失败：', err);
    const friendly = /404/.test(String(err.message))
      ? '请求的内容不存在'
      : '数据加载失败，请稍后重试';
    $app.innerHTML = `<div class="page">${errorState(friendly)}</div>`;
  }
}

function setActiveNav(name) {
  const map = {
    home: 'home', activities: 'activities', activity: 'activities',
    providers: 'providers', provider: 'providers', timeline: 'timeline',
    models: 'models', model: 'models', endpoints: 'endpoints', endpoint: 'endpoints',
    guides: 'guides', guide: 'guides',
    logs: 'logs', review: 'review', subscribe: 'subscribe', about: 'about',
  };
  const active = map[name] || 'home';
  document.querySelectorAll('.nav__link').forEach((el) => {
    el.classList.toggle('is-active', el.dataset.nav === active);
  });
}

// ---------------- 首页 ----------------

async function renderHome() {
  // 先 await 一次探测，让后面的 getStats() 直接命中已缓存的结论。
  // 若把 getStats() 与这行 Promise.all 一起发，两者会在同一微任务批次里
  // 各调一次 detectMode() → 探测未完成 → /api/stats 发两次。
  // （虽然 detectMode 内部已做了并发合并，这里仍显式串行，语义更清晰）
  const mode = await api.detectMode();
  $app.innerHTML = `<div class="page">
    <div class="stat-grid">${Array.from({ length: 4 }, () => `<div class="stat skeleton" style="height:88px"></div>`).join('')}</div>
    <div class="cards">${skeletonCards(6)}</div>
  </div>`;

  const [stats, recent, meta] = await Promise.all([
    api.getStats(),
    api.getActivities({ page_size: 9, sort: 'ending' }),
    api.getMeta(),
  ]);

  const items = recent.items || [];
  const newItems = items.filter((a) => a.isNew);
  const endingItems = items.filter((a) => a.endingSoon && a.status === 'active');

  const banner = stats.newToday > 0
    ? `<div class="banner">
        <span class="banner__icon">✨</span>
        <span class="banner__text">今日新增 <b>${stats.newToday}</b> 条活动，全网共 <b>${stats.total}</b> 条进行中</span>
        <a href="#/activities?is_new=1">查看今日新增 →</a>
      </div>`
    : '';

  $app.innerHTML = `<div class="page">
    <div class="page__head">
      <div class="page__title"><h1>AI 免费活动雷达</h1></div>
      <p class="page__desc">
        每日 10:00（北京时间）自动汇总 ${stats.providerCount} 家国内外 AI 厂商的免费额度、试用与认证优惠。
        ${meta?.generatedAt ? `数据更新于 ${esc(meta.generatedAt)}。` : ''}
        ${mode === 'static' ? '<b>当前为静态只读版</b>（筛选与搜索在浏览器内完成）。' : ''}
      </p>
    </div>

    ${banner}

    <div class="stat-grid">
      ${statCard({ label: '进行中', value: stats.byStatus?.active ?? 0, variant: 'active', icon: '🟢', hint: '当前可领取' })}
      ${statCard({ label: '今日新增', value: stats.newToday ?? 0, variant: 'new', icon: '✨', hint: '24 小时内收录' })}
      ${statCard({ label: '即将结束', value: stats.endingSoon ?? 0, variant: 'ending', icon: '⏰', hint: '3 天内截止' })}
      ${statCard({ label: '覆盖厂商', value: stats.providerCount ?? 0, variant: 'brand', icon: '🏢', hint: '持续扩充中' })}
    </div>

    ${endingItems.length ? `
      <div class="panel" style="margin-bottom:20px">
        <div class="panel__title">⏰ 即将结束（抓紧领取）</div>
        <div class="cards">${endingItems.slice(0, 3).map(activityCard).join('')}</div>
      </div>` : ''}

    <div class="page__head" style="margin-top:26px">
      <div class="page__title">
        <h2>${newItems.length ? '今日新增' : '最新活动'}</h2>
        <a class="btn btn--ghost btn--sm" href="#/activities">查看全部 →</a>
      </div>
    </div>
    <div class="cards">
      ${items.length ? items.map(activityCard).join('') : emptyState({
    icon: '📭', title: '暂无活动数据',
    desc: '运行 node src/jobs/daily-crawl.js 抓取，或在抓取日志页手动触发',
  })}
    </div>
  </div>`;
}

// ---------------- 活动列表 ----------------

function buildQueryString(q) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

async function renderActivities(query, isRefresh) {
  const filters = await api.getFilters();
  const page = parseInt(query.page || '1', 10);

  // 侧栏筛选器（仅首次渲染，避免打断输入）
  if (!isRefresh) {
    $app.innerHTML = `<div class="page">
      <div class="page__head">
        <div class="page__title"><h1>全部活动</h1></div>
        <p class="page__desc">按厂商、活动类型、适用人群、状态与时间筛选；支持关键词搜索。</p>
      </div>
      <div class="toolbar">
        <button class="btn filter-toggle" id="filter-toggle"
                aria-controls="sidebar" aria-expanded="false">☰ 筛选</button>
        <div class="search">
          <span class="search__icon" aria-hidden="true">🔍</span>
          <input class="search__input" id="search-input" type="search"
                 placeholder="搜索厂商、活动名称、额度…（如 1亿 / 学生 / ZCode）"
                 value="${esc(query.q || '')}" autocomplete="off"
                 aria-label="搜索活动">
          <button class="search__clear" id="search-clear" title="清空搜索" aria-label="清空搜索" ${query.q ? '' : 'hidden'}>✕</button>
        </div>
        <select class="select" id="sort-select" aria-label="排序方式">
          ${(filters.sorts || [{ value: 'ending', label: '即将结束优先' }]).map((s) =>
      `<option value="${esc(s.value)}" ${query.sort === s.value || (!query.sort && s.value === 'ending') ? 'selected' : ''}>${esc(s.label)}</option>`
    ).join('')}
        </select>
        <button class="btn btn--ghost btn--sm" id="reset-btn" ${hasAnyFilter(query) ? '' : 'hidden'}>清空筛选</button>
      </div>
      <div class="layout">
        <aside class="sidebar" id="sidebar" aria-label="筛选条件">${renderFacets(filters, query)}</aside>
        <div>
          <div id="list-result" aria-live="polite" aria-busy="false"></div>
        </div>
      </div>
    </div>`;
    bindActivityEvents();
  } else {
    const s = document.getElementById('sidebar');
    if (s) s.innerHTML = renderFacets(filters, query);
  }

  // 结果区
  const result = document.getElementById('list-result');
  if (!result) return;
  result.setAttribute('aria-busy', 'true');
  result.innerHTML = `<div class="cards">${skeletonCards(6)}</div>`;

  const data = await api.getActivities({ ...query, page: String(page) });
  const items = data.items || [];
  result.setAttribute('aria-busy', 'false');

  const activeChips = renderActiveChips(query, filters, data.total);
  const makeHref = (p) => {
    const next = { ...query, page: String(p) };
    return `#/activities${buildQueryString(next)}`;
  };

  result.innerHTML = `
    ${activeChips}
    <div class="cards">
      ${items.length ? items.map(activityCard).join('') : emptyState()}
    </div>
    ${items.length ? pager({ page: data.page, pages: data.pages, total: data.total, page_size: data.page_size }, makeHref) : ''}
  `;

  // 更新"清空筛选"按钮可见性
  const rb = document.getElementById('reset-btn');
  if (rb) rb.hidden = !hasAnyFilter(query);
  const sc = document.getElementById('search-clear');
  if (sc) sc.hidden = !query.q;
}

function hasAnyFilter(q) {
  return Object.keys(q).some((k) => !['page', 'page_size'].includes(k) && q[k]);
}

function renderFacets(f, q) {
  const group = (title, key, options, type = 'checkbox') => {
    if (!options || !options.length) return '';
    const selected = new Set(String(q[key] || '').split(',').filter(Boolean));
    const opts = options.map((o) => {
      const checked = selected.has(String(o.value));
      return `<label class="opt ${checked ? 'is-checked' : ''}">
        <input type="${type}" data-facet="${key}" value="${esc(o.value)}" ${checked ? 'checked' : ''}>
        <span class="opt__text">${esc(o.label)}</span>
        <span class="opt__count">${o.count}</span>
      </label>`;
    }).join('');
    // "清除"是交互控件，必须可键盘操作 → 用 <button> 而非 <span>
    return `<div class="facet" role="group" aria-label="${esc(title)}">
      <div class="facet__title"><span>${esc(title)}</span>
        ${selected.size ? `<button type="button" class="facet__reset" data-reset="${key}" aria-label="清除${esc(title)}筛选">清除</button>` : ''}
      </div>${opts}</div>`;
  };

  const toggles = (title, key) => `<div class="facet">
    <div class="facet__title">${esc(title)}</div>
    <label class="opt ${q[key] === '1' ? 'is-checked' : ''}">
      <input type="checkbox" data-toggle="${key}" ${q[key] === '1' ? 'checked' : ''}>
      <span class="opt__text">只看${esc(title)}</span>
    </label>
  </div>`;

  return [
    group('状态', 'status', f.statuses),
    group('活动类型', 'category', f.categories),
    group('模型能力', 'capability', f.capabilities),
    group('适用人群', 'audience', f.audiences),
    group('厂商', 'provider', f.providers),
    group('地域', 'region', f.regions),
    toggles('今日新增', 'is_new'),
    toggles('3 天内截止', 'ending_soon'),
    toggles('无需绑卡', 'no_card'),
    toggles('国内可直连', 'cn_accessible'),
    toggles('已关联模型', 'has_model'),
  ].filter(Boolean).join('');
}

function renderActiveChips(q, f, total) {
  const chips = [];
  const labelOf = (opts, v) => (opts || []).find((o) => String(o.value) === String(v))?.label || v;
  const push = (key, value, text) => chips.push(
    `<a class="badge badge--audience" href="#/activities${buildQueryString(removeKey(q, key, value))}" style="cursor:pointer">${esc(text)} ✕</a>`
  );
  for (const [key, opts] of [
    ['status', f.statuses], ['category', f.categories], ['capability', f.capabilities],
    ['audience', f.audiences], ['region', f.regions], ['provider', f.providers],
  ]) {
    const vals = String(q[key] || '').split(',').filter(Boolean);
    for (const v of vals) push(key, v, labelOf(opts, v));
  }
  for (const [key, text] of [['is_new', '今日新增'], ['ending_soon', '3 天内截止'], ['no_card', '无需绑卡'], ['cn_accessible', '国内可直连'], ['has_model', '已关联模型']]) {
    if (q[key] === '1') chips.push(`<a class="badge badge--audience" href="#/activities${buildQueryString(removeKey(q, key))}" style="cursor:pointer">${text} ✕</a>`);
  }
  if (q.q) chips.push(`<a class="badge badge--audience" href="#/activities${buildQueryString(removeKey(q, 'q'))}" style="cursor:pointer">搜索："${esc(q.q)}" ✕</a>`);

  if (!chips.length) {
    return `<div style="margin-bottom:14px;font-size:13.5px;color:var(--text-muted)">共 ${total} 条活动</div>`;
  }
  return `<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:14px">
    <span style="font-size:13.5px;color:var(--text-muted)">共 ${total} 条 ·</span>${chips.join('')}
  </div>`;
}

function removeKey(q, key, value = null) {
  const next = { ...q };
  if (value == null) { delete next[key]; return next; }
  const vals = String(next[key] || '').split(',').filter((x) => x && x !== value);
  if (vals.length) next[key] = vals.join(','); else delete next[key];
  return next;
}

function toggleValue(q, key, value) {
  const vals = String(q[key] || '').split(',').filter(Boolean);
  const i = vals.indexOf(value);
  if (i >= 0) vals.splice(i, 1); else vals.push(value);
  const next = { ...q };
  if (vals.length) next[key] = vals.join(','); else delete next[key];
  return next;
}

function navToActivities(q) {
  delete q.page; // 筛选变化时回到第 1 页
  location.hash = `#/activities${buildQueryString(q)}`;
}

function bindActivityEvents() {
  const root = document.getElementById('app');

  // 搜索（防抖）
  let timer = null;
  const input = document.getElementById('search-input');
  input?.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const q = { ...currentState.route.query, q: input.value.trim() };
      if (!q.q) delete q.q;
      navToActivities(q);
    }, 380);
  });
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(timer);
      const q = { ...currentState.route.query, q: input.value.trim() };
      if (!q.q) delete q.q;
      navToActivities(q);
    }
  });
  document.getElementById('search-clear')?.addEventListener('click', () => {
    navToActivities(removeKey(currentState.route.query, 'q'));
  });

  // 排序
  document.getElementById('sort-select')?.addEventListener('change', (e) => {
    navToActivities({ ...currentState.route.query, sort: e.target.value });
  });

  // 清空
  document.getElementById('reset-btn')?.addEventListener('click', () => {
    location.hash = '#/activities';
  });

  // 移动端筛选抽屉：打开时同步 aria-expanded，支持 Esc 关闭并把焦点还给触发按钮
  const filterBtn = document.getElementById('filter-toggle');
  const sidebarEl = document.getElementById('sidebar');

  const closeDrawer = () => {
    if (!sidebarEl?.classList.contains('is-open')) return;
    sidebarEl.classList.remove('is-open');
    filterBtn?.setAttribute('aria-expanded', 'false');
    filterBtn?.focus();
  };

  filterBtn?.addEventListener('click', () => {
    const open = sidebarEl?.classList.toggle('is-open');
    filterBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      // 打开后把焦点移入抽屉，键盘用户可直接操作筛选
      sidebarEl?.querySelector('input, button')?.focus();
    }
  });

  // Esc 关闭抽屉（全局监听，随页面重建而重新绑定）
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });

  // 侧栏勾选（事件委托）
  const sidebar = document.getElementById('sidebar');
  sidebar?.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.facet) {
      navToActivities(toggleValue(currentState.route.query, t.dataset.facet, t.value));
    } else if (t.dataset.toggle) {
      const key = t.dataset.toggle;
      const q = { ...currentState.route.query };
      if (t.checked) q[key] = '1'; else delete q[key];
      navToActivities(q);
    }
  });
  sidebar?.addEventListener('click', (e) => {
    const r = e.target.closest('[data-reset]');
    if (r) navToActivities(removeKey(currentState.route.query, r.dataset.reset));
  });
}

// ---------------- 活动详情 ----------------

async function renderDetail(id) {
  if (!id) { location.hash = '#/activities'; return; }
  $app.innerHTML = `<div class="page"><div class="panel skeleton" style="height:400px"></div></div>`;

  const a = await api.getActivity(id);
  if (!a) {
    $app.innerHTML = `<div class="page">${emptyState({ icon: '🕳', title: '活动不存在或已移除', desc: '它可能已被归档或合并到其它条目' })}</div>`;
    return;
  }

  const dateRange = (a.startDate || a.endDate)
    ? `${a.startDate || '—'} ~ ${a.endDate || '长期有效'}`
    : '未标注';
  const statusExtra = a.status === 'active' && typeof a.daysLeft === 'number' && a.daysLeft >= 0
    ? `（剩 ${a.daysLeft} 天）` : '';

  const historyBlock = (a.history && a.history.length)
    ? `<div class="panel"><div class="panel__title">变更历史（数据可追溯）</div>
        <ul class="history-list">${a.history.map((h) => `
          <li><span class="f">${esc(h.field)}</span>
            <span class="v">${esc(truncate(h.old_value, 40))} → ${esc(truncate(h.new_value, 40))}</span>
            <span class="t">${esc(h.changed_by)} · ${esc(relTime(h.changed_at))}</span>
          </li>`).join('')}</ul></div>`
    : '';

  const relatedBlock = (a.related && a.related.length)
    ? `<div class="panel"><div class="panel__title">${esc(a.provider.name)} 的其它活动</div>
        <ul class="related-list">${a.related.map((r) => `
          <li><a href="#/activity/${r.id}">${esc(r.title)}</a>
            <div class="rel-provider">${esc(r.categoryLabel)} · ${esc(benefitDisplay(r))}</div>
          </li>`).join('')}</ul></div>`
    : '';

  $app.innerHTML = `<div class="page">
    <div style="margin-bottom:14px">
      <a href="#/activities" class="btn btn--ghost btn--sm">← 返回列表</a>
    </div>

    <div class="detail">
      <div>
        <div class="panel">
          <div class="detail__top">
            <span class="card__provider" style="font-size:14px">${providerDot(a)}${esc(a.provider.name)}</span>
            ${categoryBadge(a)}
            ${statusBadge(a)}
            ${a.isNew ? '<span class="badge badge--new">NEW</span>' : ''}
            ${(a.audience || []).map((x, i) =>
    `<span class="badge badge--audience is-${esc(x)}">${esc((a.audienceLabels || [])[i] || x)}</span>`).join('')}
          </div>

          <h1 class="detail__title">${esc(a.title)}</h1>
          ${a.summary ? `<p class="detail__summary">${esc(a.summary)}</p>` : ''}

          <div class="field-grid">
            <div class="field">
              <div class="field__label">活动内容 / 额度</div>
              <div class="field__value field__value--big">${esc(benefitDisplay(a))}</div>
            </div>
            <div class="field">
              <div class="field__label">适用人群</div>
              <div class="field__value">${esc((a.audienceLabels || ['所有人']).join('、'))}</div>
            </div>
            <div class="field">
              <div class="field__label">活动时间</div>
              <div class="field__value${a.endingSoon ? '' : ''}">${esc(dateRange)}<span style="color:var(--status-ending);font-size:13px">${esc(statusExtra)}</span></div>
            </div>
            <div class="field">
              <div class="field__label">领取门槛</div>
              <div class="field__value field__value--muted">
                ${a.requiresCard ? '需绑定支付方式' : '无需绑卡'}${a.requiresVerification ? ' · ' + esc(verifyLabel(a.requiresVerification)) : ''}
                ${a.isRecurring ? ' · ' + esc({ daily: '每日刷新', weekly: '每周刷新', monthly: '每月刷新' }[a.isRecurring]) : ''}
              </div>
            </div>
          </div>

          <div style="margin-top:20px;display:flex;gap:10px;flex-wrap:wrap">
            <a class="btn btn--primary" href="${esc(safeUrl(a.claimUrl))}" target="_blank" rel="noopener noreferrer">前往领取 →</a>
            ${a.sourceUrl ? `<a class="btn" href="${esc(safeUrl(a.sourceUrl))}" target="_blank" rel="noopener noreferrer">查看来源页面</a>` : ''}
          </div>
        </div>

        ${a.sourceExcerpt ? `<div class="panel">
          <div class="panel__title">来源文本摘要</div>
          <div class="excerpt">${esc(a.sourceExcerpt)}</div>
          <div style="margin-top:10px;font-size:12.5px;color:var(--text-faint)">
            来源：${a.sourceUrl ? `<a href="${esc(safeUrl(a.sourceUrl))}" target="_blank" rel="noopener">${esc(a.sourceUrl)}</a>` : '—'}
            · 可信度 ${Math.round((a.confidence || 0) * 100)}%
          </div>
        </div>` : ''}

        ${historyBlock}
      </div>

      <div>
        <div class="panel">
          <div class="panel__title">活动信息</div>
          <div style="font-size:13.5px;line-height:2;color:var(--text-secondary)">
            <div>厂商：<b style="color:var(--text)">${esc(a.provider.name)}</b></div>
            <div>国别：${a.provider.country === 'CN' ? '中国' : esc(a.provider.country)}</div>
            <div>访问：${a.provider.cnAccessible ? '国内可直连' : '需海外网络'}</div>
            <div>类别：${esc(a.categoryLabel)}</div>
            <div>状态：${esc({ active: '进行中', upcoming: '即将开始', ended: '已结束' }[a.status] || a.status)}</div>
            <div>收录：${esc(relTime(a.createdAt))}</div>
            <div>最后核验：${esc(relTime(a.lastVerifiedAt || a.updatedAt))}</div>
          </div>
          ${a.provider.website ? `<div style="margin-top:12px">
            <a class="btn btn--sm" href="${esc(safeUrl(a.provider.website))}" target="_blank" rel="noopener">厂商官网</a>
          </div>` : ''}
        </div>

        ${relatedBlock}

        <div class="panel">
          <div class="panel__title">免责声明</div>
          <p style="font-size:12.5px;color:var(--text-muted);margin:0;line-height:1.7">
            活动信息由程序自动抓取并整理，可能存在延迟或偏差。额度、时间与门槛请以厂商官方页面为准。
          </p>
        </div>
      </div>
    </div>
  </div>`;
}

function verifyLabel(v) {
  return {
    phone: '需手机号', student_id: '需学籍认证', identity: '需实名认证',
    payment: '需支付方式', github: '需 GitHub 账号',
  }[v] || v;
}
function truncate(s, n) {
  if (!s) return '（空）';
  return String(s).length > n ? String(s).slice(0, n) + '…' : String(s);
}

// ---------------- 厂商总览 ----------------

async function renderProviders() {
  $app.innerHTML = `<div class="page"><div class="provider-grid">${Array.from({ length: 8 }, () => '<div class="provider-card skeleton" style="height:140px"></div>').join('')}</div></div>`;
  const providers = await api.getProviders();
  const withData = providers.filter((p) => p.activityCount > 0);
  const without = providers.filter((p) => !p.activityCount);

  const card = (p) => `<a class="provider-card" href="#/provider/${esc(p.slug)}">
    <div class="provider-card__head">
      <div class="provider-card__logo" style="background:${esc(p.color || '#2563eb')}">${esc((p.name || '?')[0])}</div>
      <div>
        <div class="provider-card__name">${esc(p.name)}</div>
        <div class="provider-card__en">${esc(p.nameEn || '')} · ${p.country === 'CN' ? '中国' : esc(p.country)}</div>
      </div>
    </div>
    <div class="provider-card__stats">
      <div><b>${p.activityCount}</b> 条活动</div>
      <div><b>${p.activeCount}</b> 进行中</div>
    </div>
    <div class="provider-card__links">
      <span class="badge badge--region">${p.cnAccessible ? '国内直连' : '需海外网络'}</span>
    </div>
  </a>`;

  $app.innerHTML = `<div class="page">
    <div class="page__head">
      <div class="page__title"><h1>厂商总览</h1></div>
      <p class="page__desc">已追踪 ${providers.length} 家 AI 厂商，其中 ${withData.length} 家当前有活动。
        厂商清单在 <code class="mono">config/providers.yaml</code> 中声明式维护，扩充厂商只需追加约 10 行配置。</p>
    </div>
    ${withData.length ? `<h2 style="margin-bottom:12px;font-size:17px">有活动的厂商（${withData.length}）</h2>
      <div class="provider-grid" style="margin-bottom:30px">${withData.map(card).join('')}</div>` : ''}
    ${without.length ? `<h2 style="margin-bottom:12px;font-size:17px">已追踪（暂无活动）</h2>
      <div class="provider-grid">${without.map(card).join('')}</div>` : ''}
  </div>`;
}

async function renderProviderDetail(slug) {
  if (!slug) { location.hash = '#/providers'; return; }
  $app.innerHTML = `<div class="page"><div class="panel skeleton" style="height:300px"></div></div>`;

  const [providers, data] = await Promise.all([
    api.getProviders(),
    api.getActivities({ provider: slug, page_size: 100 }),
  ]);
  const p = providers.find((x) => x.slug === slug);
  if (!p) { $app.innerHTML = `<div class="page">${emptyState({ icon: '🏢', title: '未找到该厂商' })}</div>`; return; }

  const items = data.items || [];
  $app.innerHTML = `<div class="page">
    <div style="margin-bottom:14px"><a href="#/providers" class="btn btn--ghost btn--sm">← 厂商总览</a></div>
    <div class="page__head">
      <div class="page__title">
        <div class="provider-card__logo" style="background:${esc(p.color || '#2563eb')};width:40px;height:40px;font-size:17px">${esc((p.name || '?')[0])}</div>
        <h1>${esc(p.name)}</h1>
        ${p.cnAccessible ? '<span class="badge badge--status-active">国内可直连</span>' : '<span class="badge badge--region">需海外网络</span>'}
      </div>
      <p class="page__desc">
        ${esc(p.nameEn || '')} · ${p.country === 'CN' ? '中国' : esc(p.country)} ·
        共 ${p.activityCount} 条活动（${p.activeCount} 条进行中）
        ${p.lastActivityAt ? ` · 最近更新 ${esc(relTime(p.lastActivityAt))}` : ''}
      </p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
        ${p.website ? `<a class="btn btn--sm" href="${esc(safeUrl(p.website))}" target="_blank" rel="noopener">官网</a>` : ''}
        ${p.pricingUrl ? `<a class="btn btn--sm" href="${esc(safeUrl(p.pricingUrl))}" target="_blank" rel="noopener">定价页</a>` : ''}
        ${p.announcementUrl ? `<a class="btn btn--sm" href="${esc(safeUrl(p.announcementUrl))}" target="_blank" rel="noopener">公告页</a>` : ''}
      </div>
    </div>
    <div class="cards">
      ${items.length ? items.map(activityCard).join('') : emptyState({ icon: '📭', title: '该厂商暂无收录活动', desc: '抓取任务会自动发现新活动' })}
    </div>
  </div>`;
}

// ---------------- 时间线 ----------------

async function renderTimeline() {
  $app.innerHTML = `<div class="page"><div class="panel skeleton" style="height:340px"></div></div>`;
  const data = await api.getActivities({ page_size: 100, sort: 'ending' });
  const items = (data.items || []).filter((a) => a.status !== 'ended');

  // 按截止日分组
  const groups = new Map();
  for (const a of items) {
    const key = a.endDate ? a.endDate : '长期有效';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  const sorted = [...groups.entries()].sort((x, y) => {
    if (x[0] === '长期有效') return 1;
    if (y[0] === '长期有效') return -1;
    return x[0].localeCompare(y[0]);
  });

  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

  $app.innerHTML = `<div class="page">
    <div class="page__head">
      <div class="page__title"><h1>活动时间线</h1></div>
      <p class="page__desc">按截止时间排列，越靠前越紧急。长期有效的活动排在最后。</p>
    </div>
    ${sorted.length ? `<div class="timeline">
      ${sorted.map(([date, list]) => {
    const label = date === '长期有效' ? '长期有效'
      : date < today ? `已结束（${date}）`
        : date === today ? `今天截止（${date}）` : `截止 ${date}`;
    const cls = date === '长期有效' ? '' : (date < today ? 'style="color:var(--status-ended)"' : (date <= addDays(today, 3) ? 'style="color:var(--status-ending)"' : ''));
    return `<div class="timeline__group">
          <div class="timeline__date" ${cls}>${esc(label)} <span style="font-weight:400;color:var(--text-faint)">· ${list.length} 条</span></div>
          <div class="cards">${list.map(activityCard).join('')}</div>
        </div>`;
  }).join('')}
    </div>` : emptyState({ icon: '📅', title: '暂无进行中的活动' })}
  </div>`;
}

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------------- 抓取日志 ----------------

async function renderLogs() {
  const mode = await api.detectMode();
  if (mode !== 'api') {
    $app.innerHTML = `<div class="page">
      <div class="page__head"><div class="page__title"><h1>抓取日志</h1></div></div>
      <div class="notice notice--warn">
        当前为静态托管版本，不含服务端抓取日志。请在本地运行
        <code class="mono">npm start</code> 后访问本页查看完整的抓取批次、失败重试与数据溯源。
      </div>
      <div style="margin-top:16px"><a class="btn" href="#/">返回首页</a></div>
    </div>`;
    return;
  }

  $app.innerHTML = `<div class="page"><div class="panel skeleton" style="height:360px"></div></div>`;
  const runs = await api.getFetchRuns(40);

  const statusBadgeCls = (s) => ({
    ok: 'badge--status-active', partial: 'badge--status-ending',
    failed: 'badge--status-ended', running: 'badge--status-upcoming',
  }[s] || 'badge--region');

  $app.innerHTML = `<div class="page">
    <div class="page__head">
      <div class="page__title"><h1>抓取日志</h1>
        <button class="btn btn--primary btn--sm" id="run-crawl" style="margin-left:auto">▶ 立即抓取</button>
      </div>
      <p class="page__desc">每次抓取的批次记录、来源成功率、失败原因与新增数量，全部可追溯。</p>
    </div>
    <div id="crawl-msg" role="status" aria-live="polite"></div>
    <div class="panel" style="padding:0;overflow:hidden">
      <div class="table-wrap"><table class="table">
        <thead><tr>
          <th>批次</th><th>触发</th><th>状态</th><th>来源</th>
          <th>发现</th><th>新增</th><th>更新</th><th>开始时间</th><th></th>
        </tr></thead>
        <tbody id="runs-body">
          ${(runs || []).map((r) => `<tr>
            <td class="num">#${r.id}</td>
            <td>${esc({ cron: '定时', manual: '手动', retry: '重试' }[r.trigger] || r.trigger)}</td>
            <td><span class="badge ${statusBadgeCls(r.status)} badge--dot">${esc(r.status)}</span></td>
            <td class="num">${r.sources_ok ?? 0}/${r.sources_total ?? 0}</td>
            <td class="num">${r.items_found ?? 0}</td>
            <td class="num" style="color:var(--status-active);font-weight:600">${r.items_new ?? 0}</td>
            <td class="num">${r.items_updated ?? 0}</td>
            <td>${esc(r.started_at || '')}</td>
            <td><button class="btn btn--sm" data-run="${r.id}">详情</button></td>
          </tr>`).join('') || '<tr><td colspan="9" style="text-align:center;color:var(--text-muted);padding:30px">暂无抓取记录</td></tr>'}
        </tbody>
      </table></div>
    </div>
    <div id="run-detail" style="margin-top:16px" aria-live="polite"></div>
  </div>`;

  document.getElementById('runs-body')?.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-run]');
    if (!b) return;
    const detail = await api.getFetchRun(b.dataset.run);
    const el = document.getElementById('run-detail');
    const fails = (detail.attempts || []).filter((a) => !a.ok);
    el.innerHTML = `<div class="panel">
      <div class="panel__title">批次 #${detail.id} 详情
        <span style="float:right;text-transform:none;letter-spacing:0;font-weight:500;color:var(--text-muted)">
          ${esc(detail.started_at || '')} → ${esc(detail.finished_at || '进行中')}
        </span>
      </div>
      ${fails.length ? `<div class="notice notice--warn">该批次有 ${fails.length} 次失败尝试：</div>` : '<div class="notice notice--ok">该批次所有来源均成功</div>'}
      <div class="table-wrap"><table class="table">
        <thead><tr><th>厂商</th><th>来源</th><th>类型</th><th>尝试</th><th>状态</th><th>耗时</th><th>错误</th></tr></thead>
        <tbody>
          ${(detail.attempts || []).map((a) => `<tr>
            <td>${esc(a.provider_name)}</td>
            <td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
              <a href="${esc(safeUrl(a.source_url))}" target="_blank" rel="noopener noreferrer">${esc(a.source_url)}</a></td>
            <td>${esc(a.kind)}</td>
            <td class="num">#${a.attempt_no}</td>
            <td>${a.ok ? '<span class="badge badge--status-active">成功</span>' : '<span class="badge badge--status-ended">失败</span>'}</td>
            <td class="num">${a.duration_ms ?? '-'}ms</td>
            <td style="color:var(--text-muted);font-size:12.5px">${esc(a.error || '')}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>
    </div>`;
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  document.getElementById('run-crawl')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    document.getElementById('crawl-msg').innerHTML = '<div class="notice notice--info">抓取任务已启动，约 10~60 秒后完成，请稍后刷新本页查看新批次。</div>';
    try { await api.triggerCrawl(); } catch (err) {
      document.getElementById('crawl-msg').innerHTML = `<div class="notice notice--warn">${esc(err.message)}</div>`;
    }
    setTimeout(() => { e.target.disabled = false; }, 60000);
  });
}

// ---------------- 待审队列 ----------------

async function renderReview() {
  const mode = await api.detectMode();
  if (mode !== 'api') {
    $app.innerHTML = `<div class="page">
      <div class="page__head"><div class="page__title"><h1>待审队列</h1></div></div>
      <div class="notice notice--warn">静态托管版本不含人工审核功能，请在本地运行服务后使用。</div>
      <div style="margin-top:16px"><a class="btn" href="#/">返回首页</a></div>
    </div>`;
    return;
  }

  $app.innerHTML = `<div class="page"><div class="panel skeleton" style="height:300px"></div></div>`;
  const items = await api.getReviewQueue();

  $app.innerHTML = `<div class="page">
    <div class="page__head">
      <div class="page__title"><h1>待审队列 <span class="badge badge--status-upcoming">${items.length} 条</span></h1></div>
      <p class="page__desc">
        低置信度或字段不完整的条目会进入这里。审核通过后才会在前台展示。
        提高自动化程度可在 <code class="mono">config/settings.json</code> 配置 LLM 提取。
      </p>
    </div>
    <div id="review-msg" role="status" aria-live="polite"></div>
    ${items.length ? `<div class="cards">
      ${items.map((a) => `<article class="card" style="--cat-color:#9ca3af">
        <div class="card__top">
          <span class="card__provider">${providerDot(a)}${esc(a.provider.name)}</span>
          ${categoryBadge(a)}
          <span class="card__status"><span class="badge badge--region">待审</span></span>
        </div>
        <h3 class="card__title"><a href="#/activity/${a.id}">${esc(a.title)}</a></h3>
        <p class="card__summary">${esc(a.summary || a.sourceExcerpt || '（无摘要）')}</p>
        <div class="card__meta">
          <span class="meta-item">🎁 ${esc(benefitDisplay(a))}</span>
          <span class="meta-item">可信度 ${Math.round((a.confidence || 0) * 100)}%</span>
        </div>
        <div class="card__foot">
          <a class="btn btn--sm" href="${esc(safeUrl(a.sourceUrl || a.claimUrl))}" target="_blank" rel="noopener">看来源</a>
          <span class="spacer"></span>
          <button class="btn btn--sm" data-reject="${a.id}" style="color:var(--status-ended)">✕ 拒绝</button>
          <button class="btn btn--primary btn--sm" data-approve="${a.id}">✓ 通过</button>
        </div>
      </article>`).join('')}
    </div>` : emptyState({ icon: '✅', title: '队列已清空', desc: '所有活动都已审核完毕' })}
  </div>`;

  const msg = document.getElementById('review-msg');
  $app.querySelectorAll('[data-approve],[data-reject]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.approve || btn.dataset.reject;
      const action = btn.dataset.approve ? 'approve' : 'reject';
      btn.disabled = true;
      try {
        await api.reviewActivity(id, action);
        msg.innerHTML = `<div class="notice notice--ok">已${action === 'approve' ? '通过' : '拒绝'}并更新前台展示</div>`;
        setTimeout(renderReview, 700);
      } catch (err) {
        msg.innerHTML = `<div class="notice notice--warn">${esc(err.message)}</div>`;
        btn.disabled = false;
      }
    });
  });
}

// ---------------- 订阅 ----------------

async function renderSubscribe() {
  const mode = await api.detectMode();
  const feed = new URL(api.feedUrl(), location.href).href;
  const canPush = 'serviceWorker' in navigator && 'PushManager' in window;
  const isSecure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';

  let subState = 'off';
  let currentSub = null;
  if (canPush && isSecure) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      currentSub = reg ? await reg.pushManager.getSubscription() : null;
      if (currentSub) subState = 'on';
      else if (Notification.permission === 'denied') subState = 'denied';
    } catch { /* ignore */ }
  } else {
    subState = canPush ? 'insecure' : 'unsupported';
  }

  const statusHtml = {
    on: '<span class="sub-status sub-status--on">● 已开启浏览器通知</span>',
    off: '<span class="sub-status sub-status--off">○ 未开启</span>',
    denied: '<span class="sub-status sub-status--unsupported">已被浏览器阻止，请在地址栏权限设置中允许</span>',
    unsupported: '<span class="sub-status sub-status--unsupported">当前浏览器不支持推送通知</span>',
    insecure: '<span class="sub-status sub-status--unsupported">需要 HTTPS 或 localhost 才能使用推送</span>',
  }[subState] || '';

  $app.innerHTML = `<div class="page" style="max-width:820px">
    <div class="page__head">
      <div class="page__title"><h1>订阅新活动通知</h1></div>
      <p class="page__desc">有新活动收录时第一时间收到提醒。可选择只订阅你关心的厂商或类型。</p>
    </div>

    <div class="sub-card">
      <h3 style="margin-bottom:8px">浏览器推送通知</h3>
      <p style="color:var(--text-muted);font-size:13.5px;margin:0 0 12px">
        无需邮箱，直接在浏览器接收提醒。${mode === 'static' ? '<b>注意：静态托管版无服务端推送，请使用下方 RSS 订阅。</b>' : ''}
      </p>
      ${statusHtml}
      <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap">
        ${(subState === 'off' && mode === 'api' && isSecure && canPush)
      ? '<button class="btn btn--primary" id="push-enable">开启通知</button>' : ''}
        ${subState === 'on' ? '<button class="btn" id="push-disable">关闭通知</button>' : ''}
        ${mode === 'api' && isSecure && canPush ? '<button class="btn btn--ghost btn--sm" id="push-test">发送测试通知</button>' : ''}
      </div>
      <div id="sub-msg" style="margin-top:12px"></div>
    </div>

    <div class="sub-card">
      <h3 style="margin-bottom:8px">RSS / JSON 订阅（推荐，任何环境都可用）</h3>
      <p style="color:var(--text-muted);font-size:13.5px;margin:0">
        把下面地址加入任意 RSS 阅读器（Feedly、Inoreader、NetNewsWire 等），每天自动获取新活动。
      </p>
      <div class="feed-url">
        <code>${esc(feed)}</code>
        <button class="btn btn--sm" id="copy-feed">复制</button>
      </div>
      <div style="margin-top:10px;display:flex;gap:10px">
        <a class="btn btn--sm" href="${esc(safeUrl(feed))}" target="_blank" rel="noopener">预览 RSS</a>
        <a class="btn btn--sm" href="${esc(safeUrl(new URL('data/activities.json', location.href).href))}" target="_blank" rel="noopener">JSON 数据</a>
      </div>
    </div>

    <div class="sub-card">
      <h3 style="margin-bottom:8px">抓取机制说明</h3>
      <p style="color:var(--text-muted);font-size:13.5px;margin:0;line-height:1.8">
        · 每日 <b>10:00（北京时间）</b>自动抓取各厂商官网、定价页与公告页<br>
        · 抓取结果经过去重（指纹比对）、校验（链接白名单 + 量级检查）后入库<br>
        · 低置信度条目进入待审队列，人工确认后才展示<br>
        · 所有活动保留来源链接与文本摘要，数据可追溯
      </p>
    </div>
  </div>`;

  // 复制 feed
  document.getElementById('copy-feed')?.addEventListener('click', async (e) => {
    try {
      await navigator.clipboard.writeText(feed);
      e.target.textContent = '已复制 ✓';
      setTimeout(() => { e.target.textContent = '复制'; }, 1800);
    } catch {
      // 剪贴板不可用时选中文本
      const code = document.querySelector('.feed-url code');
      const r = document.createRange(); r.selectNodeContents(code);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    }
  });

  const msg = document.getElementById('sub-msg');

  // 开启推送
  document.getElementById('push-enable')?.addEventListener('click', async () => {
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { msg.innerHTML = '<div class="notice notice--warn">未获得通知权限</div>'; return; }

      const reg = await navigator.serviceWorker.register('js/sw.js');
      await navigator.serviceWorker.ready;

      const publicKey = await api.getVapidPublicKey();
      if (!publicKey) throw new Error('服务端未提供 VAPID 公钥');

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      await api.subscribe({ endpoint: sub.endpoint, keys: sub.toJSON().keys, filters: null });
      msg.innerHTML = '<div class="notice notice--ok">已开启通知，有新活动时会提醒你</div>';
      setTimeout(renderSubscribe, 900);
    } catch (err) {
      msg.innerHTML = `<div class="notice notice--warn">${esc(err.message)}</div>`;
    }
  });

  // 关闭推送
  document.getElementById('push-disable')?.addEventListener('click', async () => {
    try {
      if (currentSub) {
        await api.unsubscribe(currentSub.endpoint);
        await currentSub.unsubscribe();
      }
      msg.innerHTML = '<div class="notice notice--ok">已关闭通知</div>';
      setTimeout(renderSubscribe, 900);
    } catch (err) {
      msg.innerHTML = `<div class="notice notice--warn">${esc(err.message)}</div>`;
    }
  });

  document.getElementById('push-test')?.addEventListener('click', async () => {
    msg.innerHTML = '<div class="notice notice--info">测试通知需要服务端有新活动才会发送；可在抓取日志页触发一次抓取。</div>';
  });
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

// ---------------- 关于 ----------------

async function renderAbout() {
  const [meta, mode] = await Promise.all([api.getMeta(), api.detectMode()]);
  $app.innerHTML = `<div class="page" style="max-width:860px">
    <div class="page__head">
      <div class="page__title"><h1>关于本站</h1></div>
      <p class="page__desc">一个自动汇总 AI 厂商免费活动的开源站点。</p>
    </div>

    <div class="panel">
      <div class="panel__title">我们在做什么</div>
      <p style="font-size:14px;line-height:1.85;color:var(--text-secondary);margin:0">
        各家 AI 厂商的免费赠送、试用额度、学生认证优惠分散在官网、定价页、公告与社交媒体中，
        且活动节奏快、有效期短。本站每日自动抓取这些公开渠道，去重、校验、结构化后统一展示，
        并标注每一条活动的来源与最后核验时间，方便你判断"现在还能不能领"。
      </p>
    </div>

    <div class="panel">
      <div class="panel__title">数据分几层</div>
      <p style="font-size:13.5px;line-height:1.85;color:var(--text-secondary);margin:0 0 12px">
        站内数据分三层，区分「常态」与「限时」——这是判断一个免费额度能不能长期依赖的关键：
      </p>
      <div class="table-wrap"><table class="table">
        <tbody>
          <tr>
            <th style="width:110px">厂商</th>
            <td>51 家国内外 AI 厂商。声明式维护在 <code class="mono">config/providers.yaml</code>。</td>
          </tr>
          <tr>
            <th>端点</th>
            <td><b>长期有效的免费额度政策</b>。例如"Google AI Studio 免费层 15 RPM / 1500 RPD"。<br>
              相对稳定，适合作为长期可依赖的接入点。见「端点库」。</td>
          </tr>
          <tr>
            <th>模型</th>
            <td>能力载体，带能力分类（文本/代码/图像/视频/语音/嵌入）与上下文窗口。见「模型库」。</td>
          </tr>
          <tr>
            <th>活动</th>
            <td><b>限时促销</b>。例如"新用户注册送 ¥6 额度"，有明确起止时间。<br>
              通过关联字段挂到上面的模型/端点上，见「活动」页。</td>
          </tr>
        </tbody>
      </table></div>
      <p style="font-size:13px;color:var(--text-muted);margin:12px 0 0">
        一个模型可能同时有多个免费端点（不同厂商提供），门槛与额度各不相同。
        模型详情页会按「免绑卡 → 国内直连 → 有评分」的顺序给出推荐。
      </p>
    </div>

    <div class="panel">
      <div class="panel__title">数据来源与更新</div>
      <div class="table-wrap"><table class="table">
        <tbody>
          <tr><th style="width:140px">抓取范围</th><td>厂商官网、定价页、公告页、文档页（仅公开页面，不绕过登录）</td></tr>
          <tr><th>更新频率</th><td>每日 10:00（北京时间）自动抓取；也可手动触发</td></tr>
          <tr><th>数据字段</th><td>厂商、活动内容（额度/token/时长）、适用人群、起止时间、领取链接、来源摘要</td></tr>
          <tr><th>去重策略</th><td>指纹比对（厂商 + 归一化标题 + 归一化链接 + 起始日）；命中则比对字段差异，无变化则仅刷新"最后核验时间"</td></tr>
          <tr><th>状态判定</th><td>由数据库视图按北京时间实时派生：进行中 / 即将开始 / 已结束，不落库，避免状态僵化</td></tr>
          <tr><th>过期处理</th><td>结束超过 30 天自动软归档（保留数据可查，不物理删除）</td></tr>
          <tr><th>可追溯性</th><td>保留抓取批次、每次尝试的失败原因、原始页面文本快照、字段级变更历史</td></tr>
          <tr><th>当前模式</th><td>${mode === 'api' ? '完整版（本地/服务端运行，支持实时搜索、审核与推送）' : '静态只读版（GitHub Pages，筛选在浏览器内完成）'}</td></tr>
          ${meta?.generatedAt ? `<tr><th>数据生成时间</th><td>${esc(meta.generatedAt)}（北京时间）</td></tr>` : ''}
        </tbody>
      </table></div>
    </div>

    <div class="panel">
      <div class="panel__title">如何扩充厂商</div>
      <p style="font-size:13.5px;line-height:1.8;color:var(--text-secondary);margin:0 0 10px">
        厂商与数据源采用声明式配置，新增一家厂商只需在 <code class="mono">config/providers.yaml</code> 追加约 10 行：
      </p>
      <pre class="excerpt" style="margin:0">- slug: newprovider
  name_zh: 新厂商
  country: CN
  website: https://example.com
  cn_accessible: true
  sources:
    - kind: pricing
      url: https://example.com/pricing
    - kind: announcement
      url: https://example.com/blog</pre>
      <p style="font-size:13px;color:var(--text-muted);margin:10px 0 0">
        保存后执行 <code class="mono">npm run migrate</code> 即完成同步，下次抓取自动纳入。
      </p>
    </div>

    <div class="panel">
      <div class="panel__title">免责声明</div>
      <p style="font-size:13.5px;line-height:1.85;color:var(--text-secondary);margin:0">
        本站为信息聚合工具，所有活动信息均由程序自动抓取并可能存在延迟、遗漏或偏差。
        活动的额度、时间、资格与最终解释权均归各厂商所有，请以厂商官方页面为准。
        若发现信息有误，欢迎通过来源链接核对；本站不参与任何活动的发放。
      </p>
    </div>
  </div>`;
}

// ---------------- 模型库 ----------------

/**
 * 能力选择条。
 *
 * 用 <a> 而非 <button>：筛选状态体现在 URL（可分享、可后退、可被搜索引擎抓取），
 * 按钮 + JS 状态很难做到这点，且刷新后会丢失。
 *
 * `countField` 必须按页面传对 —— 这是踩过的坑：
 * `/api/capabilities` 同时返回 endpointCount / modelCount / activityCount 三个口径。
 * 模型库按**模型**筛、端点库按**端点**筛；若统一读同一个字段，
 * 会出现 chip 写"文本嵌入 7"、点进去只列出 3 条的不一致，看起来像数据算错。
 */
function renderCapBar(caps, activeCap, basePath, baseQuery = {}, { extra = {}, countField = 'count', hint = '' } = {}) {
  const set = new Set(String(activeCap || '').split(',').filter(Boolean));
  const chip = (value, label, count, color) => {
    const isOn = set.has(value);
    const next = new Set(set);
    if (isOn) next.delete(value); else next.add(value);
    const q = { ...baseQuery, ...extra };
    if (next.size) q.capability = [...next].join(','); else delete q.capability;
    delete q.page;
    return `<a class="cap-chip ${isOn ? 'is-active' : ''}" style="--cap-color:${color}"
      href="#/${basePath}${buildQueryString(q)}"
      aria-pressed="${isOn}" title="${esc(label)}">${esc(label)}${count != null ? ` <span class="cap-chip__n">${count}</span>` : ''}</a>`;
  };

  return `<div class="cap-bar" role="group" aria-label="按模型能力筛选">
    <a class="cap-chip ${set.size ? '' : 'is-active'}" style="--cap-color:var(--brand)"
       href="#/${basePath}${buildQueryString({ ...baseQuery, ...extra })}">全部</a>
    ${(caps || []).map((c) => chip(c.value, c.label, c[countField], capColor(c.value))).join('')}
  </div>
  ${hint ? `<div style="font-size:11.5px;color:var(--text-faint);margin:-10px 0 14px">${esc(hint)}</div>` : ''}`;
}

async function renderModels(query) {
  $app.innerHTML = `<div class="page">
    <div class="page__head">
      <div class="page__title"><h1>模型库</h1></div>
      <p class="page__desc">按能力维度浏览已收录的大模型，查看每个模型当前有哪些免费端点可领。</p>
    </div>
    <div class="cap-bar"></div>
    <div class="cards">${skeletonCards(8)}</div>
  </div>`;

  const [caps, models] = await Promise.all([
    api.getCapabilities(),
    api.getModels(query),
  ]);

  const capMap = Object.fromEntries((caps || []).map((c) => [c.value, c.label]));

  $app.innerHTML = `<div class="page">
    <div class="page__head">
      <div class="page__title"><h1>模型库</h1></div>
      <p class="page__desc">
        共 ${models.length} 个模型${query.capability ? `（能力：${esc(String(query.capability).split(',').map((c) => capMap[c] || c).join('、'))}）` : ''}。
        模型是"能力载体"，端点才是"能白嫖的入口" —— 点进模型可看到它在各家厂商下的免费端点。
      </p>
    </div>
    ${renderCapBar(caps, query.capability, 'models', {}, { countField: 'modelCount', hint: '数字为该能力下的模型数量' })}
    <div class="cards">
      ${models.length ? models.map(modelCard).join('') : emptyState({
    icon: '🧠', title: '没有匹配的模型',
    desc: '试试切换其它能力，或到「活动」页用关键词搜索',
  })}
    </div>
  </div>`;
}

async function renderModelDetail(slug) {
  if (!slug) { location.hash = '#/models'; return; }
  $app.innerHTML = `<div class="page"><div class="panel skeleton" style="height:320px"></div></div>`;

  const m = await api.getModel(slug);
  if (!m) {
    $app.innerHTML = `<div class="page">${emptyState({ icon: '🧠', title: '未找到该模型', desc: '它可能尚未收录，或链接有误' })}</div>`;
    return;
  }

  const caps = (m.capabilities && m.capabilities.length) ? m.capabilities : [m.capability];
  const labels = m.capabilityLabels || caps;
  const eps = m.endpoints || [];
  const acts = m.activities || [];
  const color = capColor(caps[0]);

  // 端点按"免绑卡 → 国内直连 → 有评分"排序：越靠前越省事
  const sortedEps = eps.slice().sort((a, b) =>
    (a.requiresCard - b.requiresCard)
    || (b.cnAccessible - a.cnAccessible)
    || ((b.score ?? -1) - (a.score ?? -1)));

  $app.innerHTML = `<div class="page">
    <div style="margin-bottom:14px"><a href="#/models" class="btn btn--ghost btn--sm">← 模型库</a></div>

    <div class="panel" style="border-left:4px solid ${color}">
      <div class="ep-head">
        <div class="ep-head__main">
          <h1 class="ep-head__title">${esc(m.name)}</h1>
          <div class="ep-head__sub">
            ${esc(m.vendorSlug || '')}${m.isMultimodal ? ' · 原生多模态' : ''}${m.isOpenWeights ? ' · 开源权重' : ''}
            ${m.releasedAt ? ` · 发布于 ${esc(m.releasedAt)}` : ''}
          </div>
          <div class="card__tags" style="margin-top:12px">
            ${caps.map((c, i) => capabilityBadge(c, labels[i])).join('')}
          </div>
        </div>
      </div>

      ${m.description ? `<p class="detail__summary" style="margin-top:16px;margin-bottom:0">${esc(m.description)}</p>` : ''}

      <div class="field-grid" style="margin-top:18px">
        <div class="field">
          <div class="field__label">上下文窗口</div>
          <div class="field__value">${m.contextWindow ? esc(fmtTokens(m.contextWindow)) : '<span style="color:var(--text-faint)">未收录</span>'}</div>
        </div>
        <div class="field">
          <div class="field__label">最大输出</div>
          <div class="field__value">${m.maxOutput ? esc(fmtTokens(m.maxOutput)) : '<span style="color:var(--text-faint)">未收录</span>'}</div>
        </div>
        <div class="field">
          <div class="field__label">可领端点</div>
          <div class="field__value field__value--big">${eps.length}</div>
        </div>
        <div class="field">
          <div class="field__label">关联活动</div>
          <div class="field__value field__value--big">${acts.length}</div>
        </div>
      </div>

      <div style="margin-top:18px;display:flex;gap:9px;flex-wrap:wrap">
        ${m.homepageUrl ? `<a class="btn btn--sm" href="${esc(safeUrl(m.homepageUrl))}" target="_blank" rel="noopener noreferrer">模型主页</a>` : ''}
        <a class="btn btn--sm" href="#/activities?capability=${esc(caps[0])}">看相关活动 →</a>
      </div>
    </div>

    <div class="page__head" style="margin-top:26px">
      <div class="page__title"><h2>免费端点（${sortedEps.length}）</h2></div>
      <p class="page__desc">同一个模型在不同厂商/平台下可能有多个免费入口，门槛与额度各不相同。</p>
    </div>
    <div class="cards">
      ${sortedEps.length ? sortedEps.map(endpointCard).join('') : emptyState({
    icon: '🔌', title: '该模型暂无免费端点',
    desc: '它可能只在付费端点提供，或免费额度尚未被收录',
  })}
    </div>

    ${acts.length ? `
      <div class="page__head" style="margin-top:26px">
        <div class="page__title"><h2>关联活动（${acts.length}）</h2></div>
      </div>
      <div class="cards">${acts.map(activityCard).join('')}</div>` : ''}
  </div>`;
}

// ---------------- 端点库 ----------------

async function renderEndpoints(query) {
  $app.innerHTML = `<div class="page">
    <div class="page__head">
      <div class="page__title"><h1>免费端点库</h1></div>
      <p class="page__desc">按门槛挑最省事的那一个。</p>
    </div>
    <div class="cap-bar"></div>
    <div class="cards">${skeletonCards(8)}</div>
  </div>`;

  const [caps, list] = await Promise.all([
    api.getCapabilities(),
    api.getEndpoints(query),
  ]);
  const capMap = Object.fromEntries((caps || []).map((c) => [c.value, c.label]));

  const toggles = [
    ['no_card', '免绑卡'],
    ['cn_accessible', '国内直连'],
    ['openai_compatible', 'OpenAI 兼容'],
  ];
  const toggleBar = `<div class="toolbar" style="margin-bottom:14px">
    ${toggles.map(([k, label]) => {
    const on = query[k] === '1';
    const q = { ...query, [k]: on ? '' : '1' };
    if (!q[k]) delete q[k];
    delete q.page;
    return `<a class="cap-chip ${on ? 'is-active' : ''}" style="--cap-color:var(--brand)"
        href="#/endpoints${buildQueryString(q)}">${on ? '✓ ' : ''}${esc(label)}</a>`;
  }).join('')}
    <span class="spacer" style="flex:1"></span>
    <span style="font-size:13.5px;color:var(--text-muted)">共 ${list.length} 个端点</span>
  </div>`;

  $app.innerHTML = `<div class="page">
    <div class="page__head">
      <div class="page__title"><h1>免费端点库</h1></div>
      <p class="page__desc">
        端点 = 一个厂商给出的、长期有效的免费额度政策。相比"限时活动"，端点更稳定，
        适合作为长期可依赖的接入点。共 ${list.length} 个端点，覆盖 ${new Set(list.map((e) => e.provider.slug)).size} 家厂商。
      </p>
    </div>
    ${renderCapBar(caps, query.capability, 'endpoints', {}, { countField: 'endpointCount', hint: '数字为该能力下的端点数量' })}
    ${toggleBar}
    <div class="cards">
      ${list.length ? list.map(endpointCard).join('') : emptyState({
    icon: '🔌', title: '没有匹配的端点',
    desc: query.capability ? `当前能力（${esc(capMap[query.capability] || query.capability)}）下暂无免绑卡 + 国内直连的组合，试试放宽条件` : '试试放宽筛选条件',
  })}
    </div>
  </div>`;
}

async function renderEndpointDetail(providerSlug, modelSlug) {
  if (!providerSlug || !modelSlug) { location.hash = '#/endpoints'; return; }
  $app.innerHTML = `<div class="page"><div class="panel skeleton" style="height:320px"></div></div>`;

  const e = await api.getEndpoint(providerSlug, modelSlug);
  if (!e) {
    $app.innerHTML = `<div class="page">${emptyState({ icon: '🔌', title: '未找到该端点', desc: '它可能已下线，或链接有误' })}</div>`;
    return;
  }

  const color = capColor(e.model.capability);
  const acts = e.activities || [];
  const alts = e.alternatives || [];

  // 速率限制单独成块：很多"免费"其实是速率限制型，用户最关心 RPM/RPD
  const rateRows = [
    ['RPM（每分钟）', e.quotaRpm],
    ['RPD（每日）', e.quotaRpd],
    ['TPM（每分钟 token）', e.quotaTpm],
  ].filter(([, v]) => v != null);

  $app.innerHTML = `<div class="page">
    <div style="margin-bottom:14px"><a href="#/endpoints" class="btn btn--ghost btn--sm">← 端点库</a></div>

    <div class="panel" style="border-left:4px solid ${color}">
      <div class="ep-head">
        <div class="ep-head__main">
          <div class="card__provider" style="font-size:13.5px;margin-bottom:6px">
            <span class="card__dot" style="background:${esc(e.provider.color || '#2563eb')}"></span>
            <a href="#/provider/${esc(e.provider.slug)}">${esc(e.provider.name)}</a>
          </div>
          <h1 class="ep-head__title">${esc(e.model.name)}</h1>
          <div class="ep-head__sub">
            <a href="#/model/${esc(e.model.slug)}">查看模型详情</a>
            ${e.quotaKindLabel ? ` · ${esc(e.quotaKindLabel)}` : ''}
          </div>
        </div>
        <div class="ep-head__score">
          ${scoreRing(e.score, e.scoreSource)}
          <div style="font-size:11.5px;color:var(--text-faint);margin-top:5px">
            ${e.score != null ? '综合评分' : '暂无评分'}
          </div>
        </div>
      </div>

      <div class="card__tags" style="margin-top:14px">
        ${capabilityBadge(e.model.capability, e.model.capabilityLabel)}
        ${endpointFlags(e)}
      </div>
    </div>

    <div class="panel">
      <div class="panel__title">额度与速率</div>
      <div class="ep-quota">
        <div class="ep-quota__label">免费额度</div>
        <div class="ep-quota__text">${esc(quotaDisplay(e))}</div>
      </div>
      ${rateRows.length ? `<dl class="ep-kv">
        ${rateRows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
      </dl>` : ''}
    </div>

    <div class="panel">
      <div class="panel__title">接入信息</div>
      <dl class="ep-kv">
        <dt>API Base</dt>
        <dd>${e.apiBaseUrl ? `<code class="mono">${esc(e.apiBaseUrl)}</code>` : '<span style="color:var(--text-faint)">未收录</span>'}</dd>
        <dt>OpenAI 兼容</dt>
        <dd>${e.openaiCompatible ? '<span class="badge badge--ok">是</span>' : '<span class="badge badge--neutral">否 / 未确认</span>'}</dd>
        <dt>访问网络</dt>
        <dd>${e.cnAccessible ? '<span class="badge badge--ok">国内可直连</span>' : '<span class="badge badge--warn">需海外网络</span>'}</dd>
        <dt>支付门槛</dt>
        <dd>${e.requiresCard ? '<span class="badge badge--warn">需绑定支付方式</span>' : '<span class="badge badge--ok">无需绑卡</span>'}</dd>
        ${e.requiresPhone ? '<dt>手机号</dt><dd>需验证手机号</dd>' : ''}
        ${e.verifiedAt ? `<dt>最后核验</dt><dd>${esc(relTime(e.verifiedAt))}</dd>` : ''}
      </dl>
      <div style="margin-top:16px;display:flex;gap:9px;flex-wrap:wrap">
        <a class="btn btn--primary" href="${esc(safeUrl(e.claimUrl || e.provider.website))}" target="_blank" rel="noopener noreferrer">前往领取 / 接入 →</a>
        ${e.docsUrl ? `<a class="btn" href="${esc(safeUrl(e.docsUrl))}" target="_blank" rel="noopener noreferrer">API 文档</a>` : ''}
        ${e.provider.website ? `<a class="btn" href="${esc(safeUrl(e.provider.website))}" target="_blank" rel="noopener noreferrer">厂商官网</a>` : ''}
      </div>
    </div>

    ${acts.length ? `<div class="panel">
      <div class="panel__title">关联活动（${acts.length}）</div>
      <div class="cards">${acts.map(activityCard).join('')}</div>
    </div>` : ''}

    ${alts.length ? `<div class="panel">
      <div class="panel__title">同模型的其它端点（${alts.length}）</div>
      <p style="font-size:13px;color:var(--text-muted);margin:0 0 12px">
        下面这些端点提供同一个模型，门槛或额度可能更划算。
      </p>
      <div class="cards">${alts.map(endpointCard).join('')}</div>
    </div>` : ''}

    <div class="panel">
      <div class="panel__title">免责声明</div>
      <p style="font-size:12.5px;color:var(--text-muted);margin:0;line-height:1.7">
        额度与速率上限由厂商随时调整，可能存在滞后。请以厂商官方文档为准。
      </p>
    </div>
  </div>`;
}

// ---------------- 攻略 ----------------

async function renderGuides() {
  $app.innerHTML = `<div class="page"><div class="cards">${skeletonCards(4)}</div></div>`;
  const guides = await api.getGuides();

  $app.innerHTML = `<div class="page">
    <div class="page__head">
      <div class="page__title"><h1>攻略 / 解读</h1></div>
      <p class="page__desc">
        免费额度活动往往"能领但不能用"——额度仅限客户端、需要绑卡、国内无法直连。
        这里拆解具体活动的真实规则与踩坑点，以及一套可复用的选择方法。
      </p>
    </div>
    <div class="cards">
      ${guides.length ? guides.map(guideCard).join('') : emptyState({ icon: '📖', title: '暂无攻略', desc: '攻略会在收录到高价值活动后自动生成' })}
    </div>
  </div>`;
}

async function renderGuideDetail(slug) {
  if (!slug) { location.hash = '#/guides'; return; }
  $app.innerHTML = `<div class="page"><div class="panel skeleton" style="height:420px"></div></div>`;

  const g = await api.getGuide(slug);
  if (!g) {
    $app.innerHTML = `<div class="page">${emptyState({ icon: '📖', title: '未找到该攻略', desc: '它可能已下线，或链接有误' })}</div>`;
    return;
  }

  const sections = g.sections || [];
  // 目录锚点：id 由序号生成而非标题，避免中文标题进 id 后被 encode 破坏锚点
  const toc = sections.length > 2
    ? `<div class="panel">
        <div class="panel__title">目录</div>
        <div class="article__toc">
          ${sections.map((s, i) => `<div><a href="#/guide/${esc(g.slug)}#s${i}">${esc(s.title)}</a></div>`).join('')}
        </div>
      </div>`
    : '';

  $app.innerHTML = `<div class="page" style="max-width:860px">
    <div style="margin-bottom:14px"><a href="#/guides" class="btn btn--ghost btn--sm">← 攻略列表</a></div>

    <div class="page__head">
      <div class="page__title"><h1>${esc(g.title)}</h1></div>
      <p class="page__desc">${esc(g.summary || '')}</p>
      <div class="card__tags" style="margin-top:12px">
        ${(g.tags || []).map((t) => `<span class="badge badge--neutral">${esc(t)}</span>`).join('')}
        ${g.publishedAt ? `<span class="badge badge--neutral">${esc(g.publishedAt)}</span>` : ''}
      </div>
      <div style="display:flex;gap:9px;flex-wrap:wrap;margin-top:14px">
        ${g.providerSlug ? `<a class="btn btn--sm" href="#/provider/${esc(g.providerSlug)}">相关厂商</a>` : ''}
        ${g.modelSlug ? `<a class="btn btn--sm" href="#/model/${esc(g.modelSlug)}">相关模型</a>` : ''}
        <a class="btn btn--sm" href="#/activities?q=${encodeURIComponent(g.tags?.[0] || '')}">看相关活动 →</a>
      </div>
    </div>

    ${toc}

    <div class="panel">
      <div class="article">
        ${sections.map((s, i) => `
          <h2 id="s${i}">${esc(s.title)}</h2>
          ${renderGuideBody(s.body)}
        `).join('')}
      </div>
    </div>

    <div class="panel">
      <div class="panel__title">免责声明</div>
      <p style="font-size:12.5px;color:var(--text-muted);margin:0;line-height:1.7">
        本文基于公开信息整理，活动规则可能随时调整。最终解释权归厂商所有，请以官方页面为准。
      </p>
    </div>
  </div>`;

  // 站内锚点跳转（#/guide/x#s1）不会触发 hashchange，需要手动滚动
  if (location.hash.includes('#s')) {
    const id = location.hash.split('#').pop();
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

/**
 * 攻略正文渲染。
 *
 * 输入来自 config/guides.yaml 的纯文本，属于可信来源（仓库存档、非用户输入），
 * 因此这里做的是"轻量 Markdown 子集"渲染，而不是 HTML 转义。
 * 但为防配置被污染，仍先转义再按行还原受支持的语法 —— 顺序不能反。
 */
function renderGuideBody(body) {
  const raw = String(body ?? '').replace(/^\n+|\n+$/g, '');
  if (!raw) return '';
  const text = esc(raw);

  const blocks = text.split(/\n{2,}/).map((chunk) => {
    const lines = chunk.split('\n');
    // 无序列表
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
    }
    // 有序列表
    if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
      return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('')}</ol>`;
    }
    // 引用
    if (lines.every((l) => /^\s*&gt;\s?/.test(l))) {
      return `<blockquote><p>${lines.map((l) => inline(l.replace(/^\s*&gt;\s?/, ''))).join('<br>')}</p></blockquote>`;
    }
    return `<p>${inline(lines.join('<br>'))}</p>`;
  });

  return blocks.join('');
}

/** 行内语法：**加粗**、`代码`。输入必须已 esc()。 */
function inline(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

// ---------------- 启动 ----------------

/**
 * 一次性启动。
 *
 * ⚠️ 修复了首屏重复渲染：原先同时挂了 DOMContentLoaded 监听 + 底部的
 * `if (document.readyState !== 'loading')` 分支。而 <script type="module">
 * 位于 </body> 之前、且 module 默认 defer —— 执行时 readyState 已经是
 * 'interactive'，于是**两个入口都会跑**，render() 被调用两次。
 * 后果：首屏所有数据请求发两遍（线上实测 /api/stats 发 2 次、
 * 活动/meta 各 2 次），且 currentState 被后一次覆盖，容易出现竞态导致的
 * 列表闪烁。改为用 started 标志位守住，只启动一次。
 */
let started = false;
async function boot() {
  if (started) return;
  started = true;

  await api.detectMode();

  // 注册 Service Worker（仅 HTTPS / localhost）
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('js/sw.js').catch(() => {});
  }

  await render();
}

window.addEventListener('hashchange', render);
window.addEventListener('DOMContentLoaded', boot);
// 兜底：若脚本执行时 DOM 已就绪（module 默认 defer，通常如此），
// DOMContentLoaded 不会再触发，这里直接启动。boot() 自身幂等，重复调用无害。
if (document.readyState !== 'loading') boot();

