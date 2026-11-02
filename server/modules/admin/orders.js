'use strict';
/** 后台订单管理（契约第 4 章·admin） */
const { getDb } = require('../../db');
const validate = require('../../http/validate');
const { writeAudit } = require('../../utils/audit');
const service = require('../order/service');

function adminOf(ctx) {
  return (ctx.admin && ctx.admin.id) || 'admin';
}

module.exports = {
  mount(router) {
    router.get('/api/admin/orders', { auth: 'admin' }, (ctx) => {
      const db = getDb();
      return service.adminListOrders(db, ctx.query);
    });

    router.get('/api/admin/orders/:orderNo', { auth: 'admin' }, (ctx) => {
      const db = getDb();
      return service.adminGetOrder(db, ctx.params.orderNo);
    });

    /* 强制关单（仅待支付） */
    router.post('/api/admin/orders/:orderNo/close', { auth: 'admin' }, (ctx) => {
      const db = getDb();
      const body = validate.object(ctx.body, {
        reason: { type: 'string', max: 100, label: '关单原因' },
      });
      const detail = service.adminCloseOrder(db, ctx.params.orderNo, body.reason || '后台关单');
      writeAudit(db, {
        actorType: 'admin',
        actorId: adminOf(ctx),
        action: 'order.close',
        targetType: 'order',
        targetId: detail.order.id,
        detail: { orderNo: detail.order.orderNo, reason: body.reason || '后台关单' },
      });
      return detail;
    });

    /* 标记完成（已支付 → 已完成） */
    router.post('/api/admin/orders/:orderNo/complete', { auth: 'admin' }, (ctx) => {
      const db = getDb();
      const detail = service.adminCompleteOrder(db, ctx.params.orderNo);
      writeAudit(db, {
        actorType: 'admin',
        actorId: adminOf(ctx),
        action: 'order.complete',
        targetType: 'order',
        targetId: detail.order.id,
        detail: { orderNo: detail.order.orderNo },
      });
      return detail;
    });
  },
};
