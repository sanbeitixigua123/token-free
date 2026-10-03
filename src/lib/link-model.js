/**
 * link-model.js — 把活动关联到「模型」与「端点」
 *
 * 背景（为什么必须有这一层）：
 *   三层结构（Provider → Endpoint → Model）建好后，activities 表有了
 *   model_id / endpoint_id 两列，但流水线从不写入 —— 前端因此只能显示
 *   "某厂商有活动"，无法回答"送的是哪个模型的额度"。
 *   这是三层结构从"表结构"变成"可用数据"的最后一公里。
 *
 * 核心难点：
 *   活动文本里出现的模型名写法极度不统一 ——
 *     "GLM-5.3-Flash" / "GLM 5.3 Flash" / "glm-5.3-flash" / "GLM-5.3"
 *     "DeepSeek V4.1 Flash" / "deepseek-v4.1-flash" / "V4.1"
 *     "混元 3.0" / "Hy3.0" / "hunyuan-3"
 *   直接字符串包含匹配的召回率极低。
 *
 * 策略（三级，从强到弱）：
 *   1) 归一化精确匹配 —— 把双方都折叠成「只含字母数字的小写串」再比较。
 *      最能抗住连字符/空格/大小写差异，且几乎不会误判。
 *   2) 别名匹配 —— 配置里的 alias 列表（如 混元 3.0 / Hy3.0）。
 *   3) 主版本号匹配 —— 仅当该厂商下**只有一个**候选模型符合时才采用，
 *      避免 "V4.1" 同时命中 V4.1-Flash 与 V4-Flash 这种歧义（宁可漏，不可错）。
 *
 * 设计原则：**宁可不关联，也不关联错**。
 *   关联错会让用户按模型筛选时看到错误的免费额度，比不显示更糟。
 *   因此所有存在歧义的场景一律返回 null。
 */

import { all, get } from '../db/db.js';
import { normalizeUrl } from './fingerprint.js';

/**
 * 把模型名/文本折叠成可比较的规范形式。
 * "GLM-5.3-Flash" → "glm53flash"
 * "GLM 5.3 Flash" → "glm53flash"
 * 这样连字符、空格、点号、大小写的差异全被抹平。
 */
export function foldModelName(s) {
  return String(s || '')
    .toLowerCase()
    // 全角转半角（常见于中文站点混排）
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s\-_.·・]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
}

/**
 * 提取"主版本号"用于弱匹配。
 * "GLM-5.3-Flash" → "5.3"；"DeepSeek V4.1 Flash" → "4.1"；"混元 3.0" → "3.0"
 * 只取第一个形如 x.y 或 x 的版本段。
 */
function extractVersion(s) {
  const m = String(s || '').match(/(\d+)\.(\d+)/);
  if (m) return `${m[1]}.${m[2]}`;
  const m2 = String(s || '').match(/(?:^|[^0-9])(\d)(?![0-9.])/);
  return m2 ? m2[1] : null;
}

/** 内置别名表：配置里难以穷举、但实际文本里高频出现的写法 */
const BUILTIN_ALIASES = {
  'glm-5-3-flash': ['GLM-5.3', 'GLM5.3', 'GLM-5.3-Flash', '智谱GLM-5.3', 'ZCode模型'],
  'glm-5-3': ['GLM-5.3', 'GLM5.3'],
  'deepseek-v4-1-flash': ['DeepSeek V4.1', 'V4.1-Flash', 'V4.1 Flash', 'DeepSeek-V4.1'],
  'deepseek-v4-flash': ['DeepSeek V4 Flash', 'V4-Flash', 'V4 Flash'],
  'hunyuan-3': ['混元3.0', '混元 3.0', 'Hy3.0', 'Hunyuan3', '混元3'],
  'ernie-5': ['文心5', 'ERNIE5', '文心一言5'],
  'kimi-k3': ['Kimi K3', 'K3', '月之暗面K3'],
  'minimax-m3': ['MiniMax M3', 'M3', 'abab M3'],
  'mimo-2-6-pro': ['MiMo 2.6 Pro', 'MiMo2.6'],
  'spark-5': ['星火5', 'Spark5', '讯飞星火5.0'],
  'step-4': ['Step-4', '阶跃Step4'],
  'qwen-3-8-flash': ['Qwen3.8', '通义千问3.8', 'Qwen-3.8-Flash'],
  'gemini-3-8-flash': ['Gemini 3.8', 'gemini-3.8-flash'],
  'gpt-5-6-sol': ['GPT-5.6', 'GPT5.6'],
  'claude-opus-5': ['Claude Opus 5', 'Opus 5'],
  'claude-sonnet-5': ['Claude Sonnet 5', 'Sonnet 5'],
  'fish-audio-s2-1-pro': ['Fish Audio S2.1', 'S2.1 Pro', 'fish-speech'],
  'seedance-2-5': ['Seedance 2.5', '即梦', 'Seedance'],
  'flux-2-dev': ['FLUX 2 Dev', 'FLUX.2', 'FLUX2'],
  'stable-diffusion-xl': ['SDXL', 'Stable Diffusion XL'],
  'whisper-large-v3-turbo': ['Whisper V3', 'Whisper Large V3', 'whisper-large-v3'],
  'deepgram-nova-3': ['Nova 3', 'Deepgram Nova'],
  'bge-m3': ['BGE-M3', 'bge m3'],
  'z-image-turbo': ['Z-Image', 'ZImage Turbo'],
};

