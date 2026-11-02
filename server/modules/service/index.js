'use strict';
/**
 * 在线客服路由（docs/API.md §9）。
 *
 * 只做 HTTP 适配：参数校验 → 调 service.js → 返回 camelCase 数据。
 * AI 自动回复复用 AI 意图引擎（../ai/engine.js），AI 模块未就绪时降级为 welcome 文案。
 */
const validate = require('../../http/validate');
const { errors } = require('../../http/errors');
const { createLimiter } = require('../../http/ratelimit');
const events = require('../../events');
const service = require('./service');

const sendLimiter = createLimiter({ windowMs: 60000, max: 60, label: '发送消息' });
const pollLimiter = createLimiter({ windowMs: 60000, max: 240, label: '刷新消息' });

let eventsBound = false;

/** AI 模块可能还在并行开发：延迟 require + try/catch，缺失即降级 */
function aiEngine() {
  try {
    return require('../ai/engine.js');
  } catch {
    return null;
  }
}

/** 生成客服自动回复文本（无副作用，只读库） */
function autoReplyText(db, user, content) {
  const engine = aiEngine();
  if (!engine || typeof engine.serviceAutoReply !== 'function') {
    return { content: service.welcomeText(db), intent: 'fallback' };
  }
  try {
    const out = engine.serviceAutoReply(db, user, content);
    if (out && out.content) return out;
  } catch (err) {
    console.error('[service] 自动回复生成失败:', err && err.message ? err.message : err);
  }
  return { content: service.welcomeText(db), intent: 'fallback' };
}

function autoReplyEnabled(db) {
  return db.getSetting('service_auto_reply', true) !== false;
}

/* ---------------------------------------------------------------- *
 * order.paid / refund.succeeded → 给用户发一条客服通知（docs §11）
 * 事件在事务提交后触发；handler 自己取库、自己容错、保证幂等。
 * ---------------------------------------------------------------- */
function notifyUser(payload, kind) {
  const { getDb } = require('../../db');
  const db = getDb();
  const user = db.get('SELECT id, nickname FROM users WHERE id = ?', payload && payload.userId);
  if (!user) return;

  const conv = service.ensureConversation(db, user.id);
  const key = kind === 'order_paid' ? 'orderId' : 'refundId';
  const keyValue = payload && (kind === 'order_paid' ? payload.orderId : payload.refundId);
  if (!keyValue) return;
  const dup = db.get(
    `SELECT id FROM messages WHERE conversation_id = ? AND meta LIKE ? LIMIT 1`,
    conv.id,
    `%"${key}":"${keyValue}"%`
  );
  if (dup) return;

  let content = '';
  if (kind === 'order_paid') {
    const titles = Array.isArray(payload.items)
      ? payload.items.map((it) => `《${it.title}》`).join('、')
      : '你的课程';
    content = `支付成功！${titles} 已开通，进入「我的课程」可以看到核销码；上课或预约遇到问题，直接在这里说就行～`;
  } else {
    const amount = Number(payload.amountCents || 0);
    content = `退款已处理完成：¥${(amount / 100).toFixed(2)} 已原路退回${
      payload.fullRefund ? '，课程权益已关闭' : '（部分退款，课程权益保留）'
    }。一般 1-3 个工作日到账。`;
  }

  service.appendMessage(db, {
    conversationId: conv.id,
    senderType: 'system',
    content,
    msgType: 'text',
    meta: {
      type: kind,
      orderId: payload.orderId || null,
      orderNo: payload.orderNo || null,
      refundId: payload.refundId || null,
      refundNo: payload.refundNo || null,
      amountCents: payload.amountCents || 0,
    },
  });
}

function bindEvents() {
  if (eventsBound) return;
  eventsBound = true;
  const safe = (kind) => (payload) => {
    try {
      notifyUser(payload, kind);
    } catch (err) {
      console.error(`[service] ${kind} 通知失败:`, err && err.message ? err.message : err);
    }
  };
  events.on('order.paid', safe('order_paid'));
  events.on('refund.succeeded', safe('refund_succeeded'));
}

module.exports = {
  mount(router) {
    bindEvents();

    /* 取/建当前会话 */
    router.get('/api/service/conversation', { auth: 'user' }, (ctx) => {
      const user = ctx.auth();
      const conv = service.ensureConversation(ctx.db, user.id);
      const rows = service.listMessages(ctx.db, conv.id, 50);
      return {
        conversation: service.publicConversation(conv),
        messages: rows.map(service.publicMessage),
        quickReplies: service.quickReplies(ctx.db),
        welcome: service.welcomeText(ctx.db),
        hasOpenConversation: conv.status === 'open',
      };
    });

    /* 发消息（用户） */
    router.post('/api/service/messages', { auth: 'user' }, (ctx) => {
      const user = ctx.auth();
      sendLimiter(`svc:${user.id}`);
      const data = validate.object(ctx.body, {
        content: { type: 'string', required: true, min: 1, max: service.CONTENT_MAX, label: '消息内容' },
        msgType: { type: 'enum', values: ['text', 'image', 'file'], default: 'text', label: '消息类型' },
      });

      const conv = service.ensureConversation(ctx.db, user.id);
      if (conv.status !== 'open') {
        // 理论上不会发生（ensureConversation 只返回 open），留作并发兜底
        throw errors.invalidState('会话已结束，请刷新后重新进入');
      }
      const row = service.appendMessage(ctx.db, {
        conversationId: conv.id,
        senderType: 'user',
        senderId: user.id,
        content: data.content,
        msgType: data.msgType,
      });

      let autoReply = null;
      if (autoReplyEnabled(ctx.db)) {
        const out = autoReplyText(ctx.db, user, data.content);
        const aiRow = service.appendMessage(ctx.db, {
          conversationId: conv.id,
          senderType: 'ai',
          content: out.content,
          msgType: 'text',
          meta: { intent: out.intent, source: 'service_auto_reply' },
        });
        autoReply = service.publicMessage(aiRow);
      }

      return {
        message: service.publicMessage(row),
        autoReply,
        conversation: service.publicConversation(service.getConversation(ctx.db, conv.id)),
      };
    });

    /* 轮询增量消息（进入即清未读） */
    router.get('/api/service/messages', { auth: 'user' }, (ctx) => {
      const user = ctx.auth();
      pollLimiter(`svcpoll:${user.id}`);
      const after = String(ctx.query.after || '').trim();
      const conv = service.ensureConversation(ctx.db, user.id);
      const rows = service.listMessagesAfter(ctx.db, conv.id, after, 50);
      const updated = service.markRead(ctx.db, conv.id, 'user');
      return {
        conversation: service.publicConversation(updated),
        messages: rows.map(service.publicMessage),
        hasMore: rows.length >= 50,
      };
    });

    /* 结束会话 */
    router.post('/api/service/conversation/close', { auth: 'user' }, (ctx) => {
      const user = ctx.auth();
      const conv = service.ensureConversation(ctx.db, user.id);
      const closed = service.closeConversation(ctx.db, conv.id);
      return { conversation: service.publicConversation(closed), closed: true };
    });

    /* 未读总数（tabbar 红点） */
    router.get('/api/service/unread', { auth: 'user' }, (ctx) => {
      const user = ctx.auth();
      return service.unreadSummary(ctx.db, user.id);
    });
  },
};
