/**
 * push.js — Web Push 通知
 *
 * 需要：
 *   - VAPID 密钥对（首次自动生成，私钥存 config/.vapid.json，公钥入库 app_settings）
 *   - HTTPS（localhost 视为安全上下文，本地可测；线上由托管域名提供 HTTPS）
 *
 * 用法：
 *   node src/notify/push.js --generate-keys   # 生成 VAPID 密钥
 *   node src/notify/push.js --test            # 给所有订阅发一条测试
 */

import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { getDb, get, all, run, PROJECT_ROOT } from '../db/db.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('push');
const VAPID_FILE = path.join(PROJECT_ROOT, 'config', '.vapid.json');

/** 读取或生成 VAPID 密钥；返回 {publicKey, privateKey} */
export function ensureVapidKeys(db = getDb()) {
  // 1) 环境变量优先（部署时用）
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  // 2) 本地密钥文件
  if (fs.existsSync(VAPID_FILE)) {
    try {
      const k = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
      if (k.publicKey && k.privateKey) return k;
    } catch { /* 损坏则重新生成 */ }
  }
  // 3) 生成新密钥
  const keys = webpush.generateVAPIDKeys();
  try {
    fs.mkdirSync(path.dirname(VAPID_FILE), { recursive: true });
    fs.writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2), 'utf8');
    log.info('已生成 VAPID 密钥并写入 config/.vapid.json（请勿提交到版本库）');
  } catch (err) {
    log.warn('VAPID 密钥文件写入失败', { err: err.message });
  }
  // 公钥入库，便于前端读取
  try {
    run(db, `INSERT INTO app_settings (key, value, updated_at) VALUES ('vapid_public_key', ?, datetime('now'))
             ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`, [keys.publicKey]);
  } catch { /* ignore */ }
  return keys;
}

export function getVapidPublicKey(db = getDb()) {
  const row = get(db, `SELECT value FROM app_settings WHERE key='vapid_public_key'`);
  if (row?.value) return row.value;
  return ensureVapidKeys(db).publicKey;
}

let configured = false;
function configure(db) {
  if (configured) return;
  const keys = ensureVapidKeys(db);
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:tokenfree@example.com',
    keys.publicKey,
    keys.privateKey
  );
  configured = true;
}

/**
 * 对所有活跃订阅推送新活动。
 * 每条订阅可带 filters（JSON：{providers:[], categories:[]}），匹配则推送。
 */
export async function notifyNewActivities(db, newIds, settings = {}) {
  if (!newIds || !newIds.length) return { sent: 0, failed: 0, skipped: true };

  const subs = all(db, `SELECT * FROM subscriptions WHERE active=1`);
  if (!subs.length) return { sent: 0, failed: 0, skipped: true };

  configure(db);

  const items = newIds
    .map((id) => get(db, 'SELECT * FROM v_activities WHERE id=?', [id]))
    .filter(Boolean);

  let sent = 0, failed = 0;

  for (const sub of subs) {
    const filters = parseFilters(sub.filters);
    const matched = items.filter((it) => matchFilters(it, filters));
    if (!matched.length) continue;

    const payload = JSON.stringify(buildPayload(matched, settings));
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
      sent++;
      run(db, `UPDATE subscriptions SET last_push_at=datetime('now'), fail_count=0 WHERE id=?`, [sub.id]);
      run(db, `INSERT INTO push_log (subscription_id, activity_id, ok, status_code) VALUES (?,?,1,201)`,
        [sub.id, matched[0].id]);
    } catch (err) {
      failed++;
      const code = err?.statusCode ?? null;
      run(db, `UPDATE subscriptions SET fail_count = fail_count + 1 WHERE id=?`, [sub.id]);
      // 410/404 = 订阅已失效 → 停用
      if (code === 410 || code === 404) {
        run(db, `UPDATE subscriptions SET active=0 WHERE id=?`, [sub.id]);
        log.info('订阅已失效，自动停用', { endpoint: sub.endpoint.slice(0, 50) });
      }
      run(db, `INSERT INTO push_log (subscription_id, activity_id, ok, status_code, error) VALUES (?,?,0,?,?)`,
        [sub.id, matched[0].id, code, String(err.message || err).slice(0, 300)]);
      log.warn('推送失败', { code, err: String(err.message || err).slice(0, 120) });
    }
  }
  return { sent, failed };
}

function buildPayload(items, settings) {
  const n = items.length;
  const first = items[0];
  const title = n === 1
    ? `【${first.provider_name}】${first.title}`
    : `新增 ${n} 条 AI 免费活动`;
  const body = n === 1
    ? (first.benefit_text || first.summary || '点击查看详情')
    : items.slice(0, 3).map((i) => `• ${i.provider_name}：${i.title}`).join('\n');
  const base = settings.export?.siteUrl || '';
  return {
    title: String(title).slice(0, 80),
    body: String(body).slice(0, 200),
    url: base ? `${base.replace(/\/$/, '')}/#/activity/${first.id}` : `/#/activity/${first.id}`,
    count: n,
    ids: items.map((i) => i.id),
    tag: 'tokenfree-new',
  };
}

function parseFilters(f) {
  if (!f) return {};
  try { return typeof f === 'string' ? JSON.parse(f) : f; } catch { return {}; }
}

function matchFilters(item, filters) {
  if (filters.providers?.length && !filters.providers.includes(item.provider_slug)) return false;
  if (filters.categories?.length && !filters.categories.includes(item.category)) return false;
  if (filters.audience?.length) {
    let aud = [];
    try { aud = JSON.parse(item.audience); } catch { aud = []; }
    if (!filters.audience.some((a) => aud.includes(a))) return false;
  }
  return true;
}

/** 保存订阅 */
export function saveSubscription(db, { endpoint, keys, filters, userAgent }) {
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    throw new Error('订阅信息不完整（需要 endpoint / keys.p256dh / keys.auth）');
  }
  run(db, `INSERT INTO subscriptions (endpoint, p256dh, auth, filters, user_agent)
           VALUES (?,?,?,?,?)
           ON CONFLICT(endpoint) DO UPDATE SET
             p256dh=excluded.p256dh, auth=excluded.auth,
             filters=excluded.filters, active=1, fail_count=0`,
    [endpoint, keys.p256dh, keys.auth, filters ? JSON.stringify(filters) : null, userAgent || null]);
  return get(db, 'SELECT * FROM subscriptions WHERE endpoint=?', [endpoint]);
}

/** 取消订阅 */
export function removeSubscription(db, endpoint) {
  return run(db, 'DELETE FROM subscriptions WHERE endpoint=?', [endpoint]).changes;
}

// ---------------- CLI ----------------
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const db = getDb();
  if (process.argv.includes('--generate-keys')) {
    const k = ensureVapidKeys(db);
    console.log('VAPID 公钥（可公开，写入前端）：\n' + k.publicKey);
    console.log('\n私钥已存 config/.vapid.json，请勿泄露或提交版本库。');
  } else if (process.argv.includes('--test')) {
    configure(db);
    const subs = all(db, `SELECT id FROM subscriptions WHERE active=1`);
    console.log(`当前活跃订阅：${subs.length} 条`);
    if (subs.length) {
      const r = await notifyNewActivities(db, all(db, 'SELECT id FROM activities LIMIT 1').map((x) => x.id));
      console.log(`测试推送：成功 ${r.sent} / 失败 ${r.failed}`);
    } else {
      console.log('没有订阅，无法测试。请先在网页上开启通知。');
    }
  } else {
    console.log('用法：node src/notify/push.js --generate-keys | --test');
  }
}
