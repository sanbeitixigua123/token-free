/**
 * index.js — 抓取流水线编排
 *
 * discover → fetch → extract(rule → llm) → normalize → validate → persist → notify
 *
 * 特性：
 *   - 每个源独立失败隔离，不影响其它源
 *   - 单源连续失败累加，超过阈值告警
 *   - 全程写 fetch_runs / fetch_attempts / raw_snapshots，可追溯
 */

import { getDb, run, get, all } from '../db/db.js';
import { loadProviders, loadSettings } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';
import { mapLimit } from '../lib/retry.js';
import { cleanText } from '../lib/fingerprint.js';
import { Fetcher, recordAttempt, recordSnapshot } from './fetch.js';
import { extractBlocks, discoverCandidates } from './discover.js';
import { extractActivity } from './extract.js';
import { extractWithLLM } from './llm-extract.js';
import { normalizeItem, dedupeWithinBatch } from './normalize.js';
import { validateItem, isBadTitle, AUTO_OK } from './validate.js';
import { persistItems } from './persist.js';
import * as cheerio from 'cheerio';

const log = createLogger('pipeline');

/** 参考年份：北京时间当年 */
const refYear = () => new Date(Date.now() + 8 * 3600 * 1000).getUTCFullYear();

/** 从 providers 表读取（含 id），与 yaml 配置合并 */
function loadProviderContext(db) {
  const providers = all(db, 'SELECT * FROM providers WHERE active=1 ORDER BY tier, id');
  const cfg = loadProviders();
  const cfgBySlug = new Map(cfg.map((p) => [p.slug, p]));
  return providers.map((p) => ({ ...p, config: cfgBySlug.get(p.slug) || null }));
}

/** 允许的链接域名白名单：厂商官网 + 数据源域名 */
function buildAllowedHosts(provider, sources) {
  const hosts = new Set();
  const add = (u) => {
    try { if (u) hosts.add(new URL(u).host.toLowerCase()); } catch { /* ignore */ }
  };
  add(provider.website);
  add(provider.pricing_url);
  add(provider.announcement_url);
  for (const s of sources) add(s.url);
  // 常见子域根域兜底：站点自身与 www
  for (const h of [...hosts]) {
    const parts = h.split('.');
    if (parts.length > 2) hosts.add(parts.slice(-2).join('.')); // a.b.com → b.com
    hosts.add('www.' + h);
  }
  return [...hosts];
}

