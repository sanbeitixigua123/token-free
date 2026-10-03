/**
 * db.js — SQLite 访问层封装
 *
 * 驱动选择：
 *   默认使用 Node 内置 node:sqlite（零 native 编译，规避 Windows 编译风险）。
 *   若需换 better-sqlite3（API 与本封装完全兼容），设置环境变量：
 *     TOKENFREE_DB_DRIVER=better-sqlite3
 *
 * 两者 API 差异已被本层抹平，业务代码无需改动。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const DRIVER = process.env.TOKENFREE_DB_DRIVER || 'node:sqlite';

let DatabaseCtor;
if (DRIVER === 'better-sqlite3') {
  ({ default: DatabaseCtor } = await import('better-sqlite3'));
} else {
  ({ DatabaseSync: DatabaseCtor } = await import('node:sqlite'));
}

/** 打开一个数据库连接 */
export function openDatabase(dbPath = null) {
  const file = dbPath || process.env.TOKENFREE_DB || path.join(PROJECT_ROOT, 'data', 'tokenfree.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseCtor(file);
  // node:sqlite 与 better-sqlite3 都支持 exec
  db.exec('PRAGMA foreign_keys = ON;');
  try {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
  } catch { /* 内存库或只读场景忽略 */ }
  return db;
}

/** 执行 DDL（建表建视图） */
export function applySchema(db, schemaPath = null) {
  const file = schemaPath || path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(file, 'utf8');
  db.exec(sql);
}

// ---------------- 轻量查询助手（抹平两种驱动的差异） ----------------

export function all(db, sql, params = []) {
  const stmt = db.prepare(sql);
  return stmt.all(...normalizeParams(params));
}

export function get(db, sql, params = []) {
  const stmt = db.prepare(sql);
  return stmt.get(...normalizeParams(params));
}

export function run(db, sql, params = []) {
  const stmt = db.prepare(sql);
  const res = stmt.run(...normalizeParams(params));
  // node:sqlite 返回 { changes, lastInsertRowid }；better-sqlite3 相同
  return {
    changes: Number(res.changes ?? 0),
    lastInsertRowid: Number(res.lastInsertRowid ?? 0),
  };
}

export function exec(db, sql) {
  db.exec(sql);
}

/**
 * node:sqlite 只接受 null/number/bigint/string/Uint8Array，
 * bool 与 undefined 需要转换，否则抛类型错误。
 */
function normalizeParams(params) {
  if (!Array.isArray(params)) params = [params];
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p !== null && typeof p === 'object' && !(p instanceof Uint8Array)) {
      // 数组/对象统一存 JSON 字符串（audience / filters 等字段）
      return JSON.stringify(p);
    }
    return p;
  });
}

/** 事务包装 */
export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

/** 单例（服务进程内复用同一连接） */
let _singleton = null;
export function getDb() {
  if (!_singleton) {
    _singleton = openDatabase();
    applySchema(_singleton);
  }
  return _singleton;
}

/** 北京时间当天 YYYY-MM-DD */
export function beijingToday(offsetDays = 0) {
  const now = new Date(Date.now() + 8 * 3600 * 1000 + offsetDays * 86400 * 1000);
  return now.toISOString().slice(0, 10);
}
