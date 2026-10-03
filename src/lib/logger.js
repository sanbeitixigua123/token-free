/**
 * logger.js — 结构化日志
 * 同时输出到控制台与 logs/ 下的按日日志文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../db/db.js';

const LOG_DIR = path.join(PROJECT_ROOT, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.TOKENFREE_LOG_LEVEL || 'info'] ?? 20;

const COLORS = {
  debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m', reset: '\x1b[0m',
};

function logFile() {
  const d = new Date(Date.now() + 8 * 3600 * 1000); // 北京时间日期
  return path.join(LOG_DIR, `crawl-${d.toISOString().slice(0, 10)}.log`);
}

function write(level, scope, msg, extra) {
  if (LEVELS[level] < threshold) return;
  const ts = new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const suffix = extra && Object.keys(extra).length
    ? ' ' + Object.entries(extra).map(([k, v]) => `${k}=${fmt(v)}`).join(' ')
    : '';
  const line = `[${ts}][${level.toUpperCase()}][${scope}] ${msg}${suffix}`;
  // 控制台（带色）
  const c = COLORS[level] || '';
  process.stdout.write(`${c}${line}${COLORS.reset}\n`);
  // 文件（无色的纯文本）
  try { fs.appendFileSync(logFile(), line + '\n'); } catch { /* 忽略磁盘错误 */ }
}

function fmt(v) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return '[obj]'; }
  }
  return String(v);
}

export function createLogger(scope) {
  return {
    debug: (m, e) => write('debug', scope, m, e),
    info: (m, e) => write('info', scope, m, e),
    warn: (m, e) => write('warn', scope, m, e),
    error: (m, e) => write('error', scope, m, e),
  };
}

export const logger = createLogger('app');
export { LOG_DIR };
