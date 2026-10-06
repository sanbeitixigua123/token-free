// 端到端验证：走真实的 extractWithLLM 代码路径（不是 curl）
//
// 为什么必须走真实代码路径：curl 只能验证「端点通不通」，
// 而这里会一并验证提示词拼装、JSON 解析、白名单校验、置信度调整等下游逻辑。
// 换 LLM 厂商后务必跑一次。
//
// 用法：node scripts/test-llm.mjs
//
// ⚠️ 构造测试候选时字段名必须是 cand.context —— buildUserPrompt 读的是 context，
//    写成 cand.text 会导致提示词正文为空、模型返回 isActivity:false，
//    看起来像"代码坏了"，实际是测试数据构造错误（已踩过）。
import { loadSettings } from '../src/lib/config.js';
import { extractWithLLM, llmCredentialsInvalid, resetLlmCredentialState } from '../src/pipeline/llm-extract.js';

const settings = loadSettings();
const provider = { slug: 'zhipu', name_zh: '智谱 AI', country: 'CN' };
const source = { url: 'https://open.bigmodel.cn/pricing' };

const candidates = [
  {
    // 注意字段名是 context（buildUserPrompt 读的是 cand.context），不是 text。
    context: '智谱开放平台新用户注册即送 2000 万 Token 免费额度，有效期 3 个月。领取地址 https://open.bigmodel.cn/free',
    url: 'https://open.bigmodel.cn/pricing',
    title: '新用户免费额度',
  },
  {
    context: '本公司成立于 2019 年，是一家专注于人工智能基础模型研发的高科技企业，现有员工 500 余人。',
    url: 'https://open.bigmodel.cn/about',
    title: '关于我们',
  },
];

resetLlmCredentialState();
const t0 = Date.now();
const out = await extractWithLLM(candidates, {
  provider,
  source,
  refYear: 2026,
  settings,
  allowedHosts: ['bigmodel.cn'],
});
const ms = Date.now() - t0;

console.log('=== 结果 ===');
console.log('耗时      :', ms + 'ms');
console.log('凭据失效  :', llmCredentialsInvalid());
console.log('抽出条数  :', out.length, '（预期 1：非活动文本应被过滤）');
console.log(JSON.stringify(out, null, 2));
