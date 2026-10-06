// 诊断：直接观察 LLM 的原始返回与解析结果（不依赖具体厂商，读 settings.llm）
//
// 用途：当抽取结果异常（如恒为 0 条、字段为 null）时，先用它看模型到底回了什么，
//       避免把「模型返回不符合预期」误判成「代码坏了」。
// 用法：node scripts/diag-llm.mjs
import { loadSettings } from '../src/lib/config.js';
import { SYSTEM_PROMPT } from '../src/pipeline/llm-extract.js';

const settings = loadSettings();
const cfg = settings.llm;

const provider = { slug: 'zhipu', name_zh: '智谱 AI', country: 'CN' };
const source = { url: 'https://open.bigmodel.cn/pricing' };
const cand = {
  text: '智谱开放平台新用户注册即送 2000 万 Token 免费额度，有效期 3 个月。领取地址 https://open.bigmodel.cn/free',
  url: 'https://open.bigmodel.cn/pricing',
  title: '新用户免费额度',
};

const user = `厂商：${provider.name_zh}（${provider.slug}，国别 ${provider.country}）
来源页面：${source.url}
参考年份（用于补全不带年份的日期）：2026

【正文片段】
${cand.text}

请按规则输出 JSON。`;

const res = await fetch(cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
  body: JSON.stringify({
    model: cfg.model,
    temperature: 0,
    max_tokens: 1200,
    thinking: { type: 'disabled' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: user },
    ],
  }),
  signal: AbortSignal.timeout(180000),
});

console.log('HTTP:', res.status);
const data = await res.json();

if (data.error) {
  console.log('ERROR:', JSON.stringify(data.error));
} else {
  const msg = data.choices?.[0]?.message || {};
  console.log('finish_reason:', data.choices?.[0]?.finish_reason);
  console.log('usage:', JSON.stringify(data.usage));
  console.log('--- message.content (长度 ' + (msg.content || '').length + ') ---');
  console.log(msg.content);
  console.log('--- reasoning_content 长度:', (msg.reasoning_content || '').length, '---');

  // 复刻 parseJsonLoose
  let t = String(msg.content || '').trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  console.log('--- 解析 ---');
  console.log('start=' + start, 'end=' + end);
  if (start !== -1 && end !== -1) {
    try {
      const obj = JSON.parse(t.slice(start, end + 1));
      console.log('JSON 解析成功:');
      console.log(JSON.stringify(obj, null, 2));
    } catch (e) {
      console.log('JSON 解析失败:', e.message);
      console.log('待解析片段前 300 字:', t.slice(start, start + 300));
    }
  } else {
    console.log('未找到 JSON 大括号！原始 content:');
    console.log(JSON.stringify(msg.content).slice(0, 500));
  }
}
