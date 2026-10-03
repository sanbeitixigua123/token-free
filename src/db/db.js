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
    // ⚠️ 顺序很重要：必须先跑"前置迁移"再 applySchema。
    // 原因：schema.sql 里的 v_activities 视图引用了 activities.endpoint_id / model_id，
    // 而**老库**的 activities 表还没有这两列 —— 直接 applySchema 会立刻报
    // `no such column: endpoint_id`（实测踩过）。
    // 因此凡是"新视图依赖老表新列"的情况，都必须先把列补上，再建视图。
    preSchemaMigrations(_singleton);
    applySchema(_singleton);
  }
  return _singleton;
}

/**
 * 建视图之前必须完成的列补齐。
 *
 * 与 migrate.js 里那些迁移的区别：这里只放"schema.sql 会依赖到"的最小改动，
 * 其余业务性迁移仍归 migrate.js。这样任何入口（服务、脚本、定时任务）
 * 打开数据库时都不会因缺列而崩溃，而不必强制先跑一次 migrate。
 */
function preSchemaMigrations(db) {
  const tableExists = (t) =>
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t);

  // 老库缺 models / endpoints 两张表（三层结构引入时新增）。
  // 视图 v_activities 会 LEFT JOIN 它们，缺表同样会报 no such table。
  if (!tableExists('models')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS models (
        id               INTEGER PRIMARY KEY,
        slug             TEXT NOT NULL UNIQUE,
        vendor_slug      TEXT,
        name             TEXT NOT NULL,
        capability       TEXT NOT NULL DEFAULT 'text-generation',
        capabilities     TEXT NOT NULL DEFAULT '[]',
        context_window   INTEGER,
        max_output       INTEGER,
        is_multimodal    INTEGER NOT NULL DEFAULT 0,
        is_open_weights  INTEGER NOT NULL DEFAULT 0,
        description      TEXT,
        homepage_url     TEXT,
        released_at      TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }
  if (!tableExists('endpoints')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS endpoints (
        id                INTEGER PRIMARY KEY,
        provider_id       INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        model_id          INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
        slug              TEXT NOT NULL UNIQUE,
        quota_kind        TEXT,
        quota_rpm         INTEGER,
        quota_rpd         INTEGER,
        quota_tpm         INTEGER,
        quota_amount      REAL,
        quota_unit        TEXT,
        quota_text        TEXT,
        requires_card     INTEGER NOT NULL DEFAULT 0,
        requires_signup   INTEGER NOT NULL DEFAULT 1,
        requires_phone    INTEGER NOT NULL DEFAULT 0,
        cn_accessible     INTEGER NOT NULL DEFAULT 1,
        api_base_url      TEXT,
        openai_compatible INTEGER NOT NULL DEFAULT 1,
        docs_url          TEXT,
        claim_url         TEXT,
        score             REAL,
        score_source      TEXT,
        verified_at       TEXT,
        enabled           INTEGER NOT NULL DEFAULT 1,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(provider_id, model_id)
      );
    `);
  }

  // 老库的 activities 表可能缺 endpoint_id / model_id（三层结构引入时新增）
  if (tableExists('activities')) {
    const cols = db.prepare('PRAGMA table_info(activities)').all().map((c) => c.name);
    if (!cols.includes('endpoint_id')) {
      // 此时 endpoints 表可能还不存在，故不能带 REFERENCES（SQLite 允许省略）
      db.exec('ALTER TABLE activities ADD COLUMN endpoint_id INTEGER;');
    }
    if (!cols.includes('model_id')) {
      db.exec('ALTER TABLE activities ADD COLUMN model_id INTEGER;');
    }
  }
}

/** 北京时间当天 YYYY-MM-DD */
export function beijingToday(offsetDays = 0) {
  const now = new Date(Date.now() + 8 * 3600 * 1000 + offsetDays * 86400 * 1000);
  return now.toISOString().slice(0, 10);
}
