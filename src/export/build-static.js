#!/usr/bin/env node
/**
 * build-static.js — 导出静态数据到 public/data/
 * 供 GitHub Pages 静态版读取（前端同一套代码，数据层自动切换）。
 *
 * 用法：node src/export/build-static.js
 */

import { getDb } from '../db/db.js';
import { loadSettings } from '../lib/config.js';
import { writeFeeds } from '../notify/feed.js';
import { createLogger } from '../lib/logger.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const log = createLogger('export');
const db = getDb();
const settings = loadSettings();

const bundle = writeFeeds(db, settings);

/**
 * 匹配 sw.js 中的 SW_VERSION 声明。
 * 提到模块作用域是因为构建号判定逻辑需要复用它做"是否匹配到"的检测，
 * 而非像早期实现那样靠字符串比对反推。
 */
const RE_SW_VERSION = /const SW_VERSION = '[^']*';/;

/**
 * 给 Service Worker 打版本戳。
 *
 * 起因：SW 用 CacheStorage 缓存主壳，若版本号恒定，用户部署新版后仍会拿到
 * 旧 app.js/css（除非手动清缓存）。这里在导出阶段把 public/js/sw.js 里的
 * `const SW_VERSION = 'dev'` 重写为本次构建时间戳，
 * activate 时即可清理旧缓存桶，实现自动更新。
 */
function stampServiceWorker() {
  const here = dirname(fileURLToPath(import.meta.url));
  const swPath = join(here, '..', '..', 'public', 'js', 'sw.js');
  if (!existsSync(swPath)) {
    log.warn('未找到 public/js/sw.js，跳过版本戳注入');
    return null;
  }
  const src = readFileSync(swPath, 'utf8');
  // 构建号：北京时间 YYYYMMDDHHmm
  const bj = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace(/[-:T]/g, '');

  // 注意两种"没变化"要区分开：
  //   a) 正则压根没匹配到 → 真的异常（声明被改名/删除），必须告警
  //   b) 匹配到了，但本轮时间戳与上一轮相同（同一分钟内重复构建）→ 完全正常，静默
  // 早期实现只判断 `next === src`，把 (b) 也报成告警，导致同一分钟内连跑两次构建
  // 必然出现"未匹配到 SW_VERSION"的假告警。这里改为显式检测匹配结果。
  if (!RE_SW_VERSION.test(src)) {
    log.warn('sw.js 中未找到 SW_VERSION 声明（版本戳注入失败，SW 缓存将无法自动失效）');
    return null;
  }
  const next = src.replace(RE_SW_VERSION, `const SW_VERSION = '${bj}';`);
  // 时间戳未变时不必回写，避免制造无意义的文件改动
  if (next !== src) writeFileSync(swPath, next, 'utf8');
  return bj;
}

const swVersion = stampServiceWorker();

console.log('');
console.log('  静态数据导出完成');
console.log('  ─────────────────────────────');
console.log(`  活动：   ${bundle.activities.length} 条`);
console.log(`  厂商：   ${bundle.providers.length} 家`);
console.log(`  进行中： ${bundle.stats.active} 条（即将结束 ${bundle.stats.endingSoon} 条）`);
console.log(`  生成时间：${bundle.meta.generatedAt}（北京时间）`);
if (swVersion) console.log(`  壳缓存版本：${swVersion}`);
console.log('  输出目录：public/data/');
console.log('');
