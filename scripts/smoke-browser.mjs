#!/usr/bin/env node
/**
 * smoke-browser.mjs — 真实浏览器冒烟测试（三层结构新增页面）
 *
 * 用法：
 *   node scripts/smoke-browser.mjs [baseUrl]
 *   默认 baseUrl = http://127.0.0.1:8787
 *
 * 为什么用系统 Chrome 而不是 Playwright 自带的 Chromium：
 * 本机 ms-playwright 缓存目录为空，install chromium 需下载约 150MB 且实测卡死。
 * playwright-core 支持 channel:'chrome'，直接驱动已安装的 Chrome，零下载。
 *
 * 检查项：
 *   1. 每条路由都渲染出非骨架内容（不是卡在 loading 态）
 *   2. 收集所有 console error / pageerror
 *   3. 收集所有失败的请求（4xx/5xx）
 */

import { chromium } from 'playwright-core';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';

const ROUTES = [
  ['home', '/#/'],
  ['activities', '/#/activities'],
  ['models', '/#/models'],
  ['models+cap', '/#/models?capability=image-generation'],
  ['model detail', '/#/model/deepseek-v4-1-flash'],
  ['endpoints', '/#/endpoints'],
  ['endpoints+filter', '/#/endpoints?capability=video-generation&no_card=1'],
  ['endpoint detail', '/#/endpoint/deepseek/deepseek-v4-1-flash'],
  ['guides', '/#/guides'],
  ['guide detail(手写)', '/#/guide/zhipu-zcode-free-tokens'],
  ['guide detail(自动)', '/#/guide/auto-deepseek-11'],
  ['activity detail', '/#/activity/11'],
  ['providers', '/#/providers'],
  ['timeline', '/#/timeline'],
  ['about', '/#/about'],
];

const browser = await chromium.launch({ channel: 'chrome', headless: true });
let totalErr = 0;
let totalFail = 0;

for (const [name, path] of ROUTES) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  const failed = [];

  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });

  try {
    // waitUntil 用 'load' 而非 'networkidle'：
    // app.js 的启动块同时挂了 DOMContentLoaded 与顶层 await，两者都会调 render()，
    // 首屏必然出现一轮重复请求（实测 /api/stats 连发 4 次）。若等 networkidle，
    // 这两轮之间的空隙会让等待一直悬着直到超时 —— 15 条路由全数误报超时。
    await page.goto(BASE + path, { waitUntil: 'load', timeout: 20000 });
    // 等骨架屏消失（.skeleton 是加载态标记）
    await page.waitForFunction(
      () => !document.querySelector('#app .skeleton'),
      { timeout: 12000 }
    ).catch(() => {});
    // 再给二次渲染一点时间，让数据填充完成
    await page.waitForTimeout(700);

    const info = await page.evaluate(() => {
      const app = document.getElementById('app');
      const txt = (app?.innerText || '').replace(/\s+/g, ' ').trim();
      return {
        hasSkeleton: !!document.querySelector('#app .skeleton'),
        hasEmpty: !!document.querySelector('#app .empty'),
        cards: document.querySelectorAll('#app .card').length,
        chips: document.querySelectorAll('#app .cap-chip').length,
        badges: document.querySelectorAll('#app .badge').length,
        h1: document.querySelector('#app h1')?.innerText || '',
        len: txt.length,
        sample: txt.slice(0, 110),
      };
    });

    const flag = info.hasSkeleton ? '⏳卡加载' : info.len < 40 ? '⚠️内容过少' : '✅';
    console.log(`${flag} ${name.padEnd(20)} h1="${info.h1.slice(0, 26)}" 卡片=${String(info.cards).padStart(3)} chip=${String(info.chips).padStart(2)} 徽章=${String(info.badges).padStart(3)} 文本=${info.len}B`);
    console.log(`      ${info.sample}`);
    if (info.hasEmpty) console.log('      （页面为空态：可能是筛选无结果，需人工判断）');
  } catch (e) {
    console.log(`❌ ${name.padEnd(20)} 渲染异常: ${e.message.split('\n')[0]}`);
  }

  if (errors.length) {
    totalErr += errors.length;
    console.log(`   console.error ×${errors.length}:`);
    [...new Set(errors)].slice(0, 4).forEach((x) => console.log('     · ' + x.slice(0, 150)));
  }
  if (failed.length) {
    totalFail += failed.length;
    console.log(`   请求失败 ×${failed.length}:`);
    [...new Set(failed)].slice(0, 4).forEach((x) => console.log('     · ' + x.slice(0, 150)));
  }

  await page.close();
}

await browser.close();
console.log('');
console.log('─────────────────────────────');
console.log(`合计：console 错误 ${totalErr} 条 / 请求失败 ${totalFail} 条`);
process.exit(totalErr || totalFail ? 1 : 0);
