#!/usr/bin/env node
/**
 * verify-activities.js — 在架活动的 LLM 存活性核查（可单独运行）
 *
 * 背景：抓取只在「源页面变化」时重新抽取，而很多活动页面长期不变——
 *   活动现实中早已结束/额度耗尽，站上却永远挂着"进行中"。
 * 本任务对每条在架活动做一次现实核查：
 *   1) 抓取其 claim_url（无则 source_url）的当前页面
 *   2) LLM 判断「该活动现在是否仍然有效」（页面里还能看到吗/是否写了已结束）
 *   3) 判定失效 → status_override='ended'（视图优先读 override，且日常重抓
 *      的指纹去重不会覆盖 override），并把空 end_date 补成今天以走归档生命周期
 *   4) 判定仍有效 → 只更新 last_verified_at
 *   5) 页面抓不到（网络/反爬/robots）→ 只更新 last_verified_at，不改状态：
 *      "抓不到"不等于"已结束"，尤其是境外源在国内网络下的误判
 *
 * 用法：
 *   node src/jobs/verify-activities.js [--limit=25]
 * 配置：settings.verify = { enabled: true, maxItems: 25 }
 */

process.env.TOKENFREE_LOG_LEVEL ||= 'info';

import { getDb } from '../db/db.js';
import { loadSettings } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';
import { Fetcher } from '../pipeline/fetch.js';
import { callChat, llmCredentialsInvalid } from '../pipeline/llm-extract.js';
import { resetLlmCredentialState } from '../pipeline/llm-extract.js';

const log = createLogger('verify');

const argOf = (name, def = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};

const VERIFY_SYSTEM = `你是活动真实性核查员。给你一条"AI 厂商免费活动"的登记信息和它落地页的当前文本，判断该活动【现在】是否仍然有效。

判定"已失效"的依据（任一即可）：
- 页面文本中已找不到该活动的任何痕迹（页面改版且活动下线）
- 页面明确说活动已结束 / 名额已发完 / 额度已耗尽 / 已下线
- 落地页变成了与活动完全无关的内容（404 文案、首页跳转、登录墙且无活动信息）

判定"仍有效"：页面文本中能看到该活动的描述、领取入口或相关说明。
注意：页面有与活动无关的其它内容，不影响判定；看不清就 stillValid=null（无法判断）。

输出单个 JSON 对象，不要 markdown：{"stillValid": true|false|null, "reason": "一句话依据（引用页面原词）"}`;

function stripTags(s) {
  return String(s).replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

function parseLoose(t) {
  t = String(t || '').replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s === -1 || e === -1) return null;
  try { return JSON.parse(t.slice(s, e + 1)); } catch { return null; }
}

