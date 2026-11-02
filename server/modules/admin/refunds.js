'use strict';
/** 后台退款审核（契约第 6 章·admin） */
const { getDb } = require('../../db');
const validate = require('../../http/validate');
const { writeAudit } = require('../../utils/audit');
const service = require('../refund/service');

function adminOf(ctx) {
  return (ctx.admin && ctx.admin.id) || 'admin';
}

module.exports = {
  mount(router) {
    /* 退款单列表（含各状态计数） */
    router.get('/api/admin/refunds', { auth: 'admin' }, (ctx) => {
      const db = getDb();
      return service.adminListRefunds(db, ctx.query);
    });

    /* 退款单详情 */
    router.get('/api/admin/refunds/:refundNo', { auth: 'admin' }, (ctx) => {
      const db = getDb();
      return service.getRefund(db, ctx.params.refundNo);
    });

    /* 通过并出款（mock 立即成功） */
    router.post('/api/admin/refunds/:refundNo/approve', { auth: 'admin' }, (ctx) => {
      const db = getDb();
      const body = validate.object(ctx.body || {}, {
        note: { type: 'string', max: 200, label: '审核备注' },
      });
      const result = service.approveRefund(db, ctx.params.refundNo, {
        note: body.note,
        adminId: adminOf(ctx),
      });
      writeAudit(db, {
        actorType: 'admin',
        actorId: adminOf(ctx),
        action: 'refund.approve',
        targetType: 'refund',
        targetId: result.refund ? result.refund.id : null,
        detail: { refundNo: ctx.params.refundNo, amountCents: result.refund ? result.refund.amountCents : 0 },
      });
      return { ...result, message: '退款已通过并出款' };
    });

    /* 驳回 */
    router.post('/api/admin/refunds/:refundNo/reject', { auth: 'admin' }, (ctx) => {
      const db = getDb();
      const body = validate.object(ctx.body || {}, {
        reason: { type: 'string', required: true, min: 1, max: 200, label: '驳回原因' },
      });
      const result = service.rejectRefund(db, ctx.params.refundNo, {
        reason: body.reason,
        adminId: adminOf(ctx),
      });
      writeAudit(db, {
        actorType: 'admin',
        actorId: adminOf(ctx),
        action: 'refund.reject',
        targetType: 'refund',
        targetId: result.refund ? result.refund.id : null,
        detail: { refundNo: ctx.params.refundNo, reason: body.reason },
      });
      return result;
    });
  },
};