/**
 * 构建匹配索引（一次构建，批量复用）。
 *
 * 返回：
 *   byModelSlug   Map<modelId, {slug,name,folds:Set,caps}>
 *   byProvider    Map<providerId, modelId[]>   该厂商可用于匹配的模型（按端点）
 *   endpointByKey Map<`${providerId}:${modelId}`, endpointId>
 */
export function buildModelIndex(db) {
  const models = all(db, 'SELECT id, slug, name, capability, capabilities, vendor_slug FROM models');
  const endpoints = all(db, 'SELECT id, provider_id, model_id FROM endpoints WHERE enabled = 1');

  const byModelSlug = new Map();
  for (const m of models) {
    const folds = new Set();
    folds.add(foldModelName(m.slug));
    folds.add(foldModelName(m.name));
    for (const a of BUILTIN_ALIASES[m.slug] || []) folds.add(foldModelName(a));
    // 去掉厂商前缀的短名（"DeepSeek V4.1 Flash" → "v4.1flash"）
    const short = String(m.name).replace(/^[A-Za-z\u4e00-\u9fa5]+\s*/, '');
    if (short && short !== m.name) folds.add(foldModelName(short));
    byModelSlug.set(m.id, {
      id: m.id,
      slug: m.slug,
      name: m.name,
      vendorSlug: m.vendor_slug,
      caps: safeCaps(m.capabilities, m.capability),
      folds: [...folds].filter((f) => f.length >= 3), // 太短的折叠串（如 "m3"）容易误伤，但保留在 alias 里显式使用
      allFolds: [...folds],
    });
  }

  // 厂商 → 可用模型（只有存在启用端点的模型才算"该厂商能提供的模型"）
  const byProvider = new Map();
  const endpointByKey = new Map();
  for (const e of endpoints) {
    if (!byProvider.has(e.provider_id)) byProvider.set(e.provider_id, new Set());
    byProvider.get(e.provider_id).add(e.model_id);
    endpointByKey.set(`${e.provider_id}:${e.model_id}`, e.id);
  }

  return { byModelSlug, byProvider, endpointByKey };
}

function safeCaps(raw, primary) {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(v) && v.length ? v : (primary ? [primary] : []);
  } catch {
    return primary ? [primary] : [];
  }
}

/**
 * 从活动文本推断模型。
 *
 * @param {object} args
 * @param {number} args.providerId  活动所属厂商（限制候选范围，大幅降低误判）
 * @param {string} args.text        用于匹配的文本（标题 + 正文）
 * @param {object} args.index       buildModelIndex() 的结果
 * @returns {{modelId:number, endpointId:number|null, matchedBy:string, matchedTerm:string}|null}
 */
