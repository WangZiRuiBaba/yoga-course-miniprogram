'use strict';
/**
 * 二级分销 / 佣金 / 提现 —— HTTP 适配层（业务逻辑在 service.js）。
 * 端点见 docs/API.md 第 8 章。
 */
const validate = require('../../http/validate');
const sweep = require('../../sweep');
const events = require('../../events');
const service = require('./service');

/** 事件只订阅一次（多个 createApp 实例/热重载不会重复发钱） */
let subscribed = false;

function subscribeEvents() {
  if (subscribed) return;
  subscribed = true;
  events.on('order.paid', (payload) => service.handleOrderPaid(payload));
  events.on('refund.succeeded', (payload) => service.handleRefundSucceeded(payload));
}

module.exports = {
  service,

  mount(router) {
    const { getDb } = require('../../db');
    service.ensureSchema(getDb());
    subscribeEvents();
    sweep.register('dist:unfreeze', 60, () => service.unfreezeTick());

    /* 概览 */
    router.get('/api/dist/overview', { auth: 'user' }, (ctx) => {
      const user = ctx.auth();
      return service.overview(ctx.db, user.id);
    });

    /* 绑定上级（只能用一次） */
    router.post('/api/dist/bind', { auth: 'user' }, (ctx) => {
      const user = ctx.auth();
      const data = validate.object(ctx.body, {
        inviteCode: { type: 'string', required: true, min: 1, max: 32, label: '邀请码' },
        source: { type: 'string', max: 32, label: '来源' },
      });
      const result = service.bindInviter(ctx.db, {
        userId: user.id,
        inviteCode: data.inviteCode,
        source: data.source || 'link',
      });
      ctx.log(`分销绑定 user=${user.id} parent=${result.parentId}`);
      return result;
    });

    /* 开通分销 */
    router.post('/api/dist/enable', { auth: 'user' }, (ctx) => {
      const user = ctx.auth();
      return service.enableDist(ctx.db, user.id);
    });

    /* 我的邀请码 / 邀请链接 */
    router.get('/api/dist/invite', { auth: 'user' }, (ctx) => {
      const user = ctx.auth();
      return service.inviteInfo(ctx.db, user.id);
    });

    /* 团队：level=1 直属，level=2 二级 */
    router.get('/api/dist/team', { auth: 'user' }, (ctx) => {
      const user = ctx.auth();
      const { level } = validate.object(ctx.query, {
        level: { type: 'enum', values: ['1', '2'], default: '1', label: '层级' },
      });
      const paging = validate.paging(ctx.query, { defaultSize: 20 });
      return service.team(ctx.db, user.id, Number(level) === 2 ? 2 : 1, paging);
    });

    /* 佣金流水 */
    router.get('/api/dist/commissions', { auth: 'user' }, (ctx) => {
      const user = ctx.auth();
      const { status } = validate.object(ctx.query, {
        status: {
          type: 'enum',
          values: ['pending', 'available', 'cancelled', 'reversed'],
          label: '状态',
        },
      });
      const paging = validate.paging(ctx.query, { defaultSize: 20 });
      return service.listCommissions(ctx.db, user.id, { status, paging });
    });

    /* 提现记录 */
    router.get('/api/dist/withdrawals', { auth: 'user' }, (ctx) => {
      const user = ctx.auth();
      const paging = validate.paging(ctx.query, { defaultSize: 20 });
      return service.listWithdrawals(ctx.db, user.id, paging);
    });

    /* 申请提现 */
    router.post('/api/dist/withdrawals', { auth: 'user' }, (ctx) => {
      const user = ctx.auth();
      const data = validate.object(ctx.body, {
        amountCents: { type: 'int', required: true, min: 1, max: 100000000, label: '提现金额（分）' },
        channel: { type: 'enum', values: ['wechat', 'alipay', 'bank'], default: 'wechat', label: '提现渠道' },
        account: { type: 'string', max: 64, label: '收款账号' },
      });
      const result = service.createWithdrawal(ctx.db, user.id, {
        amountCents: data.amountCents,
        channel: data.channel,
        account: data.account || '',
      });
      ctx.log(`提现申请 user=${user.id} amount=${data.amountCents}`);
      return result;
    });
  },
};
