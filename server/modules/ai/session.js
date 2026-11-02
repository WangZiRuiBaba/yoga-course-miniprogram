'use strict';
/**
 * AI 会话存储（docs/API.md §10）：ai_sessions / ai_messages / ai_actions。
 * 一个用户复用一个 status='active' 的会话；state 存在 ai_sessions.state（JSON）。
 */
const { newId } = require('../../utils/id');
const { nowIso } = require('../../utils/time');

const STATE_DEFAULTS = () => ({
  intent: null,
  stage: 'idle',
  lastProductId: null,
  lastOrderNo: null,
  lastOutTradeNo: null,
  lastRefundNo: null,
  goal: null,
  pendingConfirm: null,
});

function parseJson(raw, fallback) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  if (typeof raw === 'object') return raw;
  try {
    const value = JSON.parse(String(raw));
    return value === null || value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

function parseState(row) {
  const base = STATE_DEFAULTS();
  const stored = parseJson(row && row.state, null);
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return base;
  return Object.assign(base, stored);
}

/** ai_messages 出参 → 前端消息体 */
function publicAiMessage(row) {
  if (!row) return null;
  const meta = parseJson(row.meta, {}) || {};
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    cards: Array.isArray(meta.cards) ? meta.cards : [],
    actions: Array.isArray(meta.actions) ? meta.actions : [],
    intent: meta.intent || null,
    provider: meta.provider || null,
    action: meta.action || null,
    createdAt: row.created_at,
  };
}

function getActiveSession(db, userId) {
  return (
    db.get(
      "SELECT * FROM ai_sessions WHERE user_id = ? AND status = 'active' ORDER BY updated_at DESC, rowid DESC LIMIT 1",
      userId
    ) || null
  );
}

function createSession(db, userId, provider = 'rule') {
  const id = newId('as_');
  const ts = nowIso();
  db.run(
    `INSERT INTO ai_sessions (id, user_id, provider, status, state, title, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, '', ?, ?)`,
    id,
    userId,
    provider,
    JSON.stringify(STATE_DEFAULTS()),
    ts,
    ts
  );
  return db.get('SELECT * FROM ai_sessions WHERE id = ?', id);
}

/** 取/建：同一条 active 会话反复复用 */
function getOrCreateSession(db, user, provider = 'rule') {
  return getActiveSession(db, user.id) || createSession(db, user.id, provider);
}

/** 归属校验：别人的会话一律按不存在处理 */
function getSessionForUser(db, sessionId, userId) {
  const row = db.get('SELECT * FROM ai_sessions WHERE id = ?', sessionId);
  if (!row) return null;
  if (row.user_id !== userId) return null;
  return row;
}

function saveState(db, sessionId, state, extra = {}) {
  const row = db.get('SELECT * FROM ai_sessions WHERE id = ?', sessionId);
  if (!row) return null;
  const provider = extra.provider || row.provider || 'rule';
  const title = extra.title || row.title || '';
  db.run(
    'UPDATE ai_sessions SET state = ?, provider = ?, title = ?, updated_at = ? WHERE id = ?',
    JSON.stringify(state || STATE_DEFAULTS()),
    provider,
    title,
    nowIso(),
    sessionId
  );
  return db.get('SELECT * FROM ai_sessions WHERE id = ?', sessionId);
}

function appendAiMessage(db, { sessionId, role, content, meta = null }) {
  const id = newId('aim_');
  const ts = nowIso();
  db.run(
    'INSERT INTO ai_messages (id, session_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    sessionId,
    String(role || 'assistant'),
    String(content === null || content === undefined ? '' : content),
    meta ? JSON.stringify(meta) : null,
    ts
  );
  return db.get('SELECT * FROM ai_messages WHERE id = ?', id);
}

function listAiMessages(db, sessionId, limit = 50) {
  const rows = db.all(
    'SELECT * FROM ai_messages WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
    sessionId,
    Math.max(1, Math.min(200, Number(limit) || 50))
  );
  return rows.reverse().map(publicAiMessage);
}

function recentMessages(db, sessionId, limit = 8) {
  return listAiMessages(db, sessionId, limit);
}

/** 动作审计 */
function logAction(db, { sessionId, userId, tool, args, result, status }) {
  const id = newId('act_');
  const ts = nowIso();
  db.run(
    `INSERT INTO ai_actions (id, session_id, user_id, tool, args, result, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    sessionId || null,
    userId || null,
    String(tool || 'unknown'),
    args === undefined || args === null ? null : JSON.stringify(args),
    result === undefined || result === null ? null : JSON.stringify(result),
    String(status || 'ok'),
    ts
  );
  return id;
}

function logTools(db, { sessionId, userId, tools }) {
  const list = Array.isArray(tools) ? tools : [];
  for (const item of list) {
    logAction(db, {
      sessionId,
      userId,
      tool: item.tool,
      args: item.args,
      result: item.result,
      status: item.status,
    });
  }
  return list.length;
}

module.exports = {
  STATE_DEFAULTS,
  parseJson,
  parseState,
  publicAiMessage,
  getActiveSession,
  createSession,
  getOrCreateSession,
  getSessionForUser,
  saveState,
  appendAiMessage,
  listAiMessages,
  recentMessages,
  logAction,
  logTools,
};
