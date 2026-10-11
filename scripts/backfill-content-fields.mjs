#!/usr/bin/env node
/**
 * backfill-content-fields.mjs — 为存量活动回填编辑化内容字段
 *
 * 背景：hook / how_to_claim / caveat 三列加入后，只有新抽取的条目会带上；
 * 存量活动（尤其是已经过审核发布的）仍是空。本脚本把这些条目的
 * 标题/摘要/额度/原文摘录喂给 LLM，补齐三个字段（幂等：只处理 hook IS NULL 的行）。
 *
 * 运行：node scripts/backfill-content-fields.mjs（需 LLM 凭据，见 .env / secrets.json）
 */

process.env.TOKENFREE_LOG_LEVEL ||= 'info';

import { getDb } from '../src/db/db.js';
import { loadSettings } from '../src/lib/config.js';
import { callChat } from '../src/pipeline/llm-extract.js';
import { createLogger } from '../src/lib/logger.js';

const log = createLogger('backfill');

const SYS = `你是编辑。根据给定的"AI 厂商免费活动"信息与原文摘录，输出 JSON：
{"hook": string|null, "howToClaim": string|null, "caveat": string|null}

- hook：一句话人话描述，讲清楚"是什么+适合谁+值不值得动手"，口语化不夸大，≤60 字
- howToClaim：怎么领（入口/动作/截止提醒，如"官网注册页领取，10-31 前"），原文没写就 null
- caveat：限制与坑（资格例外、计费方式、稳定性风险，如"App Store 代扣不适用"），原文没有就 null
只依据给定信息，不要编造。严格输出单个 JSON，不要 markdown。`;

async function main() {
  const settings = loadSettings();
  const cfg = settings.llm || {};
  if (!cfg.enabled || !cfg.apiKey || !cfg.baseUrl) {
    log.info('LLM 未配置，跳过回填');
    return;
  }
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, title, summary, benefit_text, claim_url, source_excerpt
    FROM activities
    WHERE hook IS NULL AND archived_at IS NULL AND review_status IN ('auto_ok','approved')
    ORDER BY id DESC`).all();

  log.info(`待回填 ${rows.length} 条`);
  let done = 0;
  for (const r of rows) {
    try {
      const user = `厂商活动：${r.title}${r.summary ? '\n' + r.summary : ''}`
        + `${r.benefit_text ? '\n赠：' + r.benefit_text : ''}`
        + `${r.claim_url ? '\n领取页：' + r.claim_url : ''}`
        + `\n原文摘录：${(r.source_excerpt || '').slice(0, 800)}`;
      const raw = await callChat(cfg, SYS, user);
      let p = null;
      try {
        p = JSON.parse(String(raw).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
      } catch { /* 解析失败按无产出处理 */ }
      if (p && (p.hook || p.howToClaim || p.caveat)) {
        const clip = (s) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, 120) : null);
        db.prepare(`UPDATE activities SET hook=?, how_to_claim=?, caveat=? WHERE id=?`)
          .run(clip(p.hook), clip(p.howToClaim), clip(p.caveat), r.id);
        done++;
        log.info(`#${r.id} 已回填：${String(p.hook || '').slice(0, 40)}`);
      } else {
        log.warn(`#${r.id} 无有效产出，跳过`);
      }
    } catch (err) {
      log.warn(`#${r.id} 回填失败：${String(err.message).slice(0, 100)}`);
    }
  }
  log.info(`回填完成：${done}/${rows.length} 条`);
}

main().catch((err) => {
  log.error('回填任务异常终止', { err: err.stack || err.message });
  process.exit(1);
});
