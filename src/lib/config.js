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
  // 去引号
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
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
