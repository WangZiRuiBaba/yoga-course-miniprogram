'use strict';
/**
 * 权益模块 HTTP 适配（契约第 7 章）。
 * 订阅 order.paid / refund.succeeded，其它模块发事件即可自动发放 / 回收。
 */
const { getDb } = require('../../db');
const service = require('./service');

module.exports = {
  mount(router) {
    /* 事件订阅（幂等注册，重复 mount 不会重复发券） */
    service.subscribe();

    /* 我的课程 */
    router.get('/api/my/entitlements', { auth: 'user' }, (ctx) => {
      const db = getDb();
      return service.listMine(db, ctx.auth().id);
    });

    /* 课程详情 + 上课须知 */
    router.get('/api/my/entitlements/:id', { auth: 'user' }, (ctx) => {
      const db = getDb();
      return service.getMine(db, ctx.params.id, ctx.auth().id);
    });

    /* 后台核销查询 */
    router.get('/api/admin/entitlements', { auth: 'admin' }, (ctx) => {
      const db = getDb();
      return service.adminList(db, ctx.query);
    });

    /* 门店核销（按权益 id，可带 verifyCode 二次校验） */
    router.post('/api/admin/entitlements/:id/use', { auth: 'admin' }, (ctx) => {
      const db = getDb();
      return service.useEntitlement(db, ctx.params.id, {
        verifyCode: ctx.body && ctx.body.verifyCode,
        operatorId: ctx.admin ? ctx.admin.username : 'admin',
      });
    });
  },
};
