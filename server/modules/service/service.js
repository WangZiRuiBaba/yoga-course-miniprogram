'use strict';
/**
 * 客服服务（docs/API.md §9）。
 *
 * 职责：会话 / 消息 / 未读数 / 快捷话术，以及给 AI 模块复用的跨模块契约：
 *   ensureConversation(db, userId)                 → conversation row
 *   appendMessage(db, {conversationId, senderType, content, msgType, meta}) → message row
 *   publicMessage(row)                             → camelCase
 *   publicConversation(row)                        → camelCase
 *
 * 约束：一个用户同时只能有一条 status='open' 的会话（局部唯一索引 ux_conv_user_open）。
 * 所有函数第一个参数都是 db，可被 node --test 直接调用。
 */
const config = require('../../config');
const { newId } = require('../../utils/id');
const { nowIso } = require('../../utils/time');
const { errors } = require('../../http/errors');

const PREVIEW_MAX = 60;
const CONTENT_MAX = 2000;

/** 未读计数：哪些发送者会点亮「用户未读」 */
function lightsUserUnread(senderType) {
  // ai 自动回复是对当前这条消息的即时响应，用户就在页面上，不计未读
  return senderType === 'admin' || senderType === 'system';
}

function parseMeta(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

/** 会话出参（camelCase） */
function publicConversation(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    assigneeAdminId: row.assignee_admin_id || null,
    topicOrderId: row.topic_order_id || null,
    lastMsgAt: row.last_msg_at || null,
    lastMsgPreview: row.last_msg_preview || '',
    unreadUser: Number(row.unread_user || 0),
    unreadAdmin: Number(row.unread_admin || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 消息出参（camelCase） */
function publicMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderType: row.sender_type,
    senderId: row.sender_id || null,
    content: row.content,
    msgType: row.msg_type || 'text',
    meta: parseMeta(row.meta),
    createdAt: row.created_at,
  };
}

function previewOf(content, msgType) {
  if (msgType && msgType !== 'text') {
    return `[${msgType === 'image' ? '图片' : msgType === 'file' ? '文件' : msgType}]`;
  }
  const text = String(content === null || content === undefined ? '' : content)
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...text];
  return chars.length > PREVIEW_MAX ? `${chars.slice(0, PREVIEW_MAX).join('')}…` : text;
}

function getConversation(db, conversationId) {
  return db.get('SELECT * FROM conversations WHERE id = ?', conversationId) || null;
}

/**
 * 取/建当前 open 会话。
 * 依赖 ux_conv_user_open；并发下若插入撞唯一索引，回读已存在的那条。
 */
function ensureConversation(db, userId) {
  const uid = String(userId || '').trim();
  if (!uid) throw errors.badRequest('缺少用户标识');
  const existing = db.get(
    "SELECT * FROM conversations WHERE user_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1",
    uid
  );
  if (existing) return existing;

  const id = newId('cv_');
  const ts = nowIso();
  try {
    db.run(
      `INSERT INTO conversations
         (id, user_id, status, assignee_admin_id, topic_order_id, last_msg_at, last_msg_preview,
          unread_user, unread_admin, created_at, updated_at)
       VALUES (?, ?, 'open', NULL, NULL, ?, '', 0, 0, ?, ?)`,
      id,
      uid,
      ts,
      ts,
      ts
    );
  } catch (err) {
    const again = db.get(
      "SELECT * FROM conversations WHERE user_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1",
      uid
    );
    if (again) return again;
    throw err;
  }
  return getConversation(db, id);
}

/**
 * 追加一条消息，并同步会话的 last_msg_* / 未读数。
 * @param {{conversationId:string, senderType?:string, senderId?:string|null, content:string, msgType?:string, meta?:object|null}} input
 */
