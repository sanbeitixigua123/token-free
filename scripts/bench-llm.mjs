// LLM 延迟基准：用真实 SYSTEM_PROMPT 对比多个模型的响应时间与稳定性
//
// 为什么需要：网关延迟波动极大（实测 5s~57s），短提示词测不出问题，
// 必须用真实长提示词跑多次才能看出哪个模型稳定。
//
// 用法：node scripts/bench-llm.mjs [每模型次数]

import { loadSettings } from '../src/lib/config.js';
import { SYSTEM_PROMPT } from '../src/pipeline/llm-extract.js';

const cfg = loadSettings().llm;
const ROUNDS = parseInt(process.argv[2] || '3', 10);

const MODELS = ['deepseek-v4-flash-0731', 'deepseek-v4-pro-0813'];

const USER_PROMPT = `厂商：智谱 AI（zhipu，国别 CN）
来源页面：https://open.bigmodel.cn/pricing
参考年份（用于补全不带年份的日期）：2026
原文候选链接：（无）

----- 待抽取文本开始 -----
智谱开放平台新用户注册即送 2000 万 Token 免费额度，有效期 3 个月。领取地址 https://open.bigmodel.cn/free
----- 待抽取文本结束 -----

请按规则输出 JSON。`;

async function callOnce(model) {
  const t0 = Date.now();
  try {
    const res = await fetch(cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 1200,
        thinking: { type: 'disabled' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: USER_PROMPT },
        ],
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 120000),
    });
    const ms = Date.now() - t0;
    if (!res.ok) {
      const b = await res.text().catch(() => '');
      return { ms, ok: false, err: `HTTP ${res.status} ${b.slice(0, 80)}` };
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const ct = data?.usage?.completion_tokens ?? 0;
    return { ms, ok: true, tokens: ct, hasTitle: /"title"\s*:\s*"[^"]+"/.test(content) };
  } catch (e) {
    return { ms: Date.now() - t0, ok: false, err: e.name === 'TimeoutError' ? '超时' : e.message.slice(0, 60) };
  }
}

console.log(`基准测试：每模型 ${ROUNDS} 次，超时上限 ${cfg.timeoutMs}ms\n`);

for (const model of MODELS) {
  const results = [];
  for (let i = 0; i < ROUNDS; i++) {
    const r = await callOnce(model);
    results.push(r);
    console.log(
      `  ${model.padEnd(24)} #${i + 1}  ${String(r.ms).padStart(6)}ms  ` +
      (r.ok ? `✅ tokens=${r.tokens} title=${r.hasTitle ? '有' : '无'}` : `❌ ${r.err}`)
    );
  }
  const ok = results.filter((r) => r.ok);
  const times = ok.map((r) => r.ms).sort((a, b) => a - b);
  const avg = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0;
  console.log(
    `  → 成功 ${ok.length}/${ROUNDS} | 平均 ${avg}ms | 中位 ${times.length ? times[Math.floor(times.length / 2)] : 0}ms` +
    ` | 最快 ${times[0] ?? '-'}ms | 最慢 ${times[times.length - 1] ?? '-'}ms\n`
  );
}
