/**
 * probe-sources.js — 探测厂商公告/博客页的真实可达 URL
 *
 * 背景：DDG 搜索已被反爬封禁（实测 403），搜索型源实质失效。
 * 但免费额度活动恰恰发布在**公告/博客/新闻页**，不在定价页。
 * 因此需要一个不依赖搜索引擎的发现手段：直接对厂商域名猜测常见路径，
 * 再用 HTTP 探测验证可达性。**只有验证通过的 URL 才允许写入配置。**
 *
 * 设计原则（沿用项目一贯的"不塞假数据"）：
 *   - 探测结果只输出报告，不自动改配置（由人复核后写入）
 *   - 区分「可达」与「看起来对」——以 HTTP 状态码 + 正文字数为准
 *   - 识别 SPA 空壳页（200 但正文极少），这类页面抓不到内容，标记为 suspicious
 *
 * 用法：
 *   node scripts/probe-sources.js              # 探测所有厂商
 *   node scripts/probe-sources.js zhipu groq   # 只探测指定厂商
 */

import { loadProviders, loadSettings } from '../src/lib/config.js';
import { createHash } from 'node:crypto';

/**
 * ⚠️ UA 必须与流水线一致（实测教训 2026-10-03）
 *
 * 初版这里硬编码 Chrome UA，验证通过后写进配置，结果流水线跑起来报 403。
 * 因为流水线用的是 config/settings.json 里的诚实 UA（TokenFreeBot/1.0）。
 * 实测同一 URL：
 *   TokenFreeBot/1.0 → 403
 *   Chrome           → 200（368KB）
 *
 * 教训：**探测的验证条件必须与生产运行时完全一致**，
 * 否则"验证通过"不代表"上线可用"，等于自欺欺人。
 *
 * 故这里**从 settings 读取**（而非硬编码），从根上杜绝两边漂移。
 * 刻意沿用诚实 UA —— 若站点拒绝被我们抓取，就诚实放弃，
 * 而不是伪装浏览器绕过（那会让 robots/UA 声明失去意义）。
 */
const UA = loadSettings().fetch?.userAgent
  || 'TokenFreeBot/1.0 (+https://github.com/sanbeitixigua123/token-free)';

const TIMEOUT_MS = 12000;
const CONCURRENCY_PER_HOST = 1;

/** 常见公告/博客路径模板（{base} 由厂商域名替换） */
const PATH_TEMPLATES = [
  '/blog', '/news', '/announcements', '/announcement', '/changelog',
  '/updates', '/whats-new', '/release-notes', '/posts', '/articles',
  '/zh/blog', '/en/blog', '/cn/blog', '/newsroom', '/press',
  '/blog/category/announcements', '/docs/changelog',
];

/** 正文占比过低的页面视为 SPA 空壳（抓不到内容） */
const MIN_TEXT_LEN = 400;

/**
 * catch-all 路由检测（关键！）
 *
 * 实测教训（2026-10-03）：moonshot.cn 对 `/blog`、`/news`、`/changelog` 等
 * **17 条候选路径全部返回 200 且正文字数完全相同（905 字）**——
 * 这是 SPA 的兜底路由：不存在的路径也回落到同一个外壳页。
 * 若只看"200 + 字数够"就写入配置，会得到 17 个内容雷同的假源，
 * 既浪费抓取配额又污染数据。
 *
 * 判据：同一 host 下若 **≥2 条路径的正文指纹完全相同**，判定为 catch-all，
 * 这些结果全部作废。用内容指纹而非字数，即使外壳页字数抖动也能识别。
 */
function detectCatchAll(results) {
  const hashCount = new Map();
  for (const r of results) {
    if (!r.ok || r.status === 'already-configured' || !r.hash) continue;
    hashCount.set(r.hash, (hashCount.get(r.hash) || 0) + 1);
  }
  return new Set(
    [...hashCount.entries()].filter(([, n]) => n >= 2).map(([h]) => h)
  );
}

/**
 * 重定向后去重（实测教训 2026-10-03）：
 *   github.com/blog    → 302 → github.blog
 *   github.com/updates → 302 → github.blog     ← 两条实为同一页
 * 若只按"候选 URL 字符串"去重，会把同一目标页当两条源写入。
 * 故必须按 **最终 URL**（res.url）与 **正文指纹** 双重去重。
 */