function appendMessage(db, input) {
  const conversationId = String((input && input.conversationId) || '').trim();
  const senderType = String((input && input.senderType) || 'user');
  const msgType = String((input && input.msgType) || 'text');
  const content = String((input && input.content) === undefined || input.content === null ? '' : input.content).trim();

  if (!conversationId) throw errors.validation('缺少会话标识');
  if (!content) throw errors.validation('消息内容不能为空');
  if (content.length > CONTENT_MAX) throw errors.validation(`消息内容最多 ${CONTENT_MAX} 个字符`);

  const conv = getConversation(db, conversationId);
  if (!conv) throw errors.notFound('会话不存在');

  const id = newId('msg_');
  const ts = nowIso();
  const meta = input && input.meta ? JSON.stringify(input.meta) : null;
  const unreadUser = Number(conv.unread_user || 0) + (lightsUserUnread(senderType) ? 1 : 0);
  const unreadAdmin = Number(conv.unread_admin || 0) + (senderType === 'user' ? 1 : 0);

  db.run(
    `INSERT INTO messages (id, conversation_id, sender_type, sender_id, content, msg_type, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    conversationId,
    senderType,
    (input && input.senderId) || null,
    content,
    msgType,
    meta,
    ts
  );
  db.run(
    `UPDATE conversations
        SET last_msg_at = ?, last_msg_preview = ?, unread_user = ?, unread_admin = ?, updated_at = ?
      WHERE id = ?`,
    ts,
    previewOf(content, msgType),
    unreadUser,
    unreadAdmin,
    ts,
    conversationId
  );
  return db.get('SELECT * FROM messages WHERE id = ?', id);
}

/** 会话消息（正序） */
function listMessages(db, conversationId, limit = 50) {
  return db.all(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?',
    conversationId,
    Math.max(1, Math.min(200, Number(limit) || 50))
  );
}

/**
 * 增量拉取：after 之后的消息。
 * created_at 精度是毫秒，同一毫秒可能有多条，因此用 rowid 做锚点，避免漏消息。
 */
function listMessagesAfter(db, conversationId, afterIso, limit = 50) {
  const size = Math.max(1, Math.min(200, Number(limit) || 50));
  if (!afterIso) return listMessages(db, conversationId, size);
  const anchor = db.get(
    'SELECT MAX(rowid) AS rid FROM messages WHERE conversation_id = ? AND created_at <= ?',
    conversationId,
    String(afterIso)
  );
  const base = anchor && anchor.rid ? Number(anchor.rid) : 0;
  return db.all(
    'SELECT * FROM messages WHERE conversation_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?',
    conversationId,
    base,
    size
  );
}

/** 清未读：who = 'user' | 'admin' */
function markRead(db, conversationId, who) {
  const field = who === 'admin' ? 'unread_admin' : 'unread_user';
  db.run(`UPDATE conversations SET ${field} = 0, updated_at = ? WHERE id = ?`, nowIso(), conversationId);
  return getConversation(db, conversationId);
}

function closeConversation(db, conversationId) {
  const conv = getConversation(db, conversationId);
  if (!conv) throw errors.notFound('会话不存在');
  if (conv.status === 'closed') return conv;
  db.run(
    "UPDATE conversations SET status = 'closed', updated_at = ? WHERE id = ?",
    nowIso(),
    conversationId
  );
  return getConversation(db, conversationId);
}

function quickReplies(db) {
  return db.all('SELECT id, title, content, sort FROM quick_replies ORDER BY sort ASC, id ASC');
}

function welcomeText(db) {
  const value = db.getSetting('service_welcome', config.bizDefaults.service_welcome);
  return typeof value === 'string' && value.trim() ? value : config.bizDefaults.service_welcome;
}

/** 用户未读总数（open 会话），供小程序 tabbar 红点 */
function unreadSummary(db, userId) {
  const row = db.get(
    "SELECT IFNULL(SUM(unread_user), 0) AS n FROM conversations WHERE user_id = ? AND status = 'open'",
    userId
  );
  return { unreadUser: Number((row && row.n) || 0) };
}

module.exports = {
  PREVIEW_MAX,
  CONTENT_MAX,
  publicConversation,
  publicMessage,
  parseMeta,
  previewOf,
  getConversation,
  ensureConversation,
  appendMessage,
  listMessages,
  listMessagesAfter,
  markRead,
  closeConversation,
  quickReplies,
  welcomeText,
  unreadSummary,
};
