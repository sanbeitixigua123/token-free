#!/usr/bin/env node
/**
 * archive.js — 过期活动归档（可单独运行）
 *   node src/jobs/archive.js [--days=30]
 */

import { archiveExpired } from '../pipeline/persist.js';
import { getDb } from '../db/db.js';
import { loadSettings } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('archive');

const hit = process.argv.find((a) => a.startsWith('--days='));
const days = hit ? parseInt(hit.slice(7), 10) : (loadSettings().archive?.afterDays ?? 30);

const db = getDb();
const r = archiveExpired(db, { afterDays: days });
log.info(`归档完成：${r.archived} 条（阈值 ${days} 天）`);
