/**
 * retry.js — 指数退避重试 + 域名级限流
 */

import { createLogger } from './logger.js';

const log = createLogger('retry');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 判断错误是否值得重试。
 * 可重试：网络错误、超时、5xx、429
 * 不重试：4xx（配置错误，重试无意义）
 */
export function isRetryable(err) {
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return true;
  const status = err?.httpStatus ?? err?.status;
  if (status) {
    if (status === 429) return true;
    if (status >= 500) return true;
    return false;
  }
  // 无状态码 = 网络层错误
  return true;
}

/**
 * 带指数退避的重试执行器。
 * @param {() => Promise<any>} fn
 * @param {{maxRetries?:number, backoffMs?:number, onAttempt?:(n:number, err:Error|null)=>void, label?:string}} opts
 */
export async function withRetry(fn, opts = {}) {
  const { maxRetries = 4, backoffMs = 1000, onAttempt, label = 'task' } = opts;
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn(attempt);
      if (onAttempt) onAttempt(attempt, null);
      return result;
    } catch (err) {
      lastErr = err;
      if (onAttempt) onAttempt(attempt, err);
      if (!isRetryable(err) || attempt === maxRetries) break;
      const delay = backoffMs * Math.pow(2, attempt - 1);
      log.warn(`${label} 第 ${attempt} 次失败，${delay}ms 后重试`, {
        err: err?.message || String(err),
        status: err?.httpStatus ?? null,
      });
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * 域名级串行 + 间隔限流器。
 * 同一域名同一时刻只允许 1 个请求，且两次请求间隔 ≥ delayMs。
 */
export class DomainThrottle {
  constructor({ delayMs = 2000 } = {}) {
    this.delayMs = delayMs;
    this.chains = new Map(); // host -> Promise 链尾
    this.lastAt = new Map(); // host -> 上次完成时间
  }

  /** 在指定域名下排队执行 */
  schedule(host, fn) {
    const prev = this.chains.get(host) || Promise.resolve();
    const next = prev.then(async () => {
      const last = this.lastAt.get(host) || 0;
      const wait = Math.max(0, this.delayMs - (Date.now() - last));
      if (wait > 0) await sleep(wait);
      try {
        return await fn();
      } finally {
        this.lastAt.set(host, Date.now());
      }
    });
    // 链上不传播错误，避免一次失败卡死后续
    this.chains.set(host, next.catch(() => {}));
    return next;
  }
}

/** 简单的并发闸门 */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await worker(items[i], i) };
      } catch (err) {
        results[i] = { ok: false, error: err };
      }
    }
  });
  await Promise.all(runners);
  return results;
}