function dedupeByFinal(results) {
  const seenFinal = new Map();   // finalUrl → 首次出现的候选
  const seenHash = new Map();    // 正文指纹 → 首次出现的候选
  const out = [];
  for (const r of results) {
    if (r.status === 'already-configured') { out.push(r); continue; }
    if (!r.ok) { out.push(r); continue; }

    const finalKey = normalizeFinal(r.finalUrl || r.url);
    const dupOf = seenFinal.get(finalKey) || (r.hash ? seenHash.get(r.hash) : null);
    if (dupOf) {
      out.push({ ...r, ok: false, duplicate: true, duplicateOf: dupOf });
      continue;
    }
    seenFinal.set(finalKey, r.url);
    if (r.hash) seenHash.set(r.hash, r.url);
    out.push(r);
  }
  return out;
}

/** 归一化最终 URL：去尾斜杠、去 www、统一小写 host */
function normalizeFinal(u) {
  try {
    const x = new URL(u);
    const host = x.host.toLowerCase().replace(/^www\./, '');
    const path = x.pathname.replace(/\/+$/, '') || '/';
    return host + path;
  } catch {
    return String(u);
  }
}

/**
 * 站点归属校验：候选页最终落在的域名，必须与厂官网同域或为其子域。
 *
 * 实测教训：`aws.amazon.com/articles` 会 302 到 AWS 的上手教程页，
 * 正文 8162 字、HTTP 200，**所有机械判据都通过**，但与 Amazon Q 毫无关系。
 * 同理 `github.com/announcements` 实际是某个用户仓库。
 * 仅靠"可达 + 有内容"无法识别这种张冠李戴，必须核对域名归属。
 *
 * 例外：允许已知的官方博客独立域名（如 github.com → github.blog）。
 */
const KNOWN_BLOG_ALIASES = {
  'github.com': ['github.blog'],
  'twitch.tv': ['blog.twitch.tv'],
};

function belongsToSite(finalUrl, origin) {
  const host = hostOf(finalUrl).toLowerCase().replace(/^www\./, '');
  const root = hostOf(origin).toLowerCase().replace(/^www\./, '');
  if (!host || !root) return false;
  if (host === root || host.endsWith('.' + root)) return true;
  // 官网是子域时，允许升到主域（platform.stepfun.com → stepfun.com）
  const rootMain = root.split('.').slice(-2).join('.');
  if (host === rootMain || host.endsWith('.' + rootMain)) return true;
  // 已知的官方博客独立域名
  for (const [from, aliases] of Object.entries(KNOWN_BLOG_ALIASES)) {
    if (root.endsWith(from) && aliases.includes(host)) return true;
  }
  return false;
}

/**
 * 内容相关性校验（第四层，实测教训 2026-10-03）
 *
 * 归属校验解决不了「平台型厂商」的问题：
 *   github-copilot 的官网是 github.com，于是 github.com/announcements、
 *   /articles、/release-notes 都"同域"，统统通过。但这些其实是**用户仓库**，
 *   不是 Copilot 的公告页。
 *
 * ⚠️ 关键教训：最初用"全站正文含关键词"判断，**完全失效**——
 *   因为 github.com 的**全站导航栏**里有 "GitHub Copilot" 菜单项，
 *   导致任何 GitHub 页面都命中 "copilot"。
 *   实测三例：
 *     github.com/announcements → <title>Announcements (Planibel) · GitHub</title>  用户仓库
 *     github.com/articles      → <title>articles · GitHub</title>                    用户仓库
 *     aws.amazon.com/articles  → <title>Hands-On Tutorials for AWS</title>          通用教程页
 *   三者的 title 都不含产品名，却因导航栏而"正文命中"。
 *
 * → 正解：**只看 <title> 与首个 <h1>**，不看全站正文。
 *   title/h1 是页面自我声明的归属，导航栏噪声自然被排除。
 */
