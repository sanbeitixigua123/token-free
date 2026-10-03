/**
 * test-relevance.js — 离线单测：内容相关性判据（isContentRelevant）
 *
 * 为什么要单独测：这个判据在实测中连错三版，每版都靠"跑 5 分钟网络探测再看结果"来验证，
 * 反馈太慢且浪费。把纯函数抽出来离线测，秒级拿到结论。
 *
 * 用例全部来自 2026-10-03 的真实探测结果（含 title 原文）。
 * 用法：node scripts/test-relevance.js
 */

// 直接从 probe-sources.js 复制判据（该文件是 CLI 脚本，import 会触发全量探测，
// 故此处内联同一份逻辑并保持一致；若判据变更需同步两处）
function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

const PLATFORM_WORDS = new Set([
  'github', 'google', 'amazon', 'tencent', 'baidu', 'aliyun', 'alibaba',
  'bytedance', 'volcengine', 'microsoft', 'meta', 'apple',
]);

const ALIASES = {
  'github-copilot': ['copilot'],
  'amazon-q': ['amazon q', 'q developer', 'amazonq'],
  'gemini-code-assist': ['gemini code assist', 'code assist'],
  'tencent-codebuddy': ['codebuddy'],
  'baidu-comate': ['comate'],
  'aliyun-lingma': ['lingma', '通义灵码'],
  'zhipu-zcode': ['zcode'],
  'openai': ['openai'],
  'deepseek': ['deepseek'],
  'moonshot': ['moonshot', 'kimi'],
  'minimax': ['minimax'],
  'trae': ['trae'],
  'qoder': ['qoder'],
  'together-ai': ['together'],
  'volcengine-ark': ['方舟', 'ark'],
  'bytedance-doubao': ['豆包', 'doubao'],
};

function isContentRelevant(head, provider) {
  if (!head) return false;
  const title = (head.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const h1 = (head.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '';
  const hay = stripTags(`${title} ${h1}`).toLowerCase();
  if (!hay) return false;

  const terms = new Set();
  for (const n of [provider.name_zh, provider.name_en]) {
    if (n) terms.add(String(n).toLowerCase());
  }
  const parts = String(provider.slug).toLowerCase().split(/[-_]/)
    .filter((x) => x.length >= 5 && !PLATFORM_WORDS.has(x));
  for (const p of parts) terms.add(p);
  for (const a of ALIASES[provider.slug] || []) terms.add(a.toLowerCase());

  for (const t of terms) {
    if (t && hay.includes(t)) return true;
  }
  return false;
}

// ---------------- 用例 ----------------
// [期望, 说明, title/h1 原文, provider]

const CASES = [
  // —— 应判为「无关」（假阳性，必须挡住）——
  [false, 'GitHub 用户仓库 announcements (Planibel)',
    '<title>Announcements (Planibel) · GitHub</title>',
    { slug: 'github-copilot', name_zh: 'GitHub Copilot', name_en: 'GitHub Copilot' }],

  [false, 'GitHub 用户仓库 articles',
    '<title>articles · GitHub</title>',
    { slug: 'github-copilot', name_zh: 'GitHub Copilot', name_en: 'GitHub Copilot' }],

  [false, 'AWS 通用上手教程页',
    '<title>Hands-On Tutorials for Amazon Web Services (AWS)</title>',
    { slug: 'amazon-q', name_zh: 'Amazon Q Developer', name_en: 'Amazon Q Developer' }],

  [false, 'GitHub 全站博客（无 Copilot 字样）',
    '<title>Home - The GitHub Blog</title>',
    { slug: 'github-copilot', name_zh: 'GitHub Copilot', name_en: 'GitHub Copilot' }],

  // —— 应判为「相关」（真阳性，不能误杀）——
  [true, 'OpenAI 中文新闻页',
    '<title>OpenAI 新闻 | OpenAI</title>',
    { slug: 'openai', name_zh: 'OpenAI', name_en: 'OpenAI' }],

  [true, 'DeepSeek 新闻页',
    '<title>DeepSeek - News</title>',
    { slug: 'deepseek', name_zh: 'DeepSeek', name_en: 'DeepSeek' }],

  [true, 'Trae 官方博客',
    '<title>Trae Blog</title>',
    { slug: 'trae', name_zh: '字节 Trae', name_en: 'Trae' }],

  [true, 'Qoder 更新日志',
    '<title>Changelog - Qoder</title>',
    { slug: 'qoder', name_zh: '阿里 Qoder', name_en: 'Qoder' }],

  [true, 'Together AI 新闻页',
    '<title>News & Press | Together AI</title>',
    { slug: 'together-ai', name_zh: 'Together AI', name_en: 'Together AI' }],

  [true, '火山引擎方舟——产品名出现在 title',
    '<title>火山方舟 - 大模型服务平台</title>',
    { slug: 'volcengine-ark', name_zh: '火山引擎方舟', name_en: 'Volcengine Ark' }],

  // 注意：'火山引擎 - 新闻中心'（不含"方舟"）应判【无关】——
  // 它是火山引擎**全站**新闻，不是方舟子产品页。这条曾经被我写成"期望相关"，
  // 属用例设置有误：厂商名含泛平台名时，只有子产品名才算相关。
  [false, '火山引擎全站新闻（无"方舟"，应无关）',
    '<title>火山引擎 - 新闻中心</title>',
    { slug: 'volcengine-ark', name_zh: '火山引擎方舟', name_en: 'Volcengine Ark' }],

  [true, 'Copilot 专属页（含 copilot）',
    '<title>GitHub Copilot - Your AI pair programmer</title>',
    { slug: 'github-copilot', name_zh: 'GitHub Copilot', name_en: 'GitHub Copilot' }],

  // —— 边界：无 title 应判无关（宁缺毋滥）——
  [false, '无 title/h1',
    '<html><body>some content</body></html>',
    { slug: 'openai', name_zh: 'OpenAI', name_en: 'OpenAI' }],
];

let pass = 0, fail = 0;
for (const [expect, desc, head, provider] of CASES) {
  const got = isContentRelevant(head, provider);
  const ok = got === expect;
  if (ok) pass++; else fail++;
  console.log(`${ok ? '✅' : '❌'} [${expect ? '相关' : '无关'}] ${desc}`);
  if (!ok) console.log(`      期望 ${expect}，实际 ${got}`);
}

console.log(`\n${pass} 通过 / ${fail} 失败（共 ${CASES.length}）`);
process.exit(fail ? 1 : 0);
