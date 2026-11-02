'use strict';
/**
 * 数据层：node:sqlite 封装 + 全量 schema + 种子数据。
 * 规则（全项目通用）：
 *   1) 金额一律整数「分」，时间一律 ISO-8601 UTC 字符串；
 *   2) 多表写入必须包在 db.tx(fn) 内，tx 回调**必须是同步函数**（不要 await）；
 *   3) 业务模块通过 getDb() 在请求期取实例，不要在顶层 require 期取。
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const config = require('./config');
const { newId, inviteCode } = require('./utils/id');
const { nowIso } = require('./utils/time');
const { hashPassword } = require('./utils/crypto');

/* ------------------------------------------------------------------ *
 * DDL
 * ------------------------------------------------------------------ */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  openid        TEXT UNIQUE,
  unionid       TEXT,
  nickname      TEXT NOT NULL DEFAULT '瑜伽学员',
  avatar        TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'user',
  parent_id     TEXT,
  invite_code   TEXT UNIQUE,
  dist_enabled  INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_users_parent ON users(parent_id);

CREATE TABLE IF NOT EXISTS admin_users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  pass_salt     TEXT NOT NULL,
  pass_hash     TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin',
  last_login_at TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id                   TEXT PRIMARY KEY,
  title                TEXT NOT NULL,
  subtitle             TEXT NOT NULL DEFAULT '',
  cover                TEXT NOT NULL DEFAULT '',
  type                 TEXT NOT NULL DEFAULT 'online',
  goal_tags            TEXT NOT NULL DEFAULT '',
  price_cents          INTEGER NOT NULL DEFAULT 0,
  original_price_cents INTEGER NOT NULL DEFAULT 0,
  stock                INTEGER NOT NULL DEFAULT 999,
  sales                INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'on',
  teacher              TEXT NOT NULL DEFAULT '',
  duration_min         INTEGER NOT NULL DEFAULT 60,
  schedule             TEXT NOT NULL DEFAULT '',
  detail_html          TEXT NOT NULL DEFAULT '',
  sort                 INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_products_status ON products(status, sort);

