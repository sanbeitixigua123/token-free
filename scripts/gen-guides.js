#!/usr/bin/env node
/**
 * gen-guides.js — 从高价值活动批量生成攻略草稿
 *
 * 用法：
 *   node scripts/gen-guides.js                          # 用默认阈值生成并写盘
 *   node scripts/gen-guides.js --min-confidence 0.9     # 只挑更可信的活动
 *   node scripts/gen-guides.js --limit 5                # 本次最多新增 5 篇
 *   node scripts/gen-guides.js --dry                    # 只打印，不写 config/guides.auto.yaml
 *
 * 产物：config/guides.auto.yaml（会被每次生成整体重写，幂等；手写稿另见 guides.yaml）
 */

import { getDb } from '../src/db/db.js';
import { loadGuides } from '../src/lib/config.js';
import { generateGuideDrafts, generateAndSave, AUTO_GUIDES_FILE } from '../src/lib/guide-gen.js';

/** --key=value 或 --key value 两种写法都支持（脚本调用风格不统一） */
function argOf(name) {
  const args = process.argv.slice(2);
  const withEq = args.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.slice(name.length + 3);
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1];
  return null;
}

const dry = process.argv.includes('--dry');
const minConfidence = Number(argOf('min-confidence') ?? 0.75);
const limit = Number(argOf('limit') ?? 20);

// 校验参数，避免把 "--limit abc" 静默当 0 用
if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
  console.error(`[gen-guides] --min-confidence 必须是 0~1 之间的数，收到：${argOf('min-confidence')}`);
  process.exit(2);
}
if (!Number.isFinite(limit) || limit < 1) {
  console.error(`[gen-guides] --limit 必须是正整数，收到：${argOf('limit')}`);
  process.exit(2);
}

console.log(`[gen-guides] 阈值 confidence >= ${minConfidence}，单次上限 ${limit} 篇${dry ? '（--dry 不写盘）' : ''}`);

const db = getDb();

if (dry) {
  // dry 模式用"已存在于 guides.auto.yaml + 手写 guides.yaml"合并后的 slug 集合判定，
  // 从而连"新增篇数"也如实展示（而不是每次都把全部候选报成新增）。
  const existing = loadGuides();
  const { drafts, scanned, total } = generateGuideDrafts(db, { minConfidence, limit, existing });
  console.log(`[gen-guides] 扫描达标活动 ${scanned} 条，可新增草稿 ${drafts.length} 篇（候选上限 ${total} 条）`);
  console.log('');
  for (const g of drafts) {
    console.log(`  · ${g.title}`);
    console.log(`    slug: ${g.slug}`);
    console.log(`    ${g.summary}`);
  }
  if (!drafts.length) console.log('  （没有可新增的活动——要么都生成过了，要么没有达标的）');
  console.log('');
  console.log(`[gen-guides] dry-run 结束，未写入任何文件。正式产物路径：${AUTO_GUIDES_FILE}`);
  process.exit(0);
}

const res = generateAndSave(db, { minConfidence, limit });
console.log(`[gen-guides] 扫描达标活动 ${res.scanned} 条，新增草稿 ${res.drafts.length} 篇`);
console.log(`[gen-guides] 累计自动攻略 ${res.total} 篇（此前已有 ${res.existingCount} 篇）`);
for (const g of res.drafts) console.log(`  + ${g.title}`);
console.log(`[gen-guides] 已写入：${AUTO_GUIDES_FILE}`);
console.log('[gen-guides] 提示：运行 node src/export/build-static.js 可把攻略导出到 public/data/guides.json');
