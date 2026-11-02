'use strict';
/** 后台：分销员列表/排行、提现审核、手工调整 */
const validate = require('../../http/validate');
const service = require('../distribution/service');

module.exports = {
  mount(router) {
    /* 分销员列表 / 排行 */
    router.get('/api/admin/dist', { auth: 'admin' }, (ctx) => {
      const paging = validate.paging(ctx.query, { defaultSize: 20 });
      return service.adminDistributors(ctx.db, {
        keyword: String(ctx.query.keyword || '').trim(),
        paging,
      });
    });

    /* 手工调整佣金（写 type='adjust'） */
    router.post('/api/admin/dist/adjust', { auth: 'admin' }, (ctx) => {
      const admin = ctx.adminAuth();
      const data = validate.object(ctx.body, {
        userId: { type: 'string', required: true, min: 1, max: 64, label: '用户' },
        amountCents: { type: 'int', required: true, min: -100000000, max: 100000000, label: '调整金额（分）' },
        note: { type: 'string', required: true, min: 1, max: 200, label: '调整原因' },
      });
      const result = service.adminAdjust(ctx.db, {
        userId: data.userId,
        amountCents: data.amountCents,
        note: data.note,
        adminId: admin.id,
      });
      ctx.log(`手工调整佣金 admin=${admin.id} user=${data.userId} amount=${data.amountCents}`);
      return result;
    });

    /* 提现列表 */
    router.get('/api/admin/withdrawals', { auth: 'admin' }, (ctx) => {
      const paging = validate.paging(ctx.query, { defaultSize: 20 });
      return service.adminWithdrawals(ctx.db, {
        status: String(ctx.query.status || '').trim(),
        paging,
      });
    });

    /* 通过 */
    router.post('/api/admin/withdrawals/:id/approve', { auth: 'admin' }, (ctx) => {
      const admin = ctx.adminAuth();
      const data = validate.object(ctx.body, { note: { type: 'string', max: 200, label: '备注' } });
      const result = service.reviewWithdrawal(ctx.db, ctx.params.id, 'approve', {
        note: data.note || '',
        adminId: admin.id,
      });
      ctx.log(`提现审核通过 admin=${admin.id} id=${ctx.params.id}`);
      return result;
    });

    /* 驳回（退回余额） */
    router.post('/api/admin/withdrawals/:id/reject', { auth: 'admin' }, (ctx) => {
      const admin = ctx.adminAuth();
      const data = validate.object(ctx.body, {
        reason: { type: 'string', required: true, min: 1, max: 200, label: '驳回原因' },
        note: { type: 'string', max: 200, label: '备注' },
      });
      const result = service.reviewWithdrawal(ctx.db, ctx.params.id, 'reject', {
        note: data.reason || data.note || '',
        adminId: admin.id,
      });
      ctx.log(`提现驳回 admin=${admin.id} id=${ctx.params.id}`);
      return result;
    });

    /* 标记已打款 */
    router.post('/api/admin/withdrawals/:id/paid', { auth: 'admin' }, (ctx) => {
      const admin = ctx.adminAuth();
      const data = validate.object(ctx.body, { note: { type: 'string', max: 200, label: '备注' } });
      const result = service.reviewWithdrawal(ctx.db, ctx.params.id, 'paid', {
        note: data.note || '',
        adminId: admin.id,
      });
      ctx.log(`提现打款 admin=${admin.id} id=${ctx.params.id}`);
      return result;
    });
  },
};
