/**
 * sw.js — Service Worker
 *
 * 职责：
 *   1. 接收 Web Push 消息（新活动上线提醒），点击通知跳转到活动详情
 *   2. 消息类型：new_activities / ending_soon / test
 *   3. 极简离线壳缓存（仅缓存 HTML/CSS 主壳，数据始终走网络，避免陈旧数据）
 *
 * 设计取舍：本项目数据具有强时效性（活动起止、截止倒计时），
 * 因此不对 data/*.json 与 /api/* 做缓存——宁可联网失败提示，也不展示过期数据。
 *
 * ⚠️ 版本号维护：`npm run build` 会在导出的 public/ 副本里把 SW_VERSION
 * 重写为构建时间戳，确保每次部署都能触发 SW 更新。仓库里的这份源文件
 * 保持 'dev' 即可，不要手工改（改了也会被构建覆盖）。
 */

const SW_VERSION = '202610031904';
const CACHE_PREFIX = 'tokenfree-shell-';
const SHELL_CACHE = `${CACHE_PREFIX}${SW_VERSION}`;
const SHELL_ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/api.js',
  './js/components.js',
];

// ---------------- 安装 / 激活 ----------------

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // 逐个 add，任一失败不影响整体安装
      await Promise.allSettled(SHELL_ASSETS.map((u) => cache.add(u)));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== SHELL_CACHE).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// ---------------- 请求拦截 ----------------

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 数据接口一律走网络，不做缓存兜底
  if (
    url.pathname.includes('/api/') ||
    url.pathname.endsWith('.json') ||
    url.pathname.endsWith('.xml')
  ) {
    return; // 交给浏览器默认行为
  }

  // 导航请求：网络优先，失败回退缓存壳
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(req);
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          return (await cache.match('./index.html')) || Response.error();
        }
      })()
    );
    return;
  }

  // 静态资源：stale-while-revalidate
  // 命中缓存即刻返回（快），同时后台拉新写入缓存（下次生效）。
  // 配合构建期版本号，部署新版后会生成新缓存桶，不会永久陈旧。
  if (/\.(css|js|svg|png|jpe?g|webp|woff2?|ico)$/i.test(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE);
        const cached = await cache.match(req, { ignoreSearch: true });
        const network = fetch(req)
          .then((res) => {
            if (res && res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => null);
        if (cached) { event.waitUntil(network); return cached; }
        const fresh = await network;
        return fresh || Response.error();
      })()
    );
  }
});

// ---------------- Push 消息 ----------------

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { type: 'new_activities', title: 'Token Free', body: event.data ? event.data.text() : '有新活动' };
  }

  const type = payload.type || 'new_activities';
  const items = Array.isArray(payload.items) ? payload.items : [];

  // 单体通知（点击可直达详情）
  if (items.length === 1) {
    const it = items[0];
    event.waitUntil(
      self.registration.showNotification(it.title || payload.title || '有新活动上线', {
        body: it.body || payload.body || '',
        icon: 'data/icon-192.png',
        badge: 'data/icon-192.png',
        tag: `tf-activity-${it.id}`,
        renotify: false,
        data: { url: it.url || '#/activities', id: it.id, type },
      })
    );
    return;
  }

  // 批量通知：合并为一条
  if (items.length > 1) {
    const names = items.slice(0, 3).map((x) => x.title).filter(Boolean);
    const more = items.length > 3 ? ` 等 ${items.length} 条` : '';
    event.waitUntil(
      self.registration.showNotification(payload.title || `新增 ${items.length} 条免费活动`, {
        body: names.join(' / ') + more,
        icon: 'data/icon-192.png',
        badge: 'data/icon-192.png',
        tag: 'tf-batch',
        data: { url: '#/activities?is_new=1', type },
      })
    );
    return;
  }

  // 无 items 的通用通知（含测试推送）
  event.waitUntil(
    self.registration.showNotification(payload.title || 'Token Free', {
      body: payload.body || '有新内容',
      icon: 'data/icon-192.png',
      badge: 'data/icon-192.png',
      tag: 'tf-generic',
      data: { url: payload.url || '#/', type },
    })
  );
});

// ---------------- 通知点击 ----------------

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '#/';

  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

      // 已有窗口：聚焦并跳转
      for (const c of all) {
        if ('focus' in c) {
          await c.focus();
          if ('navigate' in c) {
            try { await c.navigate(target); } catch { /* 跨域等情况忽略 */ }
          }
          return;
        }
      }
      // 无窗口：新开
      if (self.clients.openWindow) await self.clients.openWindow(target);
    })()
  );
});

// ---------------- 订阅失效 ----------------

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const sub = event.newSubscription || (await self.registration.pushManager.getSubscription());
        if (!sub) return;
        await fetch('/api/subscribe', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ subscription: sub.toJSON(), oldEndpoint: event.oldSubscription?.endpoint }),
        });
      } catch (e) {
        // 静默失败：下次页面打开时会重新校验
      }
    })()
  );
});

// ---------------- 与页面通信 ----------------

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (data.type === 'PING') {
    event.source?.postMessage?.({ type: 'PONG', version: SW_VERSION });
  }
});
