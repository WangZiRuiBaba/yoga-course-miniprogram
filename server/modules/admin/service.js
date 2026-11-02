'use strict';
/**
 * 后台在线客服（docs/API.md §9）。
 * 挂在 /api/admin/conversations*：会话列表 → 消息详情（进入即清未读）→ 回复 → 关闭。
 */
const validate = require('../../http/validate');
const { errors } = require('../../http/errors');
const service = require('../service/service');
const { writeAudit } = require('../../utils/audit');
const { nowIso } = require('../../utils/time');

const STATUSES = ['open', 'closed'];

function conversationRow(ctx, id) {
  const row = service.getConversation(ctx.db, id);
  if (!row) throw errors.notFound('会话不存在');
  return row;
}

module.exports = {
  mount(router) {
    /* 会话列表：按最后消息时间倒序 */
    router.get('/api/admin/conversations', { auth: 'admin' }, (ctx) => {
      const paging = validate.paging(ctx.query, { defaultSize: 20 });
      const status = String(ctx.query.status || '').trim();
      if (status && !STATUSES.includes(status)) throw errors.validation(`会话状态只能是 ${STATUSES.join('/')}`);
      const keyword = String(ctx.query.keyword || '').trim();

      const where = [];
      const args = [];
      if (status) {
        where.push('c.status = ?');
        args.push(status);
      }
      if (keyword) {
        where.push('(u.nickname LIKE ? OR u.id LIKE ? OR c.last_msg_preview LIKE ?)');
        const like = `%${keyword}%`;
        args.push(like, like, like);
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const total = Number(ctx.db.pluck(`SELECT COUNT(*) FROM conversations c LEFT JOIN users u ON u.id = c.user_id ${clause}`, ...args) || 0);
      const rows = ctx.db.all(
        `SELECT c.*, u.nickname AS user_nickname, u.avatar AS user_avatar, u.phone AS user_phone
           FROM conversations c
           LEFT JOIN users u ON u.id = c.user_id
           ${clause}
          ORDER BY IFNULL(c.last_msg_at, c.created_at) DESC, c.rowid DESC
          LIMIT ? OFFSET ?`,
        ...args,
        paging.limit,
        paging.offset
      );

      const list = rows.map((row) => ({
        ...service.publicConversation(row),
        userNickname: row.user_nickname || '',
        userAvatar: row.user_avatar || '',
        userPhone: row.user_phone || '',
      }));
      return validate.pageResult(list, total, paging);
    });

    /* 会话详情 + 消息（进入即清未读） */
    router.get('/api/admin/conversations/:id', { auth: 'admin' }, (ctx) => {
      const conv = conversationRow(ctx, ctx.params.id);
      const rows = service.listMessages(ctx.db, conv.id, 100);
      const user = ctx.db.get('SELECT id, nickname, avatar, phone FROM users WHERE id = ?', conv.user_id);
      service.markRead(ctx.db, conv.id, 'admin');
      return {
        conversation: service.publicConversation(service.getConversation(ctx.db, conv.id)),
        user: user ? { id: user.id, nickname: user.nickname || '', avatar: user.avatar || '', phone: user.phone || '' } : null,
        messages: rows.map(service.publicMessage),
      };
    });

    /* 增量拉消息（轮询），?after=<iso> */
    router.get('/api/admin/conversations/:id/messages', { auth: 'admin' }, (ctx) => {
      const conv = conversationRow(ctx, ctx.params.id);
      const after = String(ctx.query.after || '').trim();
      const rows = after
        ? service.listMessagesAfter(ctx.db, conv.id, after, 200)
        : service.listMessages(ctx.db, conv.id, 100);
      service.markRead(ctx.db, conv.id, 'admin');
      return {
        conversation: service.publicConversation(service.getConversation(ctx.db, conv.id)),
        messages: rows.map(service.publicMessage),
      };
    });

    /* 客服回复 */
    router.post('/api/admin/conversations/:id/messages', { auth: 'admin' }, (ctx) => {
      const admin = ctx.adminAuth();
      const conv = conversationRow(ctx, ctx.params.id);
      const data = validate.object(ctx.body, {
        content: { type: 'string', required: true, min: 1, max: service.CONTENT_MAX, label: '回复内容' },
        msgType: { type: 'enum', values: ['text', 'image', 'file'], default: 'text', label: '消息类型' },
      });
      if (conv.status !== 'open') throw errors.invalidState('会话已关闭，无法回复');

      const row = service.appendMessage(ctx.db, {
        conversationId: conv.id,
        senderType: 'admin',
        senderId: admin.id,
        content: data.content,
        msgType: data.msgType,
      });
      if (!conv.assignee_admin_id) {
        ctx.db.run('UPDATE conversations SET assignee_admin_id = ?, updated_at = ? WHERE id = ?', admin.id, nowIso(), conv.id);
      }
      writeAudit(ctx.db, {
        actorType: 'admin',
        actorId: admin.id,
        action: 'conversation.reply',
        targetType: 'conversation',
        targetId: conv.id,
      });
      return {
        message: service.publicMessage(row),
        conversation: service.publicConversation(service.getConversation(ctx.db, conv.id)),
      };
    });

    /* 关闭会话 */
    router.post('/api/admin/conversations/:id/close', { auth: 'admin' }, (ctx) => {
      const admin = ctx.adminAuth();
      const conv = conversationRow(ctx, ctx.params.id);
      if (conv.status !== 'open') return { conversation: service.publicConversation(conv), closed: false };
      const closed = service.closeConversation(ctx.db, conv.id);
      writeAudit(ctx.db, {
        actorType: 'admin',
        actorId: admin.id,
        action: 'conversation.close',
        targetType: 'conversation',
        targetId: conv.id,
      });
      return { conversation: service.publicConversation(closed || service.getConversation(ctx.db, conv.id)), closed: true };
    });

    /* 客服看板：待处理量与在线情况 */
    router.get('/api/admin/service/stats', { auth: 'admin' }, (ctx) => {
      const openCount = Number(ctx.db.pluck("SELECT COUNT(*) FROM conversations WHERE status = 'open'") || 0);
      const closedCount = Number(ctx.db.pluck("SELECT COUNT(*) FROM conversations WHERE status = 'closed'") || 0);
      const unreadConv = Number(
        ctx.db.pluck("SELECT COUNT(*) FROM conversations WHERE status = 'open' AND unread_admin > 0") || 0
      );
      const unreadMessages = Number(
        ctx.db.pluck("SELECT IFNULL(SUM(unread_admin), 0) FROM conversations WHERE status = 'open'") || 0
      );
      const today = new Date().toISOString().slice(0, 10);
      const todayMessages = Number(
        ctx.db.pluck("SELECT COUNT(*) FROM messages WHERE sender_type = 'user' AND created_at >= ?", `${today}T00:00:00.000Z`) || 0
      );
      return { openCount, closedCount, unreadConv, unreadMessages, todayUserMessages: todayMessages };
    });
  },

  /* 供 ai/service.js 或其它子模块复用的常量 */
  STATUSES,
};