export async function verifyActivities(db, settings = {}, { limit = 25 } = {}) {
  const cfg = settings.llm || {};
  if (!cfg.enabled || !cfg.apiKey || !cfg.baseUrl) {
    log.info('LLM 未启用，跳过活动存活性核查');
    return { checked: 0, ended: 0, confirmed: 0, unreachable: 0 };
  }

  const rows = db.prepare(`
    SELECT a.id, a.title, a.summary, a.benefit_text, a.end_date,
           a.claim_url, a.source_url, a.last_verified_at, p.name_zh AS provider
    FROM v_activities a JOIN providers p ON a.provider_id = p.id
    WHERE a.status = 'active'
      AND a.review_status IN ('auto_ok','approved')
      AND a.archived_at IS NULL
    ORDER BY (a.last_verified_at IS NULL) DESC, a.last_verified_at ASC, a.id ASC
    LIMIT ?`).all(limit);

  if (!rows.length) { log.info('没有需要核查的在架活动'); return { checked: 0, ended: 0, confirmed: 0, unreachable: 0 }; }
  log.info(`开始核查 ${rows.length} 条在架活动（每条抓落地页 + LLM 判定）`);

  const fetcher = new Fetcher(settings);
  resetLlmCredentialState();
  const stats = { checked: 0, ended: 0, confirmed: 0, unreachable: 0 };
  const update = db.prepare(`
    UPDATE activities SET
      status_override = CASE WHEN ? = 'ended' THEN 'ended' ELSE status_override END,
      end_date = CASE WHEN ? = 'ended' AND end_date IS NULL THEN date('now','+8 hours') ELSE end_date END,
      last_verified_at = datetime('now','+8 hours')
    WHERE id = ?`);

  for (const r of rows) {
    const url = r.claim_url || r.source_url;
    let pageText = null;
    if (url) {
      try {
        const res = await fetcher.fetchPage(url);
        pageText = stripTags(res.html).slice(0, 6000);
        if (res.status === 404 || res.status === 410) {
          // 落地页已删除是硬信号
          update.run('ended', 'ended', r.id);
          stats.checked++; stats.ended++;
          log.info(`#${r.id} ${r.title.slice(0, 30)} → 已失效（落地页 ${res.status}）`);
          continue;
        }
      } catch (err) {
        // 网络失败/robots 拒绝：只记时间，不改状态
        db.prepare(`UPDATE activities SET last_verified_at = datetime('now','+8 hours') WHERE id=?`).run(r.id);
        stats.checked++; stats.unreachable++;
        log.warn(`#${r.id} 落地页无法访问（${String(err.message).slice(0, 60)}），状态保持不变`);
        continue;
      }
    }

    if (!pageText || pageText.length < 40) {
      db.prepare(`UPDATE activities SET last_verified_at = datetime('now','+8 hours') WHERE id=?`).run(r.id);
      stats.checked++; stats.unreachable++;
      continue;
    }

    try {
      const user = `活动登记：${r.provider}｜${r.title}${r.summary ? '｜' + r.summary : ''}${r.benefit_text ? '｜赠' + r.benefit_text : ''}

落地页当前文本（截断）：
${pageText}

判断该活动现在是否仍然有效，按规则输出 JSON。`;
      const raw = await callChat(cfg, VERIFY_SYSTEM, user);
      const v = parseLoose(raw);
      if (!v || v.stillValid == null) {
        db.prepare(`UPDATE activities SET last_verified_at = datetime('now','+8 hours') WHERE id=?`).run(r.id);
        stats.checked++;
        log.warn(`#${r.id} LLM 无法判定，状态保持不变`);
      } else if (v.stillValid === false) {
        update.run('ended', 'ended', r.id);
        stats.checked++; stats.ended++;
        log.info(`#${r.id} ${r.title.slice(0, 30)} → 已失效（${String(v.reason || '').slice(0, 60)}）`);
      } else {
        db.prepare(`UPDATE activities SET last_verified_at = datetime('now','+8 hours') WHERE id=?`).run(r.id);
        stats.checked++; stats.confirmed++;
        log.info(`#${r.id} ${r.title.slice(0, 30)} → 仍有效`);
      }
    } catch (err) {
      if (llmCredentialsInvalid()) { log.warn('LLM 凭据失效，本轮核查中止'); break; }
      log.warn(`#${r.id} 核查调用失败：${String(err.message).slice(0, 80)}`);
      stats.checked++;
    }
  }
  log.info(`核查完成：${stats.checked} 条 | 确认失效 ${stats.ended} | 仍有效 ${stats.confirmed} | 无法访问 ${stats.unreachable}`);
  return stats;
}

// 直接运行才执行主流程（被 daily-crawl import 时不触发）
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  const settings = loadSettings();
  const db = getDb();
  const vcfg = settings.verify || {};
  if (vcfg.enabled === false) {
    log.info('settings.verify.enabled=false，跳过');
  } else {
    const limit = parseInt(argOf('limit', String(vcfg.maxItems ?? 25)), 10);
    verifyActivities(db, settings, { limit }).catch((err) => {
      log.error('核查任务异常终止', { err: err.stack || err.message });
      process.exit(2);
    });
  }
}