export function inferModel({ providerId, text, index }) {
  const candidateIds = index.byProvider.get(providerId);
  if (!candidateIds || !candidateIds.size) return null;

  const folded = foldModelName(text);
  if (!folded) return null;

  // ---- 第 1 级：归一化精确匹配（含别名） ----
  // 取最长命中，避免 "glm53" 抢在 "glm53flash" 前面（实则前者是后者的前缀）
  let best = null;
  for (const modelId of candidateIds) {
    const m = index.byModelSlug.get(modelId);
    if (!m) continue;
    for (const f of m.allFolds) {
      if (f.length < 3) continue;
      if (folded.includes(f)) {
        if (!best || f.length > best.matchedTerm.length) {
          best = { modelId, matchedBy: 'fold', matchedTerm: f };
        }
      }
    }
  }
  if (best) {
    return {
      modelId: best.modelId,
      endpointId: index.endpointByKey.get(`${providerId}:${best.modelId}`) ?? null,
      matchedBy: best.matchedBy,
      matchedTerm: best.matchedTerm,
    };
  }

  // ---- 第 2 级：主版本号匹配（仅唯一候选时采用） ----
  // 背景：活动里常只写 "V4.1" 而省略 Flash；若该厂商在此版本下只有一个模型，
  // 就可以安全推断。有多个（如 V4-Flash 与 V4.1-Flash 都含 "4"）则放弃。
  const hits = new Set();
  for (const modelId of candidateIds) {
    const m = index.byModelSlug.get(modelId);
    if (!m) continue;
    const v = extractVersion(m.name) || extractVersion(m.slug);
    if (!v) continue;
    // 要求文本里出现 "v4.1" / "4.1" 这类带前缀的写法，避免纯数字日期误命中
    const flexRe = new RegExp(`(?:^|[^0-9a-z])v?${v.replace('.', '\\.')}(?![0-9])`, 'i');
    if (flexRe.test(text)) hits.add(modelId);
  }
  if (hits.size === 1) {
    const modelId = [...hits][0];
    const m = index.byModelSlug.get(modelId);
    return {
      modelId,
      endpointId: index.endpointByKey.get(`${providerId}:${modelId}`) ?? null,
      matchedBy: 'version',
      matchedTerm: extractVersion(m?.name || '') || '',
    };
  }
  // 多个候选 → 有歧义，宁可漏也不猜错
  return null;
}

/**
 * 端点识别：活动里若直接给出了 API 地址，且与某端点声明的一致，
 * 则以端点为准（比模型名匹配更硬的证据 —— 用户是照着这个 URL 接入的）。
 */
export function inferEndpointByUrl({ providerId, text, index }) {
  const urls = String(text || '').match(/https?:\/\/[^\s"'<>)\]]+/g) || [];
  if (!urls.length) return null;
  for (const raw of urls) {
    const u = normalizeUrl(raw);
    if (!u) continue;
    const row = get(
      index.db,
      `SELECT id, model_id FROM endpoints
        WHERE provider_id = ? AND api_base_url IS NOT NULL
          AND (api_base_url = ? OR ? LIKE api_base_url || '%')
        LIMIT 1`,
      [providerId, u, u]
    );
    if (row) return { endpointId: row.id, modelId: row.model_id };
  }
  return null;
}

/** 批次关联：给一批已归一化的 item 批量补 modelId / endpointId */
export function linkItemsToModels(db, items) {
  const index = buildModelIndex(db);
  index.db = db;
  // providerSlug → providerId 只需查一次
  const provRows = all(db, 'SELECT id, slug FROM providers');
  const provBySlug = new Map(provRows.map((p) => [p.slug, p.id]));

  let linked = 0, byUrl = 0, ambiguous = 0;
  const details = [];

  for (const it of items) {
    const providerId = provBySlug.get(it.providerSlug);
    if (!providerId) continue;

    // 优先用 API 地址判定（最硬证据）
    const urlHit = inferEndpointByUrl({ providerId, text: `${it.title} ${it.summary || ''} ${it.benefitText || ''}`, index });
    if (urlHit) {
      it.modelId = urlHit.modelId;
      it.endpointId = urlHit.endpointId;
      it.modelMatchedBy = 'api_url';
      linked++; byUrl++;
      details.push({ title: it.title, model: `#${urlHit.modelId}`, by: 'api_url' });
      continue;
    }

    const hit = inferModel({
      providerId,
      text: `${it.title} ${it.summary || ''} ${it.benefitText || ''} ${it.sourceExcerpt || ''}`,
      index,
    });
    if (hit) {
      it.modelId = hit.modelId;
      it.endpointId = hit.endpointId;
      it.modelMatchedBy = hit.matchedBy;
      linked++;
      details.push({ title: it.title, model: hit.matchedTerm, by: hit.matchedBy });
    } else {
      it.modelId = null;
      it.endpointId = null;
      it.modelMatchedBy = null;
    }
  }

  return { linked, byUrl, ambiguous, details };
}