/** 抓取单个源 */
async function processSource(db, ctx) {
  const { provider, source, settings, fetcher, runId } = ctx;
  const slug = provider.slug;

  // 跳过动态搜索源在无搜索能力时（搜索源由 search.js 单独处理，这里只处理固定 URL）
  if (!source.url) return { ok: true, items: [], skipped: true };

  const attemptRecorder = (attempt, err, durationMs, status, bytes) => {
    try {
      recordAttempt(db, {
        runId, sourceId: source.id, attemptNo: attempt,
        ok: err ? 0 : 1, durationMs, httpStatus: status, error: err?.message || null, bytes,
      });
    } catch (e) { log.warn('记录抓取尝试失败', { err: e.message }); }
  };

  let page;
  try {
    page = await fetcher.fetchPage(source.url, { onAttempt: attemptRecorder });
  } catch (err) {
    // 失败：累加连续失败计数
    run(db, `UPDATE sources SET consecutive_failures = consecutive_failures + 1 WHERE id=?`, [source.id]);
    const cf = get(db, 'SELECT consecutive_failures FROM sources WHERE id=?', [source.id])?.consecutive_failures ?? 0;
    if (cf >= 5) log.error(`数据源连续失败 ${cf} 次，建议检查：${slug} ${source.url}`);
    return { ok: false, error: err.message, items: [] };
  }

  // 成功：重置失败计数
  run(db, `UPDATE sources SET consecutive_failures=0, last_ok_at=datetime('now') WHERE id=?`, [source.id]);
  run(db, `UPDATE providers SET updated_at=datetime('now') WHERE id=?`, [provider.id]);

  // 保存原始证据
  const htmlPath = fetcher.saveHtml(source.url, page.html, runId, source.id, 1);
  const text = htmlToText(page.html, source.selector);
  const snap = recordSnapshot(db, {
    attemptId: get(db, `SELECT MAX(id) AS id FROM fetch_attempts WHERE run_id=? AND source_id=?`, [runId, source.id])?.id,
    sourceId: source.id,
    text,
    htmlPath,
  });

  // 页面未变化则跳过提取（省算力，也避免重复变更记录）
  const lastHash = get(db, `SELECT content_hash FROM raw_snapshots WHERE source_id=? AND id < ? ORDER BY id DESC LIMIT 1`, [source.id, snap.lastInsertRowid]);
  const hashNow = get(db, 'SELECT content_hash FROM raw_snapshots WHERE id=?', [snap.lastInsertRowid])?.content_hash;
  if (lastHash && lastHash.content_hash === hashNow) {
    log.info(`页面未变化，跳过提取：${slug} ${source.kind}`);
    return { ok: true, items: [], unchanged: true };
  }

  // 发现候选
  const blocks = extractBlocks(page.html, source.url, source.selector);
  const candidates = discoverCandidates(blocks);
  if (!candidates.length) return { ok: true, items: [], candidates: 0 };

  const allowedHosts = buildAllowedHosts(provider, [source]);
  // isBadTitle 由 validate 注入，用于标题不可用时从正文"提拔"真正的活动标题
  const baseCtx = { provider, source, refYear: refYear(), allowedHosts, isBadTitle };

  // 规则提取
  let items = candidates
    .map((c) => extractActivity(c, baseCtx))
    .filter((it) => it.title && it.title.length >= 4)
    .map((it) => ({ ...it, extractedBy: 'rule', evidenceId: snap.lastInsertRowid }));

  // LLM 增强（配置了才跑）
  let llmItems = [];
  if (settings.llm?.enabled && settings.llm?.apiKey) {
    try {
      llmItems = await extractWithLLM(candidates, { ...baseCtx, settings });
      llmItems = llmItems.map((it) => ({ ...it, evidenceId: snap.lastInsertRowid }));
      log.info(`${slug} LLM 提取 ${llmItems.length} 条`);
    } catch (err) {
      log.warn(`${slug} LLM 提取失败，已降级为规则结果`, { err: err.message });
    }
  }

  // 合并：指纹相同的取质量高者（normalize 后统一去重）
  const merged = [...items, ...llmItems].map((it) => normalizeItem(it, provider));
  // 保留 evidenceId
  const evidenceMap = new Map();
  [...items, ...llmItems].forEach((raw, i) => {
    if (merged[i] && raw.evidenceId) evidenceMap.set(merged[i].fingerprint, raw.evidenceId);
  });
  merged.forEach((m) => { if (evidenceMap.has(m.fingerprint)) m.evidenceId = evidenceMap.get(m.fingerprint); });

  return { ok: true, items: merged, candidates: candidates.length, evidenceId: snap.lastInsertRowid };
}

/** HTML → 纯文本（用于快照与哈希） */
function htmlToText(html, selector) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, iframe').remove();
  const root = selector && $(selector).length ? $(selector) : $.root();
  return cleanText(root.text()).slice(0, 200000);
}

/**
 * 主入口：跑一次完整抓取。
 * @param {{trigger?:string, onlyProvider?:string, onProgress?:Function}} opts
 */
