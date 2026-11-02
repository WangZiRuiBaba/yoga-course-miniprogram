'use strict';
/**
 * 支付服务（契约第 5 章）。
 * 统一入口：markPaid({outTradeNo, transactionId, raw}) —— 幂等，事务提交后 emit('order.paid')。
 * provider = mock（默认，即刻成功）| wxpay（v3，见 ./wxpay.js）。
 */
const config = require('../../config');
const validate = require('../../http/validate');
const { errors } = require('../../http/errors');
const { getDb } = require('../../db');
const { newId, outTradeNo: genOutTradeNo } = require('../../utils/id');
const { nowIso } = require('../../utils/time');
const { fmtYuan, centsToYuanString } = require('../../utils/money');
const events = require('../../events');
const orderService = require('../order/service');
const wxpay = require('./wxpay');

const PAY_STATUS_TEXT = {
  pending: '待支付',
  succeeded: '支付成功',
  failed: '支付失败',
  closed: '已关闭',
};

/** 已付/已退的订单状态（重复回调直接幂等返回） */
const PAID_ORDER_STATUSES = ['paid', 'completed', 'refunding', 'refunded', 'partial_refunded'];

const MOCK_MESSAGE = '模拟支付：点击「我已支付」即成功';

function publicPayment(row) {
  if (!row) return null;
  return {
    id: row.id,
    orderId: row.order_id,
    outTradeNo: row.out_trade_no,
    provider: row.provider,
    amountCents: Number(row.amount_cents || 0),
    amountText: centsToYuanString(row.amount_cents),
    amountLabel: fmtYuan(row.amount_cents),
    status: row.status,
    statusText: PAY_STATUS_TEXT[row.status] || String(row.status || ''),
    prepayId: row.prepay_id || null,
    transactionId: row.transaction_id || null,
    paidAt: row.paid_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function nextOutTradeNo(db) {
  for (let i = 0; i < 8; i++) {
    const candidate = genOutTradeNo();
    if (!db.get('SELECT 1 AS x FROM payments WHERE out_trade_no = ?', candidate)) return candidate;
  }
  throw errors.internal('支付单号生成失败，请重试');
}

function jsonOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/** 取订单并校验归属 */
function resolveOrder(db, orderNoValue, userId) {
  const order = orderService.findOrder(db, orderNoValue);
  if (userId && order.user_id !== userId) throw errors.forbidden('无权操作该订单');
  return order;
}

/* ------------------------------------------------------------------ *
 * 发起支付
 * ------------------------------------------------------------------ */
function payOrder(db, input = {}) {
  const data = validate.object(input, {
    orderNo: { type: 'string', required: true, max: 64, label: '订单号' },
    userId: { type: 'string', max: 64, label: '用户' },
  });
  const order = resolveOrder(db, data.orderNo, data.userId);

  if (order.status !== 'pending') {
    if (PAID_ORDER_STATUSES.includes(order.status)) throw errors.invalidState('订单已支付，请勿重复支付');
    if (order.status === 'cancelled') throw errors.invalidState('订单已关闭，请重新下单');
    throw errors.invalidState('当前订单状态不可支付');
  }
  if (order.expire_at && new Date(order.expire_at).getTime() <= Date.now()) {
    throw errors.invalidState('订单已超时，请重新下单');
  }

  const provider = config.pay.provider === 'wxpay' ? 'wxpay' : 'mock';

  /* 重复发起：复用同一条 pending 支付（同一个 outTradeNo） */
  let payment = db.get(
    "SELECT * FROM payments WHERE order_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
    order.id
  );
  if (!payment) {
    const id = newId('pay_');
    const no = nextOutTradeNo(db);
    const ts = nowIso();
    db.run(
      `INSERT INTO payments (id, order_id, out_trade_no, provider, amount_cents, status, prepay_id,
         transaction_id, pay_params, raw, paid_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      id,
      order.id,
      no,
      provider,
      Number(order.total_cents || 0),
      ts,
      ts
    );
    payment = db.get('SELECT * FROM payments WHERE id = ?', id);
  }

  const build = (payParams, prepayId) => {
    const ts = nowIso();
    db.run(
      'UPDATE payments SET provider = ?, prepay_id = ?, pay_params = ?, updated_at = ? WHERE id = ?',
      provider,
      prepayId || null,
      jsonOrNull(payParams),
      ts,
      payment.id
    );
    scheduleAutoPay(db, payment.out_trade_no);
    return {
      payment: publicPayment(db.get('SELECT * FROM payments WHERE id = ?', payment.id)),
      payParams,
      provider,
      mock: provider === 'mock',
    };
  };

  if (provider === 'mock') {
    return build({ provider: 'mock', outTradeNo: payment.out_trade_no, mock: true, message: MOCK_MESSAGE }, null);
  }

  const user = db.get('SELECT id, openid FROM users WHERE id = ?', order.user_id);
  return wxpay
    .createPayParams({
      outTradeNo: payment.out_trade_no,
      amountCents: Number(payment.amount_cents || 0),
      description: `瑜伽课程 ${order.order_no}`,
      openid: user ? user.openid : undefined,
    })
    .then((params) => build(params, params.prepayId));
}

/** mockAutoPay：发起后 mockPayDelayMs 自动成功（定时器不阻塞进程） */
function scheduleAutoPay(db, outTradeNoValue) {
  if (config.pay.provider !== 'mock' || !config.pay.mockAutoPay) return;
  const delay = Math.max(0, Number(config.pay.mockPayDelayMs || 200));
  const timer = setTimeout(() => {
    try {
      markPaid({ db, outTradeNo: outTradeNoValue, transactionId: `MOCK${Date.now()}` });
    } catch (err) {
      if (!config.isProd) console.warn('[pay] 自动支付跳过:', err && err.message ? err.message : err);
    }
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();
}

/* ------------------------------------------------------------------ *
 * 统一支付成功入口（幂等）
 * ------------------------------------------------------------------ */
function markPaid(input = {}) {
  const db = input.db || getDb();
  const no = String(input.outTradeNo == null ? '' : input.outTradeNo).trim();
  if (!no) throw errors.badRequest('缺少支付单号 outTradeNo');

  const payment = db.get('SELECT * FROM payments WHERE out_trade_no = ?', no);
  if (!payment) throw errors.notFound('支付单不存在');
  const order = db.get('SELECT * FROM orders WHERE id = ?', payment.order_id);
  if (!order) throw errors.notFound('订单不存在');

  /* 1) 已经成功过：直接幂等返回，不再发事件 */
  if (payment.status === 'succeeded') {
    return {
      payment: publicPayment(payment),
      order: orderService.publicOrder(order),
      idempotent: true,
      payload: null,
      alreadyPaid: true,
    };
  }

  if (order.status === 'cancelled') {
    const ts = nowIso();
    db.run("UPDATE payments SET status = 'closed', updated_at = ? WHERE id = ?", ts, payment.id);
    throw errors.invalidState('订单已关闭，无法支付');
  }

  const ts = nowIso();
  const transactionId = String(input.transactionId || `MOCK${Date.now()}`);
  const rawJson = jsonOrNull(input.raw);
  const items = db.all('SELECT * FROM order_items WHERE order_id = ?', order.id);
  const alreadyPaidOrder = PAID_ORDER_STATUSES.includes(order.status);
  let payload = null;

  db.tx(() => {
    db.run(
      `UPDATE payments SET status = 'succeeded', transaction_id = ?, paid_at = ?, raw = COALESCE(?, raw), updated_at = ?
       WHERE id = ?`,
      transactionId,
      alreadyPaidOrder && order.paid_at ? order.paid_at : ts,
      rawJson,
      ts,
      payment.id
    );
    if (alreadyPaidOrder) return; /* 订单已经付过：只补齐支付单，不重复加销量、不重复发事件 */

    const paidAt = ts;
    const paidCents = Number(payment.amount_cents || order.total_cents || 0);
    db.run(
      `UPDATE orders
          SET status = 'paid', paid_cents = ?, paid_at = ?, updated_at = ?,
              commission_base_cents = CASE WHEN commission_base_cents > 0 THEN commission_base_cents ELSE ? END
        WHERE id = ? AND status = 'pending'`,
      paidCents,
      paidAt,
      paidAt,
      paidCents,
      order.id
    );
    for (const it of items) {
      db.run('UPDATE products SET sales = sales + ? WHERE id = ?', Number(it.qty || 0), it.product_id);
    }
    payload = {
      orderId: order.id,
      orderNo: order.order_no,
      userId: order.user_id,
      paidCents,
      commissionBaseCents: Number(order.commission_base_cents || 0) > 0 ? Number(order.commission_base_cents) : paidCents,
      paidAt,
      items: items.map((it) => ({
        productId: it.product_id,
        title: it.title,
        quantity: Number(it.qty || 0),
        priceCents: Number(it.price_cents || 0),
      })),
    };
  });

  /* 事务提交之后再发事件（订阅方自己开事务、必须幂等） */
  if (payload) events.emit('order.paid', payload);

  const freshPayment = db.get('SELECT * FROM payments WHERE id = ?', payment.id);
  const freshOrder = db.get('SELECT * FROM orders WHERE id = ?', order.id);
  return {
    payment: publicPayment(freshPayment),
    order: orderService.publicOrder(freshOrder),
    payload,
    idempotent: !payload,
    alreadyPaid: alreadyPaidOrder,
  };
}

/** 支付失败（回调 success=false）：订单保持 pending，支付单置 failed */
function failPayment(input = {}) {
  const db = input.db || getDb();
  const no = String(input.outTradeNo == null ? '' : input.outTradeNo).trim();
  if (!no) throw errors.badRequest('缺少支付单号 outTradeNo');
  const payment = db.get('SELECT * FROM payments WHERE out_trade_no = ?', no);
  if (!payment) throw errors.notFound('支付单不存在');
  if (payment.status === 'succeeded') return { payment: publicPayment(payment), changed: false };
  db.run(
    "UPDATE payments SET status = 'failed', raw = COALESCE(?, raw), updated_at = ? WHERE id = ?",
    jsonOrNull(input.raw),
    nowIso(),
    payment.id
  );
  return { payment: publicPayment(db.get('SELECT * FROM payments WHERE id = ?', payment.id)), changed: true };
}

/* ------------------------------------------------------------------ *
 * 查询
 * ------------------------------------------------------------------ */
function findPayment(db, outTradeNoValue) {
  const no = String(outTradeNoValue == null ? '' : outTradeNoValue).trim();
  if (!no) throw errors.validation('缺少支付单号');
  const row = db.get('SELECT * FROM payments WHERE out_trade_no = ?', no);
  if (!row) throw errors.notFound('支付单不存在');
  return row;
}

function getPayStatus(db, outTradeNoValue, userId) {
  const payment = findPayment(db, outTradeNoValue);
  const order = db.get('SELECT * FROM orders WHERE id = ?', payment.order_id);
  if (!order) throw errors.notFound('订单不存在');
  if (userId && order.user_id !== userId) throw errors.forbidden('无权查看该支付单');
  return {
    outTradeNo: payment.out_trade_no,
    status: payment.status,
    statusText: PAY_STATUS_TEXT[payment.status] || String(payment.status || ''),
    orderNo: order.order_no,
    orderStatus: order.status,
    amountCents: Number(payment.amount_cents || 0),
    amountText: centsToYuanString(payment.amount_cents),
    amountLabel: fmtYuan(payment.amount_cents),
    paidAt: payment.paid_at || null,
    transactionId: payment.transaction_id || null,
    message: payment.status === 'succeeded' ? '支付成功' : payment.status === 'pending' ? '等待支付' : '支付未完成',
  };
}

function listPaymentsByUser(db, userId, query = {}) {
  const paging = validate.paging(query);
  const total = db.pluck('SELECT COUNT(*) FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.user_id = ?', userId) || 0;
  const rows = db.all(
    `SELECT p.* FROM payments p JOIN orders o ON o.id = p.order_id
      WHERE o.user_id = ? ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`,
    userId,
    paging.limit,
    paging.offset
  );
  return validate.pageResult(rows.map(publicPayment), total, paging);
}

function adminListPayments(db, query = {}) {
  const paging = validate.paging(query);
  const where = [];
  const args = [];
  const status = String(query.status || '').trim();
  if (status && PAY_STATUS_TEXT[status]) {
    where.push('p.status = ?');
    args.push(status);
  }
  const keyword = String(query.keyword || '').trim();
  if (keyword) {
    where.push('(p.out_trade_no LIKE ? OR o.order_no LIKE ? OR u.nickname LIKE ?)');
    const like = `%${keyword}%`;
    args.push(like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total =
    db.pluck(
      `SELECT COUNT(*) FROM payments p
         LEFT JOIN orders o ON o.id = p.order_id
         LEFT JOIN users u ON u.id = o.user_id ${whereSql}`,
      ...args
    ) || 0;
  const rows = db.all(
    `SELECT p.*, o.order_no AS order_no, o.status AS order_status, u.nickname AS user_nickname
       FROM payments p
       LEFT JOIN orders o ON o.id = p.order_id
       LEFT JOIN users u ON u.id = o.user_id
       ${whereSql} ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`,
    ...args,
    paging.limit,
    paging.offset
  );
  const list = rows.map((row) => ({
    ...publicPayment(row),
    orderNo: row.order_no || '',
    orderStatus: row.order_status || '',
    userNickname: row.user_nickname || '',
  }));
  return validate.pageResult(list, total, paging);
}

module.exports = {
  PAY_STATUS_TEXT,
  MOCK_MESSAGE,
  publicPayment,
  payOrder,
  markPaid,
  failPayment,
  findPayment,
  getPayStatus,
  listPaymentsByUser,
  adminListPayments,
  resolveOrder,
};
