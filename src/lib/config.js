/**
 * config.js — 配置加载
 *
 * providers.yaml 用「极简 YAML 子集」自解析，避免引入 yaml 依赖。
 * 支持的语法子集（足够表达厂商清单）：
 *   - key: value
 *   - key:
 *       - item
 *     - nested_key: value
 *   引号可选；# 开头为注释；空行忽略。
 *
 * 若日后需要更复杂的 YAML，可 `npm i yaml` 并把 loadYaml 换成 yaml.parse。
 */

import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../db/db.js';

const CONFIG_DIR = path.join(PROJECT_ROOT, 'config');

// ---------------- 极简 YAML 解析器（缩进驱动） ----------------

function parseScalar(raw) {
  let v = raw.trim();
  if (v === '' || v === '~' || v.toLowerCase() === 'null') return null;
  // 去引号。
  // ⚠️ 双引号内必须还原转义序列（\n / \" / \\），否则自动生成的攻略正文会带着
  // 字面量 "\n" 显示（实测：guide-gen 写出的体段落，前端渲染成长串反斜杠 n）。
  // 本项目是行式解析器（一行一个值），无法表达真正的多行标量，
  // 因此换行**只能**靠 "\n" 转义承载 —— 这里就成了唯一的还原点。
  // 单引号按 YAML 规范不做转义，保持原样。
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    return v.slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  if (v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1);
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v);
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((s) => parseScalar(s));
  }
  return v;
}

/** 把 YAML 文本解析为 JS 对象（仅支持映射与列表） */
export function parseYaml(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\t/g, '  '))
    .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));

  const root = {};
  // 栈元素：{ indent, container }
  const stack = [{ indent: -1, container: root }];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const indent = line.search(/\S/);
    const content = line.trim();

    // 弹出到合适的父级
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].container;

    if (content.startsWith('- ')) {
      // 列表项
      const rest = content.slice(2).trim();
      if (!Array.isArray(parent)) continue; // 结构异常则跳过
      if (rest.includes(': ') || rest.endsWith(':')) {
        // 列表项是一个映射的开头
        const obj = {};
        parent.push(obj);
        const ci = rest.indexOf(':');
        const k = rest.slice(0, ci).trim();
        const vRaw = rest.slice(ci + 1).trim();
        if (vRaw === '') {
          const child = decideContainer(lines, i, indent);
          obj[k] = child;
          stack.push({ indent, container: obj, key: k });
          stack.push({ indent: indent + 1, container: child });
        } else {
          obj[k] = parseScalar(vRaw);
          stack.push({ indent, container: obj });
        }
      } else {
        parent.push(parseScalar(rest));
      }
    } else {
      // key: value 或 key:
      const ci = content.indexOf(':');
      if (ci === -1) continue;
      const k = content.slice(0, ci).trim();
      const vRaw = content.slice(ci + 1).trim();
      if (!(parent && typeof parent === 'object' && !Array.isArray(parent))) continue;
      if (vRaw === '') {
        const child = decideContainer(lines, i, indent);
        parent[k] = child;
        stack.push({ indent, container: child, key: k });
      } else {
        parent[k] = parseScalar(vRaw);
        stack.push({ indent, container: parent, key: k });
      }
    }
  }
  return root;
}

/** 看下一非空行的缩进，决定当前 key 承载的是列表还是映射 */
function decideContainer(lines, currentIdx, currentIndent) {
  for (let j = currentIdx + 1; j < lines.length; j++) {
    const l = lines[j];
    const ind = l.search(/\S/);
    if (ind <= currentIndent) break;
    return l.trim().startsWith('- ') ? [] : {};
  }
  return {};
}

// ---------------- 对外接口 ----------------

export function loadYamlFile(name) {
  const file = path.join(CONFIG_DIR, name);
  if (!fs.existsSync(file)) return null;
  return parseYaml(fs.readFileSync(file, 'utf8'));
}

/** 读取厂商清单 */
export function loadProviders() {
  const doc = loadYamlFile('providers.yaml');
  if (!doc || !Array.isArray(doc.providers)) {
    console.warn('[config] providers.yaml 未找到或格式异常，返回空清单');
    return [];
  }
  return doc.providers.filter((p) => p && p.slug && p.name_zh);
}

/**
 * 读取模型清单（三层结构的中层：模型实体）。
 *
 * 与 providers.yaml 分开维护的理由：模型与厂商是**多对多**关系
 * （GLM-5.3-Flash 同时出现在智谱官方、OpenCode、Vultr 上），
 * 塞进厂商配置会导致大量重复定义，且改名时容易不同步。
 */
export function loadModels() {
  const doc = loadYamlFile('models.yaml');
  if (!doc || !Array.isArray(doc.models)) return [];
  return doc.models.filter((m) => m && m.slug && m.name);
}

/**
 * 读取端点清单（三层结构的上层：厂商×模型的可领取额度）。
 *
 * 端点是"最小可领取单元"——用户真正关心的不是"某厂商有免费额度"，
 * 而是"我能在哪儿、用哪个模型、免费拿到多少、要不要绑卡"。
 */
