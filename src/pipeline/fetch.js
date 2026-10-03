/**
 * fetch.js — 抓取器
 *
 * 能力：
 *   - 超时控制（AbortSignal.timeout）
 *   - 指数退避重试（仅对网络错误 / 5xx / 429；4xx 不重试）
 *   - 域名级串行 + 间隔限流（礼貌抓取）
 *   - robots.txt 检查与缓存
 *   - 每次尝试落 fetch_attempts，成功落 raw_snapshots
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../lib/logger.js';
import { withRetry, DomainThrottle, sleep } from '../lib/retry.js';
import { contentHash } from '../lib/fingerprint.js';
import { run, get, PROJECT_ROOT } from '../db/db.js';

const log = createLogger('fetch');
const HTML_DIR = path.join(PROJECT_ROOT, 'logs', 'html');

/** 带 httpStatus 的错误，供 retry 判断是否可重试 */
class HttpError extends Error {
  constructor(message, httpStatus) {
    super(message);
    this.name = 'HttpError';
    this.httpStatus = httpStatus;
  }
}

export class Fetcher {
  constructor(settings = {}) {
    const f = settings.fetch || {};
    this.timeoutMs = f.timeoutMs ?? 20000;
    this.maxRetries = f.maxRetries ?? 4;
    this.backoffMs = f.backoffMs ?? 1000;
    // HTTP 头必须是 ASCII（ByteString）。用户可能把中文写进 UA，
    // 这里统一剥离非 ASCII 字符，避免 fetch 直接抛 "Cannot convert argument to a ByteString"。
    this.userAgent = sanitizeHeader(f.userAgent) || 'TokenFreeBot/1.0';
    this.respectRobots = f.respectRobots !== false;
    this.throttle = new DomainThrottle({ delayMs: f.perDomainDelayMs ?? 2000 });
    this.robotsCache = new Map(); // origin -> {rules, fetchedAt}
  }

  /** 检查 robots.txt 是否允许抓取该 URL */
  async isAllowed(url) {
    if (!this.respectRobots) return true;
    try {
      const u = new URL(url);
      const origin = u.origin;
      let entry = this.robotsCache.get(origin);
      if (!entry) {
        let rules = null;
        try {
          const res = await fetch(`${origin}/robots.txt`, {
            headers: { 'user-agent': this.userAgent },
            signal: AbortSignal.timeout(8000),
          });
          if (res.ok) rules = parseRobots(await res.text(), this.userAgent);
        } catch { /* 取不到 robots 就视为允许（按 RFC 的宽容做法） */ }
        entry = { rules };
        this.robotsCache.set(origin, entry);
      }
      if (!entry.rules) return true;
      return isPathAllowed(entry.rules, u.pathname);
    } catch {
      return true;
    }
  }

  /**
   * 抓取一个页面。
   * @returns {Promise<{url:string, ok:boolean, status:number|null, html:string, text:string, bytes:number}>}
   */
  async fetchPage(url, { onAttempt } = {}) {
    const host = safeHost(url);
    if (!(await this.isAllowed(url))) {
      throw new HttpError(`robots.txt 不允许抓取：${url}`, 403);
    }

    return this.throttle.schedule(host, async () => {
      return withRetry(
        async (attempt) => {
          const started = Date.now();
          let res;
          try {
            res = await fetch(url, {
              headers: {
                'user-agent': this.userAgent,
                accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
                'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
              },
              redirect: 'follow',
              signal: AbortSignal.timeout(this.timeoutMs),
            });
          } catch (err) {
            const e = new HttpError(`网络错误：${err.message}`, null);
            if (onAttempt) onAttempt(attempt, e, Date.now() - started, null, 0);
            throw e;
          }

          const durationMs = Date.now() - started;
          if (!res.ok) {
            const err = new HttpError(`HTTP ${res.status} ${res.statusText}`, res.status);
            if (onAttempt) onAttempt(attempt, err, durationMs, res.status, 0);
            throw err;
          }

          const html = await res.text();
          const bytes = Buffer.byteLength(html, 'utf8');
          if (onAttempt) onAttempt(attempt, null, durationMs, res.status, bytes);
          return { url, ok: true, status: res.status, html, bytes };
        },
        {
          maxRetries: this.maxRetries,
          backoffMs: this.backoffMs,
          label: `fetch ${host}`,
        }
      );
    });
  }

