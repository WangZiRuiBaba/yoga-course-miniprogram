'use strict';
/**
 * 退款模块 HTTP 适配（契约第 6 章·用户侧）。
 * 后台审核路由在 admin/refunds.js。
 */
const { getDb } = require('../../db');
const validate = require('../../http/validate');
const service = require('./service');

module.exports = {
  mount(router) {
    /* 申请退款（不传 amountCents = 全额） */
    router.post('/api/orders/:orderNo/refund', { auth: 'user' }, (ctx) => {
      const db = getDb();
      const user = ctx.auth();
      const raw = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
      const body = validate.object(raw, {
        reason: { type: 'string', required: true, min: 1, max: 100, label: '退款原因' },
        reasonType: { type: 'enum', values: service.REASON_TYPES, label: '退款原因类型' },
      });
      return service.createRefund(db, {
        orderNo: ctx.params.orderNo,
        userId: user.id,
        amountCents: raw.amountCents,
        amount: raw.amount,
        reason: body.reason,
        reasonType: body.reasonType,
      });
    });

    /* 我的退款列表 */
    router.get('/api/refunds', { auth: 'user' }, (ctx) => {
      const db = getDb();
      return service.listRefunds(db, ctx.auth().id, ctx.query);
    });

    /* 退款单详情（含进度） */
    router.get('/api/refunds/:refundNo', { auth: 'user' }, (ctx) => {
      const db = getDb();
      return service.getRefund(db, ctx.params.refundNo, ctx.auth().id);
    });
  },
};
