import fs from 'node:fs';
import { loadProviders, loadModels, loadEndpoints } from '../src/lib/config.js';

const provs = new Set(loadProviders().map((p) => p.slug));
const models = new Set(loadModels().map((m) => m.slug));
const eps = loadEndpoints();

console.log('=== 配置交叉校验 ===\n');
console.log('厂商清单:', provs.size, '家');
console.log('模型清单:', models.size, '个');
console.log('端点清单:', eps.length, '个\n');

// 1) endpoints 引用的 provider 是否存在
const badProv = new Set();
// 2) endpoints 引用的 model 是否存在
const badModel = new Set();
// 3) 重复端点
const seen = new Map();
const dup = [];

for (const e of eps) {
  if (!provs.has(e.provider)) badProv.add(e.provider);
  if (!models.has(e.model)) badModel.add(e.model);
  const key = `${e.provider}--${e.model}`;
  if (seen.has(key)) dup.push(key);
  seen.set(key, true);
}

if (badProv.size) {
  console.log('❌ 端点引用了不存在的厂商：');
  for (const s of badProv) console.log('   ', s);
} else console.log('✅ 端点引用的厂商全部存在');

if (badModel.size) {
  console.log('❌ 端点引用了不存在的模型：');
  for (const s of badModel) console.log('   ', s);
} else console.log('✅ 端点引用的模型全部存在');

if (dup.length) {
  console.log('❌ 重复端点（同厂商同模型）：');
  for (const s of dup) console.log('   ', s);
} else console.log('✅ 无重复端点');

// 4) 模型引用的 vendor_slug（仅提示，vendor_slug 允许是厂商之外的第三方）
const l = await import('../src/lib/config.js').then((m) => m.loadYamlFile('models.yaml'));
const vendorRefs = [...new Set((l?.models || []).map((m) => m.vendor_slug).filter(Boolean))];
const unknownVendor = vendorRefs.filter((v) => !provs.has(v));
console.log('\n模型 vendor_slug 中不是已收录厂商的（正常，可能是第三方开发方）：');
console.log('   ', unknownVendor.join(', ') || '(无)');

// 5) 能力分布
const byCap = {};
for (const m of (l?.models || [])) {
  const c = m.capability || 'text-generation';
  byCap[c] = (byCap[c] || 0) + 1;
}
console.log('\n模型能力分布：');
for (const [k, v] of Object.entries(byCap).sort((a, b) => b[1] - a[1])) {
  console.log('   ', k.padEnd(22), v);
}

process.exit(badProv.size || badModel.size || dup.length ? 1 : 0);
