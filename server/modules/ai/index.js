'use strict';
/**
 * AI 商城 HTTP 适配层（docs/API.md §10）。
 * 只做参数校验 + 鉴权 + 出参组装，业务逻辑在 ./service.js。
 */
const validate = require('../../http/validate');
const { createLimiter } = require('../../http/ratelimit');
const aiSvc = require('./service');
const actionsMod = require('./actions');

const chatLimiter = createLimiter({ windowMs: 60000, max: 30, label: 'AI 对话' });
const actionLimiter = createLimiter({ windowMs: 60000, max: 60, label: 'AI 操作' });

function mount(router) {
  // 打开（或复用）AI 会话
  router.post('/api/ai/session', { auth: 'user' }, async (ctx) => {
    const { getDb } = require('../../db');
    const db = ctx.db || getDb();
    return aiSvc.openSession(db, ctx.auth());
  });

  // 会话详情 + 最近消息
  router.get('/api/ai/session/:id', { auth: 'user' }, async (ctx) => {
    const { getDb } = require('../../db');
    const db = ctx.db || getDb();
    return aiSvc.getSession(db, ctx.auth(), ctx.params.id);
  });

  // 对话
  router.post('/api/ai/chat', { auth: 'user' }, async (ctx) => {
    const { getDb } = require('../../db');
    const db = ctx.db || getDb();
    const user = ctx.auth();
    chatLimiter(`ai:${user.id}`);
    const input = validate.object(ctx.body, {
      sessionId: { type: 'string', trim: true },
      text: { type: 'string', required: true, label: '消息内容' },
    });
    return aiSvc.chat(db, user, input);
  });

  // 动作按钮（create_order / pay_order / mock_pay / refund_order / open_* / bind_invite）
  router.post('/api/ai/action', { auth: 'user' }, async (ctx) => {
    const { getDb } = require('../../db');
    const db = ctx.db || getDb();
    const user = ctx.auth();
    actionLimiter(`aiact:${user.id}`);
    const input = validate.object(ctx.body, {
      sessionId: { type: 'string', trim: true },
      action: { type: 'enum', required: true, values: actionsMod.ACTIONS, label: '动作' },
    });
    // payload 是任意对象，不进 schema（allowUnknown 默认放行），这里自行归一化
    const rawPayload = ctx.body && ctx.body.payload;
    const payload = rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload) ? rawPayload : {};
    return aiSvc.runAction(db, user, { sessionId: input.sessionId, action: input.action, payload });
  });

  // 推荐问题
  router.get('/api/ai/suggestions', { auth: 'user' }, async () => aiSvc.suggestions());

  // 后台：AI 动作审计
  router.get('/api/admin/ai/logs', { auth: 'admin' }, async (ctx) => {
    const { getDb } = require('../../db');
    const db = ctx.db || getDb();
    const paging = validate.paging(ctx.query);
    return aiSvc.adminLogs(db, {
      page: paging.page,
      size: paging.size,
      sessionId: ctx.query.sessionId,
      tool: ctx.query.tool,
      status: ctx.query.status,
      userId: ctx.query.userId,
    });
  });
}

module.exports = { mount };
