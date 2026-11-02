'use strict';
/**
 * 订单模块 HTTP 适配（契约第 4 章）。
 * 同时注册超时关单定时任务 'order:expire'（每 60 秒）。
 */
const { getDb } = require('../../db');
const validate = require('../../http/validate');
const sweep = require('../../sweep');
const service = require('./service');

let registered = false;

module.exports = {
  mount(router) {
    if (!registered) {
      registered = true;
      sweep.register('order:expire', 60, () => service.expireOrders(getDb()));
    }

    /* 下单 */
    router.post('/api/orders', { auth: 'user' }, (ctx) => {
      const db = getDb();
      const user = ctx.auth();
      return service.createOrder(db, { ...ctx.body, userId: user.id });
    });

    /* 我的订单 */
    router.get('/api/orders', { auth: 'user' }, (ctx) => {
      const db = getDb();
      return service.listOrders(db, ctx.auth().id, ctx.query);
    });

    /* 订单详情 */
    router.get('/api/orders/:orderNo', { auth: 'user' }, (ctx) => {
      const db = getDb();
      return service.getOrderDetail(db, ctx.params.orderNo, ctx.auth().id);
    });

    /* 取消订单 */
    router.post('/api/orders/:orderNo/cancel', { auth: 'user' }, (ctx) => {
      const db = getDb();
      const { reason } = validate.object(ctx.body, {
        reason: { type: 'string', max: 100, label: '取消原因' },
      });
      return service.cancelOrder(db, ctx.params.orderNo, ctx.auth().id, reason || '用户取消');
    });

    /* 确认完成（核销/上课结束） */
    router.post('/api/orders/:orderNo/confirm', { auth: 'user' }, (ctx) => {
      const db = getDb();
      return service.confirmOrder(db, ctx.params.orderNo, ctx.auth().id);
    });
  },
};
