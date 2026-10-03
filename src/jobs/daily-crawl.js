#!/usr/bin/env node
/**
 * daily-crawl.js — 每日抓取入口
 *
 * 用法：
 *   node src/jobs/daily-crawl.js                    # 全量抓取
 *   node src/jobs/daily-crawl.js --provider=zhipu   # 只抓某家
 *   node src/jobs/daily-crawl.js --trigger=cron
 *
 * 流程：抓取 → 归档 → 推送通知 → 生成 feed
 * 结束码：0 成功，1 部分失败，2 全失败（便于任务计划判断）
 */

process.env.TOKENFREE_LOG_LEVEL ||= 'info';

import { runPipeline } from '../pipeline/index.js';
import { archiveExpired } from '../pipeline/persist.js';
import { getDb } from '../db/db.js';
import { loadSettings } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';
import { notifyNewActivities } from '../notify/push.js';
import { writeFeeds } from '../notify/feed.js';
import { generateAndSave } from '../lib/guide-gen.js';

const log = createLogger('daily');

function argOf(name, def = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

async function main() {
  const trigger = argOf('trigger', 'manual');
  const onlyProvider = argOf('provider', null);
  const started = Date.now();

  log.info(`=== 每日抓取开始（trigger=${trigger}${onlyProvider ? ', provider=' + onlyProvider : ''}）===`);

  const summary = await runPipeline({ trigger, onlyProvider });

  // 归档过期活动
  const settings = loadSettings();
  const db = getDb();
  const arch = archiveExpired(db, { afterDays: settings.archive?.afterDays ?? 30 });
  if (arch.archived) log.info(`归档 ${arch.archived} 条过期/已拒绝活动`);

  // 推送通知（有新活动时）
  if (summary.itemsNew > 0) {
    try {
      const pus = await notifyNewActivities(db, summary.newIds, settings);
      if (pus.sent) log.info(`推送通知：${pus.sent} 条成功 / ${pus.failed} 条失败`);
    } catch (err) {
      log.warn('推送失败（不影响抓取结果）', { err: err.message });
    }
  }

  // 自动生成攻略草稿。
  //
  // ⚠️ 顺序很重要：必须跑在 writeFeeds **之前**（实测踩过）。
  // writeFeeds → buildDataFiles 会调用 loadGuides() 把攻略写进 public/data/guides.json，
  // 若先写 feed 再生成，当天新增的攻略要等下一次构建才会出现在静态站上（差一天）。
  // 这里失败不阻断抓取：攻略是附属产物，不该让主流程非零退出。
  try {
    const gen = generateAndSave(db, { minConfidence: 0.75, limit: 20 });
    log.info(gen.drafts.length
      ? `自动生成攻略：新增 ${gen.drafts.length} 篇（累计 ${gen.total} 篇）`
      : `自动生成攻略：无新增（累计 ${gen.total} 篇）`);
  } catch (err) {
    log.warn('自动生成攻略失败（不影响抓取结果）', { err: err.message });
  }

  // 生成 RSS / JSON feed
  try {
    writeFeeds(db, settings);
    log.info('已生成 RSS / JSON feed');
  } catch (err) {
    log.warn('生成 feed 失败', { err: err.message });
  }

  const cost = ((Date.now() - started) / 1000).toFixed(1);
  log.info(`=== 抓取完成：${summary.status}，新增 ${summary.itemsNew}，更新 ${summary.itemsUpdated}，耗时 ${cost}s ===`);

  if (summary.status === 'failed') process.exitCode = 2;
  else if (summary.status === 'partial') process.exitCode = 1;
}

main().catch((err) => {
  createLogger('daily').error('抓取任务异常终止', { err: err.stack || err.message });
  process.exit(2);
});