export async function runPipeline({ trigger = 'manual', onlyProvider = null, onProgress } = {}) {
  const db = getDb();
  const settings = loadSettings();
  const fetcher = new Fetcher(settings);

  const started = new Date().toISOString();
  const runRes = run(db, `INSERT INTO fetch_runs (started_at, trigger, status) VALUES (?,?,'running')`, [started, trigger]);
  const runId = runRes.lastInsertRowid;

  let providers = loadProviderContext(db);
  if (onlyProvider) providers = providers.filter((p) => p.slug === onlyProvider);

  // 收集所有待抓源
  const jobs = [];
  for (const provider of providers) {
    const sources = all(db, 'SELECT * FROM sources WHERE provider_id=? AND enabled=1 AND url IS NOT NULL', [provider.id]);
    for (const source of sources) {
      jobs.push({ provider, source, settings, fetcher, runId, providerSlug: provider.slug });
    }
  }

  run(db, `UPDATE fetch_runs SET sources_total=? WHERE id=?`, [jobs.length, runId]);
  log.info(`抓取开始：${providers.length} 家厂商，${jobs.length} 个数据源`);

  const globalLimit = settings.fetch?.globalConcurrency ?? 4;
  // mapLimit 会把 worker 的返回值再包一层 { ok:true, value }，
  // 这里直接让 worker 返回业务结果对象，避免双重包裹导致统计丢失。
  const results = await mapLimit(jobs, globalLimit, async (job) => {
    try {
      const r = await processSource(db, job);
      if (onProgress) onProgress(job, r);
      return { job, ...r };
    } catch (err) {
      log.warn(`源处理异常：${job.providerSlug} ${job.source.url}`, { err: err.message });
      return { job, ok: false, error: err.message, items: [] };
    }
  });

  // 汇总
  const allItems = [];
  let okCount = 0, found = 0;
  const failedSources = [];
  for (const r of results) {
    // mapLimit 返回 { ok, value }；value 即上面 worker 的返回对象
    const out = r?.value ?? r;
    const job = out?.job ?? r?.job;
    const src = job ? `${job.providerSlug} ${job.source?.url || ''}` : '(未知源)';
    if (out?.ok) {
      okCount++;
      if (out.items?.length) {
        found += out.items.length;
        for (const it of out.items) allItems.push(it);
      }
    } else if (!out?.skipped) {
      failedSources.push({ source: src, error: out?.error || '未知错误' });
    }
  }
  if (failedSources.length) {
    log.warn(`${failedSources.length} 个源抓取失败`, {
      sources: failedSources.slice(0, 5).map((f) => f.source).join(' | '),
    });
  }

  // 去重 → 校验 → 落库
  const deduped = dedupeWithinBatch(allItems);
  const providerIdBySlug = new Map(all(db, 'SELECT id, slug FROM providers').map((p) => [p.slug, p.id]));
  const sourceIdByUrl = new Map(all(db, 'SELECT id, url FROM sources').map((s) => [s.id ? s.url : s.url, s.id]));
  const evidenceIdBySource = new Map(
    deduped.filter((d) => d.sourceUrl && d.evidenceId).map((d) => [d.sourceUrl, d.evidenceId])
  );

  const validated = [];
  for (const it of deduped) {
    const sourceUrl = it.sourceUrl;
    const src = sourceUrl ? sourceIdByUrl.get(sourceUrl) : null;
    const hosts = buildAllowedHosts(
      providers.find((p) => p.slug === it.providerSlug) || {},
      src ? [src] : []
    );
    const v = validateItem(it, { allowedHosts: hosts, sourceUrl, settings });
    if (!v.ok) continue;
    it.reviewAction = v.action;
    validated.push(it);
  }

  const stats = persistItems(db, validated, { runId, providerIdBySlug, sourceIdByUrl, evidenceIdBySource });

  const status = okCount === 0 ? 'failed'
    : failedSources.length > 0 ? 'partial' : 'ok';
  run(db, `UPDATE fetch_runs SET
      finished_at=datetime('now'), status=?, sources_ok=?,
      items_found=?, items_new=?, items_updated=?, error_summary=?
    WHERE id=?`,
    [status, okCount, found, stats.new, stats.updated,
      failedSources.length ? failedSources.map((f) => `${f.source}: ${f.error}`).join('\n').slice(0, 2000) : null,
      runId]);

  const summary = {
    runId, status, sourcesTotal: jobs.length, sourcesOk: okCount,
    sourcesFailed: failedSources.length,
    failures: failedSources,
    itemsFound: found, itemsNew: stats.new, itemsUpdated: stats.updated,
    itemsUnchanged: stats.unchanged, itemsPending: stats.pending,
    newIds: stats.newIds,
  };
  log.info(`抓取结束 #${runId}：${status}，源 ${okCount}/${jobs.length}，发现 ${found}，新增 ${stats.new}，更新 ${stats.updated}，待审 ${stats.pending}`);
  return summary;
}
