'use strict';
/**
 * 支付模块 HTTP 适配（契约第 5 章）。
 * 支付成功一律走 service.markPaid()（幂等、事务后发事件）。
 */
const config = require('../../config');
const { getDb } = require('../../db');
const validate = require('../../http/validate');
const { errors } = require('../../http/errors');
const service = require('./service');
const wxpay = require('./wxpay');

/** 微信支付要求回调响应体固定格式 */
function wechatAck(ctx, ok, message) {
  const payload = JSON.stringify({ code: ok ? 'SUCCESS' : 'FAIL', message: message || (ok ? '成功' : '失败') });
  ctx.raw('application/json; charset=utf-8', payload, ok ? 200 : 400);
}

module.exports = {
  mount(router) {
    /* 发起支付 → {payment, payParams, provider, mock} */
    router.post('/api/orders/:orderNo/pay', { auth: 'user' }, async (ctx) => {
      const db = getDb();
      const user = ctx.auth();
      return service.payOrder(db, { orderNo: ctx.params.orderNo, userId: user.id });
    });

    /* 模拟支付回调：前端「我已支付」按钮 & 测试用 */
    router.post('/api/pay/mock-notify', (ctx) => {
      const db = getDb();
      const body = validate.object(ctx.body, {
        outTradeNo: { type: 'string', required: true, max: 64, label: '支付单号' },
        success: { type: 'bool', default: true, label: '支付结果' },
        transactionId: { type: 'string', max: 64, label: '交易号' },
      });
      if (body.success) {
        const result = service.markPaid({
          db,
          outTradeNo: body.outTradeNo,
          transactionId: body.transactionId || `MOCK${Date.now()}`,
          raw: { source: 'mock-notify', at: new Date().toISOString() },
        });
        return {
          outTradeNo: body.outTradeNo,
          status: result.payment.status,
          orderNo: result.order.orderNo,
          orderStatus: result.order.status,
          paidAt: result.payment.paidAt,
          transactionId: result.payment.transactionId,
          idempotent: !!result.idempotent,
          paidCents: result.order.paidCents,
          paidText: result.order.paidText,
        };
      }
      const failed = service.failPayment({ db, outTradeNo: body.outTradeNo, raw: { source: 'mock-notify', success: false } });
      const order = db.get('SELECT * FROM orders WHERE id = ?', failed.payment.orderId);
      return {
        outTradeNo: body.outTradeNo,
        status: failed.payment.status,
        orderNo: order ? order.order_no : '',
        orderStatus: order ? order.status : '',
        paidAt: null,
        transactionId: null,
        idempotent: !failed.changed,
      };
    });

    /* 前端轮询支付状态 */
    router.get('/api/pay/status/:outTradeNo', { auth: 'user' }, (ctx) => {
      const db = getDb();
      return service.getPayStatus(db, ctx.params.outTradeNo, ctx.auth().id);
    });

    /* 微信支付 v3 回调（raw body + 验签） */
    router.post('/api/pay/wxpay/notify', (ctx) => {
      const db = getDb();
      if (config.pay.provider !== 'wxpay') {
        wechatAck(ctx, true, 'mock 模式已忽略该回调');
        return undefined;
      }
      const rawBody = typeof ctx.rawBody === 'string' && ctx.rawBody ? ctx.rawBody : JSON.stringify(ctx.body || {});
      let parsed;
      try {
        parsed = wxpay.parseNotify(ctx.headers, rawBody);
      } catch (err) {
        wechatAck(ctx, false, err && err.message ? err.message : '验签失败');
        return undefined;
      }
      try {
        if (parsed.success) {
          service.markPaid({ db, outTradeNo: parsed.outTradeNo, transactionId: parsed.transactionId, raw: parsed.raw });
        } else {
          service.failPayment({ db, outTradeNo: parsed.outTradeNo, raw: parsed.raw });
        }
      } catch (err) {
        wechatAck(ctx, false, err && err.message ? err.message : '处理失败');
        return undefined;
      }
      wechatAck(ctx, true, '成功');
      return undefined;
    });

    /* 后台支付流水 */
    router.get('/api/admin/payments', { auth: 'admin' }, (ctx) => {
      const db = getDb();
      return service.adminListPayments(db, ctx.query);
    });

    /* 我的支付流水（前端订单列表辅助） */
    router.get('/api/my/payments', { auth: 'user' }, (ctx) => {
      const db = getDb();
      return service.listPaymentsByUser(db, ctx.auth().id, ctx.query);
    });

    /* 支付渠道信息（前端判断是否需要「我已支付」按钮） */
    router.get('/api/pay/config', () => ({
      provider: config.pay.provider,
      mock: config.pay.provider !== 'wxpay',
      mockAutoPay: !!config.pay.mockAutoPay,
      mockMessage: service.MOCK_MESSAGE,
      wxpayConfigured: wxpay.isConfigured(),
    }));
  },
};