  /** 落原始 HTML 到磁盘，返回相对路径 */
  saveHtml(url, html, runId, sourceId, attemptNo) {
    try {
      fs.mkdirSync(HTML_DIR, { recursive: true });
      const name = `${runId}-${sourceId}-${attemptNo}-${contentHash(url)}.html`;
      const file = path.join(HTML_DIR, name);
      fs.writeFileSync(file, html, 'utf8');
      return path.relative(PROJECT_ROOT, file).replace(/\\/g, '/');
    } catch (err) {
      log.warn('保存原始 HTML 失败', { err: err.message });
      return null;
    }
  }
}

/** 记录一次抓取尝试到 fetch_attempts */
export function recordAttempt(db, { runId, sourceId, attemptNo, ok, durationMs, httpStatus, error, bytes }) {
  return run(
    db,
    `INSERT OR REPLACE INTO fetch_attempts
       (run_id, source_id, attempt_no, started_at, duration_ms, http_status, ok, error, bytes)
     VALUES (?,?,?,datetime('now'),?,?,?,?,?)`,
    [runId, sourceId, attemptNo, durationMs ?? null, httpStatus ?? null, ok ? 1 : 0, error ?? null, bytes ?? null]
  );
}

/** 记录原始快照 */
export function recordSnapshot(db, { attemptId, sourceId, text, htmlPath }) {
  return run(
    db,
    `INSERT INTO raw_snapshots (attempt_id, source_id, content_hash, text_content, html_path)
     VALUES (?,?,?,?,?)`,
    [attemptId, sourceId, contentHash(text), (text || '').slice(0, 200000), htmlPath || null]
  );
}

// ---------------- robots.txt 解析 ----------------

export function parseRobots(text, userAgent) {
  const lines = String(text).split(/\r?\n/);
  const groups = [];
  let current = null;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(':');
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(':').trim();
    if (key === 'user-agent') {
      current = { agents: [value.toLowerCase()], disallow: [], allow: [] };
      groups.push(current);
    } else if (current && key === 'disallow') {
      if (value) current.disallow.push(value);
    } else if (current && key === 'allow') {
      if (value) current.allow.push(value);
    }
  }
  const ua = (userAgent || '').toLowerCase();
  // 选择最匹配的组：优先精确匹配 UA token，否则 *
  const matched =
    groups.find((g) => g.agents.some((a) => a !== '*' && ua.includes(a))) ||
    groups.find((g) => g.agents.includes('*'));
  return matched || null;
}

export function isPathAllowed(rules, pathname) {
  const p = pathname || '/';
  // allow 优先且更长者胜（Google 规范：最长匹配优先，同长 allow 胜）
  let best = null;
  const consider = (pattern, allow) => {
    if (!pattern || !p.startsWith(pattern)) return;
    if (!best || pattern.length > best.pattern.length || (pattern.length === best.pattern.length && allow)) {
      best = { pattern, allow };
    }
  };
  rules.allow.forEach((a) => consider(a, true));
  rules.disallow.forEach((d) => consider(d, false));
  if (!best) return true;
  return best.allow;
}

function safeHost(url) {
  try { return new URL(url).host; } catch { return 'unknown'; }
}

/** 把任意字符串压成合法 HTTP 头值（仅 ASCII 可见字符） */
export function sanitizeHeader(v) {
  if (!v) return '';
  return String(v)
    .replace(/[^\x20-\x7E]/g, '') // 去掉非 ASCII
    .replace(/\s+/g, ' ')
    .trim();
}

export { HttpError };