function isContentRelevant(r, provider) {
  if (!r.head) return false;

  // 只取 title 与 h1 —— 页面自我声明，不含全站导航噪声
  const title = (r.head.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const h1 = (r.head.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '';
  const hay = stripTags(`${title} ${h1}`).toLowerCase();
  if (!hay) return false;

  const terms = new Set();
  // 1) 中英文名（完整名，避免泛词）
  for (const n of [provider.name_zh, provider.name_en]) {
    if (n) terms.add(String(n).toLowerCase());
  }

  // 2) ⚠️ 刻意不做 slug 分词（实测教训）：
  //    github-copilot 分词得到 "github"，这是**平台泛指词**，
  //    导致 `Announcements (Planibel) · GitHub` 这类**用户仓库**页也命中。
  //    平台曾似产品时，泛词必须排除，只用下面的别名表（产品名）。
  //    故此处只接受长度较长且非泛指的 slug 片段。
  const PLATFORM_WORDS = new Set([
    'github', 'google', 'amazon', 'tencent', 'baidu', 'aliyun', 'alibaba',
    'bytedance', 'volcengine', 'microsoft', 'meta', 'apple',
  ]);
  const parts = String(provider.slug).toLowerCase().split(/[-_]/)
    .filter((x) => x.length >= 5 && !PLATFORM_WORDS.has(x));
  for (const p of parts) terms.add(p);

  // 3) 强相关别名：子产品名才是 title 里真正出现的词
  const ALIASES = {
    'github-copilot': ['copilot'],
    'amazon-q': ['amazon q', 'q developer', 'amazonq'],
    'gemini-code-assist': ['gemini code assist', 'code assist'],
    'tencent-codebuddy': ['codebuddy'],
    'baidu-comate': ['comate'],
    'aliyun-lingma': ['lingma', '通义灵码'],
    'zhipu-zcode': ['zcode'],
    'alibaba-qwen': ['通义千问', 'qwen'],
    'bytedance-doubao': ['豆包', 'doubao'],
    'baidu-ernie': ['文心一言', '文心', 'ernie'],
    'tencent-hunyuan': ['混元', 'hunyuan'],
    'iflytek-spark': ['讯飞星火', '星火', 'spark'],
    'siliconflow': ['siliconflow', '硅基流动'],
    'volcengine-ark': ['方舟', 'ark'],
    'openai': ['openai'],
    'anthropic': ['anthropic', 'claude'],
    'deepseek': ['deepseek'],
    'moonshot': ['moonshot', 'kimi'],
    'minimax': ['minimax'],
    'zhipu': ['zhipu', 'glm', '智谱'],
    'mistral': ['mistral'],
    'groq': ['groq'],
    'together-ai': ['together'],
    'openrouter': ['openrouter'],
    'cerebras': ['cerebras'],
    'windsurf': ['windsurf', 'codeium'],
    'cline': ['cline'],
    'continue-dev': ['continue'],
    'cursor': ['cursor'],
    'qoder': ['qoder'],
    'trae': ['trae'],
    'xai': ['xai', 'grok'],
    'stepfun': ['stepfun', '阶跃'],
    'baichuan': ['baichuan', '百川'],
    'jetbrains-ai': ['jetbrains'],
    'github-student': ['github education', 'student developer pack'],
  };
  for (const a of ALIASES[provider.slug] || []) terms.add(a.toLowerCase());

  for (const t of terms) {
    if (t && hay.includes(t)) return true;
  }
  return false;
}

function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

/** 粗略提取可见文本长度（去脚本/样式/标签） */
function rawText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function textLength(html) {
  return rawText(html).length;
}

/** 正文指纹：内容雷同的页面即使字数不同也能识别为同一外壳 */
function bodyHash(html) {
  return createHash('sha256').update(rawText(html)).digest('hex').slice(0, 16);
}

async function probe(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
    });
    const html = res.ok ? await res.text() : '';
    const text = html ? rawText(html) : '';
    const len = text.length;
    return {
      url,
      finalUrl: res.url,
      status: res.status,
      textLen: len,
      hash: text ? createHash('sha256').update(text).digest('hex').slice(0, 16) : '',
      // 可达 = 2xx 且正文足够（排除 SPA 空壳与纯跳转页）
      ok: res.ok && len >= MIN_TEXT_LEN,
      shell: res.ok && len < MIN_TEXT_LEN,
      // 保留正文头部供内容相关性判断（最多 20KB，足够覆盖 title/meta/首屏）
      head: html.slice(0, 20000),
    };
  } catch (err) {
    return { url, status: 0, textLen: 0, ok: false, err: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function probeProvider(p) {
  const origin = originOf(p.website || '');
  if (!origin) return { slug: p.slug, name: p.name_zh, results: [], note: '无 website，跳过' };

  const existing = new Set(
    (p.sources || []).filter((s) => s.url).map((s) => s.url.replace(/\/+$/, ''))
  );

  const results = [];
  for (const tpl of PATH_TEMPLATES) {
    const url = origin + tpl;
    if (existing.has(url)) {
      results.push({ url, status: 'already-configured', ok: true, textLen: 0 });
      continue;
    }
    const r = await probe(url);
    results.push(r);
    // 同域串行，礼貌间隔
    await new Promise((res) => setTimeout(res, 400));
  }
  return { slug: p.slug, name: p.name_zh, origin, results };
}

async function main() {
  const filter = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const asJson = process.argv.includes('--json');
  const all = loadProviders();
  const targets = filter.length ? all.filter((p) => filter.includes(p.slug)) : all;

  if (!asJson) {
    console.log(`探测 ${targets.length} 家厂商（每家 ${PATH_TEMPLATES.length} 条候选路径）\n`);
  }

  const summary = [];
  for (const p of targets) {
    const raw = await probeProvider(p);
    // 四道校验，顺序有讲究：
    //   1) 归属校验 —— 剔除非本厂商域名的页面（张冠李戴）
    //   2) 内容相关 —— 剔除同域但与该产品无关的通用页（平台型厂商陷阱）
    //   3) catch-all —— 剔除同 host 下的 SPA 兜底外壳
    //   4) 重定向去重 —— 剔除 302 到同一目标的重复候选
    const origin = raw.origin;
    const owned = raw.results.map((x) =>
      (x.ok && x.finalUrl && !belongsToSite(x.finalUrl, origin))
        ? { ...x, ok: false, foreign: true }
        : x
    );
    const relevant = owned.map((x) =>
      (x.ok && x.status !== 'already-configured' && !isContentRelevant(x, p))
        ? { ...x, ok: false, irrelevant: true }
        : x
    );
    const catchAllHashes = detectCatchAll(relevant);
    const noCatchAll = relevant.map((x) =>
      (x.ok && x.hash && catchAllHashes.has(x.hash)) ? { ...x, ok: false, catchAll: true } : x
    );
    const clean = dedupeByFinal(noCatchAll);

    const good = clean.filter((x) => x.ok && x.status !== 'already-configured');
    const shells = clean.filter((x) => x.shell);
    const foreign = clean.filter((x) => x.foreign);
    const irrelevant = clean.filter((x) => x.irrelevant);
    const catchAll = clean.filter((x) => x.catchAll);
    const dupes = clean.filter((x) => x.duplicate);
    summary.push({ ...raw, results: clean, good, shells, foreign, irrelevant, catchAll, dupes });

    let tag;
    if (good.length) tag = `✅ ${good.length} 条可用`;
    else if (foreign.length) tag = `⚠️ ${foreign.length} 条落在他域（张冠李戴）`;
    else if (irrelevant.length) tag = `⚠️ ${irrelevant.length} 条与产品无关（同域通用页）`;
    else if (catchAll.length) tag = `⚠️ 全部为 catch-all 外壳（${catchAll.length} 条雷同）`;
    else if (dupes.length) tag = `⚠️ ${dupes.length} 条重定向后重复`;
    else if (shells.length) tag = `⚠️ 仅空壳 ${shells.length}`;
    else tag = '❌ 无';

    if (!asJson) {
      console.log(`[${p.slug}] ${tag}`);
      for (const g of good) {
        const moved = g.finalUrl && normalizeFinal(g.finalUrl) !== normalizeFinal(g.url) ? ` → ${g.finalUrl}` : '';
        console.log(`    OK  ${g.status}  ${String(g.textLen).padStart(6)}字  ${g.url}${moved}`);
      }
      if (foreign.length) {
        console.log(`    他域: ${foreign.length} 条（例 ${foreign[0].url} → ${foreign[0].finalUrl}），已排除`);
      }
      if (irrelevant.length) {
        console.log(`    无关: ${irrelevant.length} 条（例 ${irrelevant[0].url}，title/h1 未提及该产品），已排除`);
      }
      if (catchAll.length) {
        console.log(`    catch-all: ${catchAll.length} 条路径返回相同内容（例：${catchAll[0].url}），已排除`);
      }
      if (dupes.length) {
        console.log(`    重定向重复: ${dupes.length} 条（例 ${dupes[0].url} 与 ${dupes[0].duplicateOf} 同页），已排除`);
      }
      for (const s of shells) console.log(`    SPA ${s.status}  ${String(s.textLen).padStart(6)}字  ${s.url}`);
      console.log('');
    }
  }

  if (asJson) {
    // 机器可读输出，供后续写入配置使用（避免二次慢速重探）
    const out = summary.map((s) => ({
      slug: s.slug,
      name: s.name,
      origin: s.origin,
      usable: s.good.map((g) => ({
        url: g.url,
        finalUrl: g.finalUrl,
        status: g.status,
        textLen: g.textLen,
      })),
      rejected: {
        foreign: s.foreign.length,
        irrelevant: s.irrelevant.length,
        catchAll: s.catchAll.length,
        duplicate: s.dupes.length,
        shell: s.shells.length,
      },
    }));
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const totalGood = summary.reduce((n, s) => n + s.good.length, 0);
  console.log(`==== 汇总：${summary.filter((s) => s.good.length).length}/${summary.length} 家有可用新源，共 ${totalGood} 条 ====`);

  // 供人工写入配置的清单
  console.log('\n---- 建议写入 providers.yaml 的 URL ----');
  for (const s of summary) {
    if (!s.good.length) continue;
    console.log(`${s.slug}:`);
    for (const g of s.good) console.log(`  - ${g.url}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