CREATE TABLE IF NOT EXISTS skus (
  id          TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  spec        TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL,
  stock       INTEGER NOT NULL DEFAULT 999,
  status      TEXT NOT NULL DEFAULT 'on',
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_skus_product ON skus(product_id, sort);

CREATE TABLE IF NOT EXISTS orders (
  id                   TEXT PRIMARY KEY,
  order_no             TEXT NOT NULL UNIQUE,
  user_id              TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'created',
  total_cents          INTEGER NOT NULL DEFAULT 0,
  paid_cents           INTEGER NOT NULL DEFAULT 0,
  refunded_cents       INTEGER NOT NULL DEFAULT 0,
  commission_base_cents INTEGER NOT NULL DEFAULT 0,
  source               TEXT NOT NULL DEFAULT 'miniprogram',
  remark               TEXT NOT NULL DEFAULT '',
  cancel_reason        TEXT NOT NULL DEFAULT '',
  expire_at            TEXT,
  paid_at              TEXT,
  closed_at            TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_orders_user ON orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_orders_status ON orders(status, created_at DESC);

CREATE TABLE IF NOT EXISTS order_items (
  id             TEXT PRIMARY KEY,
  order_id       TEXT NOT NULL,
  product_id     TEXT NOT NULL,
  sku_id         TEXT,
  title          TEXT NOT NULL,
  cover          TEXT NOT NULL DEFAULT '',
  spec           TEXT NOT NULL DEFAULT '',
  price_cents    INTEGER NOT NULL,
  qty            INTEGER NOT NULL,
  subtotal_cents INTEGER NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS entitlements (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  product_id  TEXT NOT NULL,
  order_id    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  verify_code TEXT,
  starts_at   TEXT,
  expires_at  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE(order_id, product_id)
);
CREATE INDEX IF NOT EXISTS ix_ent_user ON entitlements(user_id, status);

CREATE TABLE IF NOT EXISTS payments (
  id             TEXT PRIMARY KEY,
  order_id       TEXT NOT NULL,
  out_trade_no   TEXT NOT NULL UNIQUE,
  provider       TEXT NOT NULL DEFAULT 'mock',
  amount_cents   INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  prepay_id      TEXT,
  transaction_id TEXT,
  pay_params     TEXT,
  raw            TEXT,
  paid_at        TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_pay_order ON payments(order_id);

CREATE TABLE IF NOT EXISTS refunds (
  id                 TEXT PRIMARY KEY,
  refund_no          TEXT NOT NULL UNIQUE,
  order_id           TEXT NOT NULL,
  user_id            TEXT NOT NULL,
  amount_cents       INTEGER NOT NULL,
  reason             TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'pending',
  channel            TEXT NOT NULL DEFAULT 'original',
  provider_refund_id TEXT,
  review_note        TEXT NOT NULL DEFAULT '',
  reviewed_by        TEXT,
  reviewed_at        TEXT,
  refunded_at        TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_refunds_order ON refunds(order_id);
CREATE INDEX IF NOT EXISTS ix_refunds_status ON refunds(status, created_at DESC);

CREATE TABLE IF NOT EXISTS bind_logs (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  inviter_id TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'link',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_bind_user ON bind_logs(user_id);

CREATE TABLE IF NOT EXISTS commission_entries (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  buyer_id     TEXT,
  order_id     TEXT NOT NULL,
  refund_id    TEXT,
  level        INTEGER NOT NULL,
  type         TEXT NOT NULL DEFAULT 'commission',
  amount_cents INTEGER NOT NULL,
  rate_bps     INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'pending',
  available_at TEXT,
  settled_at   TEXT,
  remark       TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_comm_once
  ON commission_entries(order_id, level, type, ifnull(refund_id, ''));
CREATE INDEX IF NOT EXISTS ix_comm_user ON commission_entries(user_id, status);
CREATE INDEX IF NOT EXISTS ix_comm_order ON commission_entries(order_id);

CREATE TABLE IF NOT EXISTS withdrawals (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  channel     TEXT NOT NULL DEFAULT 'wechat',
  account     TEXT NOT NULL DEFAULT '',
  review_note TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT,
  reviewed_at TEXT,
  paid_at     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_wd_user ON withdrawals(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_wd_status ON withdrawals(status, created_at DESC);

CREATE TABLE IF NOT EXISTS conversations (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open',
  assignee_admin_id TEXT,
  topic_order_id    TEXT,
  last_msg_at       TEXT,
  last_msg_preview  TEXT NOT NULL DEFAULT '',
  unread_user       INTEGER NOT NULL DEFAULT 0,
  unread_admin      INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_conv_user_open ON conversations(user_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS ix_conv_last ON conversations(last_msg_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_type     TEXT NOT NULL,
  sender_id       TEXT,
  content         TEXT NOT NULL,
  msg_type        TEXT NOT NULL DEFAULT 'text',
  meta            TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_msg_conv ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS quick_replies (
  id      TEXT PRIMARY KEY,
  title   TEXT NOT NULL,
  content TEXT NOT NULL,
  sort    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ai_sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  provider   TEXT NOT NULL DEFAULT 'rule',
  status     TEXT NOT NULL DEFAULT 'active',
  state      TEXT,
  title      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_ai_sess_user ON ai_sessions(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai_messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  meta       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_ai_msg_sess ON ai_messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS ai_actions (
  id         TEXT PRIMARY KEY,
  session_id TEXT,
  user_id    TEXT,
  tool       TEXT NOT NULL,
  args       TEXT,
  result     TEXT,
  status     TEXT NOT NULL DEFAULT 'ok',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_ai_act_user ON ai_actions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          TEXT PRIMARY KEY,
  actor_type  TEXT NOT NULL,
  actor_id    TEXT,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  detail      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_created ON audit_logs(created_at DESC);
`;

/* ------------------------------------------------------------------ *
 * Db 封装
 * ------------------------------------------------------------------ */
let CURRENT = null;

class Db {
  constructor(file) {
    this.file = file;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.raw.exec('PRAGMA synchronous = NORMAL');
    this._txDepth = 0;
    this._settingCache = new Map();
    this._stmts = new Map();
  }

  exec(sql) {
    return this.raw.exec(sql);
  }

  /** 复用预编译语句（同类 SQL 高频调用时更快） */
  _prepare(sql) {
    let stmt = this._stmts.get(sql);
    if (!stmt) {
      stmt = this.raw.prepare(sql);
      this._stmts.set(sql, stmt);
    }
    return stmt;
  }

  all(sql, ...params) {
    return this._prepare(sql).all(...normalize(params));
  }

  get(sql, ...params) {
    return this._prepare(sql).get(...normalize(params));
  }

  run(sql, ...params) {
    const r = this._prepare(sql).run(...normalize(params));
    return { changes: Number(r.changes || 0), lastInsertRowid: Number(r.lastInsertRowid || 0) };
  }

  /** 取单列单值 */
  pluck(sql, ...params) {
    const row = this.get(sql, ...params);
    if (!row) return undefined;
    const keys = Object.keys(row);
    return keys.length ? row[keys[0]] : undefined;
  }

  /**
   * 同步事务。回调内禁止 await（node:sqlite 是同步驱动）。
   * 嵌套调用自动并入外层事务。
   */
  tx(fn) {
    if (this._txDepth > 0) return fn();
    this._txDepth += 1;
    try {
      this.raw.exec('BEGIN IMMEDIATE');
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    } finally {
      this._txDepth -= 1;
    }
  }

  migrate() {
    this.raw.exec(SCHEMA);
    return this;
  }

  /* ---------------- settings ---------------- */
  getSetting(key, fallback = null) {
    if (this._settingCache.has(key)) return this._settingCache.get(key);
    const row = this.get('SELECT value FROM settings WHERE key = ?', key);
    let value = fallback;
    if (row) {
      try {
        value = JSON.parse(row.value);
      } catch {
        value = row.value;
      }
    }
    this._settingCache.set(key, value);
    return value;
  }

  getSettingNumber(key, fallback = 0) {
    const v = this.getSetting(key, fallback);
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  setSetting(key, value) {
    this.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      JSON.stringify(value),
      nowIso()
    );
    this._settingCache.set(key, value);
    return value;
  }

  allSettings() {
    const rows = this.all('SELECT key, value FROM settings ORDER BY key');
    const out = {};
    for (const r of rows) {
      try {
        out[r.key] = JSON.parse(r.value);
      } catch {
        out[r.key] = r.value;
      }
    }
    return out;
  }

  close() {
    this._stmts.clear();
    try {
      this.raw.close();
    } catch {
      /* ignore */
    }
    if (CURRENT === this) CURRENT = null;
  }
}

/** node:sqlite 不接受 undefined，统一转 null */
function normalize(params) {
  return params.map((p) => (p === undefined ? null : p));
}

function openDb(file = config.dbPath) {
  const db = new Db(file);
  db.migrate();
  CURRENT = db;
  return db;
}

function getDb() {
  if (!CURRENT) throw new Error('数据库未初始化：请先调用 openDb()');
  return CURRENT;
}

function setDb(db) {
  CURRENT = db;
  return db;
}

module.exports = { Db, openDb, getDb, setDb, SCHEMA };