export function loadEndpoints() {
  const doc = loadYamlFile('endpoints.yaml');
  if (!doc || !Array.isArray(doc.endpoints)) return [];
  return doc.endpoints.filter((e) => e && e.provider && e.model);
}

/**
 * 读取攻略文章：合并「手写稿」与「自动生成稿」。
 *
 * 分成两个文件是刻意的：
 *   - config/guides.yaml      手写，受版本控制，内容一旦写入就不该被机器覆盖；
 *   - config/guides.auto.yaml pipeline 每日常规生成，会被整体重写。
 * 若两者同写一个文件，自动生成的重写动作会把人工内容一并冲掉（实测最容易踩的坑）。
 *
 * 合并规则：手写优先 —— 同 slug 时手写稿覆盖自动稿。
 * 这样当作者认为某篇自动稿值得手工修订时，只需把该 slug 抄进 guides.yaml 改写，
 * 无需删除自动稿（自动稿下次生成仍会产出，但被手写稿遮蔽）。
 */
export function loadGuides() {
  const handwritten = readGuidesFile('guides.yaml');
  const auto = readGuidesFile('guides.auto.yaml');
  if (!handwritten.length) return auto;
  if (!auto.length) return handwritten;

  const bySlug = new Map();
  for (const g of auto) bySlug.set(g.slug, g);
  for (const g of handwritten) bySlug.set(g.slug, g); // 手写后写，覆盖同 slug 自动稿
  return [...bySlug.values()];
}

/** 读取单个攻略 YAML 文件并做最小校验 */
function readGuidesFile(name) {
  const doc = loadYamlFile(name);
  if (!doc || !Array.isArray(doc.guides)) return [];
  return doc.guides.filter((g) => g && g.slug && g.title);
}

/** 读取提取规则 */
export function loadExtractionRules() {
  const doc = loadYamlFile('extraction-rules.yaml');
  return doc || {};
}

/** 读取运行设置 */
export function loadSettings() {
  const file = path.join(CONFIG_DIR, 'settings.json');
  const defaults = {
    timezone: 'Asia/Shanghai',
    cron: '0 10 * * *',
    fetch: {
      timeoutMs: 20000,
      maxRetries: 4,
      backoffMs: 1000,
      perDomainConcurrency: 1,
      globalConcurrency: 4,
      perDomainDelayMs: 2000,
      userAgent:
        'TokenFreeBot/1.0 (+https://github.com/sanbeitixigua123/token-free; AI 免费活动聚合，仅抓取公开页面)',
      respectRobots: true,
    },
    llm: {
      enabled: false,
      baseUrl: '',
      apiKey: '',
      model: '',
      maxItemsPerSource: 15,
    },
    archive: { afterDays: 30 },
    export: { siteName: 'Token Free', siteUrl: '' },
  };
  if (!fs.existsSync(file)) return applySecrets(defaults);
  const user = JSON.parse(fs.readFileSync(file, 'utf8'));
  return applySecrets(deepMerge(defaults, user));
}

/**
 * 把敏感凭据注入设置对象。
 *
 * 为什么单独拆一个文件：config/settings.json **受版本控制**（用于共享非敏感配置），
 * 若把 API key 写进去，push 后会永久留在公开仓库的提交历史里，事后删除也清不掉。
 * 故凭据一律走 config/secrets.json —— 该文件已在 .gitignore 中忽略。
 *
 * 优先级（后者覆盖前者）：
 *   1) settings.json 里的值（兼容旧写法 / 本地临时覆盖）
 *   2) config/secrets.json
 *   3) 环境变量
 * 环境变量优先级最高，因为 CI（GitHub Actions）只能通过 secrets 注入，
 * 不该把密钥落到 runner 的磁盘文件上。
 */
function applySecrets(settings) {
  const out = { ...settings };

  // 2) 本地密钥文件
  const secretsFile = path.join(CONFIG_DIR, 'secrets.json');
  if (fs.existsSync(secretsFile)) {
    try {
      const sec = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
      out.llm = { ...(out.llm || {}), ...stripComments(sec.llm || {}) };
    } catch (err) {
      console.warn(`[config] secrets.json 解析失败，已忽略：${err.message}`);
    }
  }

  // 3) 环境变量（CI 用）
  const envMap = {
    TOKENFREE_LLM_API_KEY: 'apiKey',
    TOKENFREE_LLM_BASE_URL: 'baseUrl',
    TOKENFREE_LLM_MODEL: 'model',
  };
  out.llm = out.llm || {};
  for (const [envName, field] of Object.entries(envMap)) {
    const v = process.env[envName];
    if (v) out.llm[field] = v;
  }

  return out;
}

/** 去掉 JSON 里以 _ 开头的注释键，避免污染配置 */
function stripComments(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!k.startsWith('_')) out[k] = v;
  }
  return out;
}

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = k in out && typeof out[k] === 'object' && out[k] && !Array.isArray(out[k])
      ? deepMerge(out[k], v)
      : v;
  }
  return out;
}

export { CONFIG_DIR };
