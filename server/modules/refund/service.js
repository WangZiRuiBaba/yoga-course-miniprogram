'use strict';
/**
 * 退款服务（契约第 6 章）。
 * 规则全部读 settings：refund_window_days / allow_partial_refund / auto_refund_enabled / auto_refund_max_cents。
 * 统一成功入口：markRefundSucceeded({refundNo, transactionId}) —— 幂等，事务提交后 emit('refund.succeeded')。
 */
const validate = require('../../http/validate');
const { errors } = require('../../http/errors');
const { getDb } = require('../../db');
const { newId, refundNo: genRefundNo } = require('../../utils/id');
const { nowIso } = require('../../utils/time');
const { fmtYuan, centsToYuanString } = require('../../utils/money');
const events = require('../../events');
const orderService = require('../order/service');
const { PAID_ORDER_STATUSES, refundStatusText } = require('../order/constants');

const REASON_TYPES = ['wrong_purchase', 'schedule_conflict', 'quality', 'duplicate', 'other', 'ai'];

const REASON_TYPE_TEXT = {
  wrong_purchase: '买错课程',
  schedule_conflict: '时间冲突',
  quality: '课程质量问题',
  duplicate: '重复购买',
  other: '其他原因',
  ai: 'AI 对话申请',
};

function publicRefund(row, extra = {}) {
  if (!row) return null;
  return {
    id: row.id,
    refundNo: row.refund_no,
    orderId: row.order_id,
    userId: row.user_id,
    amountCents: Number(row.amount_cents || 0),
    amountText: centsToYuanString(row.amount_cents),
    amountLabel: fmtYuan(row.amount_cents),
    reason: row.reason || '',
    status: row.status,
    statusText: refundStatusText(row.status),
    channel: row.channel || 'original',
    providerRefundId: row.provider_refund_id || null,
    reviewNote: row.review_note || '',
    reviewedBy: row.reviewed_by || null,
    reviewedAt: row.reviewed_at || null,
    refundedAt: row.refunded_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...extra,
  };
}

function nextRefundNo(db) {
  for (let i = 0; i < 8; i++) {
    const candidate = genRefundNo();
    if (!db.get('SELECT 1 AS x FROM refunds WHERE refund_no = ?', candidate)) return candidate;
  }
  throw errors.internal('退款单号生成失败，请重试');
}

function findRefund(db, refundNoValue) {
  const no = String(refundNoValue == null ? '' : refundNoValue).trim();
  if (!no) throw errors.validation('缺少退款单号');
  const row = db.get('SELECT * FROM refunds WHERE refund_no = ?', no);
  if (!row) throw errors.notFound('退款单不存在');
  return row;
}

function orderOf(db, orderId) {
  const order = db.get('SELECT * FROM orders WHERE id = ?', orderId);
  if (!order) throw errors.notFound('订单不存在');
  return order;
}

function entitlementsOfOrder(db, orderId) {
  return db.all('SELECT * FROM entitlements WHERE order_id = ?', orderId);
}

/* ------------------------------------------------------------------ *
 * 申请退款
 * ------------------------------------------------------------------ */
function createRefund(db, input = {}) {
  const data = validate.object(input, {
    orderNo: { type: 'string', required: true, max: 64, label: '订单号' },
    userId: { type: 'string', max: 64, label: '用户' },
    reason: { type: 'string', required: true, min: 1, max: 100, label: '退款原因' },
    reasonType: { type: 'enum', values: REASON_TYPES, label: '退款原因类型' },
  });
  /* amountCents 单位是「分」（整数）；amount 单位是「元」（前端手填时用） */
  let requestedCents;
  if (input.amountCents !== undefined && input.amountCents !== null && input.amountCents !== '') {
    requestedCents = validate.asInt(input.amountCents, { min: 1, label: '退款金额（分）' });
  } else if (input.amount !== undefined && input.amount !== null && input.amount !== '') {
    requestedCents = validate.asMoneyCents(input.amount, { min: 1, label: '退款金额（元）' });
  }

  const order = orderService.findOrder(db, data.orderNo);
  if (data.userId && order.user_id !== data.userId) throw errors.forbidden('无权操作该订单');
  if (!PAID_ORDER_STATUSES.includes(order.status)) {
    throw errors.invalidState('当前订单状态不可退款');
  }

  const windowDays = Math.max(0, db.getSettingNumber('refund_window_days', 7));
  if (order.paid_at) {
    const deadline = new Date(order.paid_at).getTime() + windowDays * 86400000;
    if (Date.now() > deadline) {
      throw errors.validation(`已超过退款期限（支付后 ${windowDays} 天内可退）`);
    }
  }

  const refundable = orderService.refundableCents(order);
  if (refundable <= 0) throw errors.validation('该订单已全额退款，无需再次申请');

  const amountCents = requestedCents === undefined ? refundable : requestedCents;
  if (amountCents > refundable) {
    throw errors.validation(`退款金额不能超过可退金额 ${fmtYuan(refundable)}`);
  }
  const allowPartial = db.getSetting('allow_partial_refund', true) !== false;
  if (!allowPartial && amountCents !== refundable) {
    throw errors.validation(`该订单仅支持全额退款（${fmtYuan(refundable)}）`);
  }

  const pending = db.get(
    "SELECT refund_no FROM refunds WHERE order_id = ? AND status IN ('pending','processing') LIMIT 1",
    order.id
  );
  if (pending) throw errors.duplicate(`该订单已有退款申请（${pending.refund_no}）在处理中`);

  const autoEnabled = db.getSetting('auto_refund_enabled', true) !== false;
  const autoMax = db.getSettingNumber('auto_refund_max_cents', 20000);
  const hasUsed = entitlementsOfOrder(db, order.id).some((e) => e.status === 'used');
  const autoApproved = autoEnabled && amountCents <= autoMax && !hasUsed;

  const id = newId('rfd_');
  const no = nextRefundNo(db);
  const ts = nowIso();
  const status = autoApproved ? 'processing' : 'pending';
  const reasonText = data.reasonType ? `${REASON_TYPE_TEXT[data.reasonType]}：${data.reason}` : data.reason;

  db.run(
    `INSERT INTO refunds
      (id, refund_no, order_id, user_id, amount_cents, reason, status, channel,
       provider_refund_id, review_note, reviewed_by, reviewed_at, refunded_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'original', NULL, '', NULL, NULL, NULL, ?, ?)`,
    id,
    no,
    order.id,
    order.user_id,
    amountCents,
    reasonText.slice(0, 200),
    status,
    ts,
    ts
  );

  let autoSucceeded = false;
  if (autoApproved) {
    markRefundSucceeded({ db, refundNo: no, transactionId: `MOCK-RF-${Date.now()}` });
    autoSucceeded = true;
  }

  const fresh = findRefund(db, no);
  const fullRefund = amountCents >= refundable;
  return {
    refundNo: fresh.refund_no,
    orderNo: order.order_no,
    amountCents: Number(fresh.amount_cents || 0),
    amountText: centsToYuanString(fresh.amount_cents),
    amountLabel: fmtYuan(fresh.amount_cents),
    status: fresh.status,
    statusText: refundStatusText(fresh.status),
    autoApproved: autoSucceeded,
    reason: fresh.reason,
    message: autoSucceeded
      ? '已自动通过审核并原路退回，预计 1-3 个工作日到账'
      : '退款申请已提交，客服会在 24 小时内审核',
    nextAction: autoSucceeded ? 'none' : 'wait_review',
    fullRefund,
    orderStatus: db.get('SELECT status FROM orders WHERE id = ?', order.id).status,
  };
}

/* ------------------------------------------------------------------ *
 * 查询
 * ------------------------------------------------------------------ */
function orderBrief(db, orderId) {
  const row = db.get('SELECT order_no, status, paid_cents, refunded_cents FROM orders WHERE id = ?', orderId);
  if (!row) return { orderNo: '', orderStatus: '', paidCents: 0, refundedCents: 0 };
  return {
    orderNo: row.order_no,
    orderStatus: row.status,
    paidCents: Number(row.paid_cents || 0),
    refundedCents: Number(row.refunded_cents || 0),
  };
}

function listRefunds(db, userId, query = {}) {
  const paging = validate.paging(query);
  const where = ['r.user_id = ?'];
  const args = [userId];
  const status = String(query.status || '').trim();
  if (status && refundStatusText(status) === status) {
    where.push('r.status = ?');
    args.push(status);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = db.pluck(`SELECT COUNT(*) FROM refunds r ${whereSql}`, ...args) || 0;
  const rows = db.all(
    `SELECT r.*, o.order_no AS order_no, o.status AS order_status
       FROM refunds r LEFT JOIN orders o ON o.id = r.order_id
       ${whereSql} ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`,
    ...args,
    paging.limit,
    paging.offset
  );
  return validate.pageResult(
    rows.map((row) => publicRefund(row, { orderNo: row.order_no || '', orderStatus: row.order_status || '' })),
    total,
    paging
  );
}

function getRefund(db, refundNoValue, userId) {
  const refund = findRefund(db, refundNoValue);
  if (userId && refund.user_id !== userId) throw errors.forbidden('无权查看该退款单');
  const order = orderOf(db, refund.order_id);
  const brief = orderBrief(db, refund.order_id);
  return {
    refund: publicRefund(refund, { orderNo: order.order_no, orderStatus: order.status }),
    orderNo: order.order_no,
    orderStatus: order.status,
    paidCents: brief.paidCents,
    paidText: centsToYuanString(brief.paidCents),
    refundedCents: brief.refundedCents,
    refundedText: centsToYuanString(brief.refundedCents),
    progress: buildProgress(refund),
  };
}

function buildProgress(refund) {
  const steps = [{ key: 'created', title: '提交申请', at: refund.created_at, done: true }];
  steps.push({
    key: 'reviewed',
    title: refund.status === 'rejected' ? '审核驳回' : '审核通过',
    at: refund.reviewed_at,
    done: !!refund.reviewed_at,
  });
  steps.push({
    key: 'refunded',
    title: refund.status === 'rejected' ? '退款终止' : '退款到账',
    at: refund.refunded_at,
    done: !!refund.refunded_at,
  });
  return { status: refund.status, statusText: refundStatusText(refund.status), steps };
}

function adminListRefunds(db, query = {}) {
  const paging = validate.paging(query);
  const where = [];
  const args = [];
  const status = String(query.status || '').trim();
  if (status && refundStatusText(status) === status) {
    where.push('r.status = ?');
    args.push(status);
  }
  const keyword = String(query.keyword || '').trim();
  if (keyword) {
    where.push('(r.refund_no LIKE ? OR o.order_no LIKE ? OR u.nickname LIKE ?)');
    const like = `%${keyword}%`;
    args.push(like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total =
    db.pluck(
      `SELECT COUNT(*) FROM refunds r
         LEFT JOIN orders o ON o.id = r.order_id
         LEFT JOIN users u ON u.id = r.user_id ${whereSql}`,
      ...args
    ) || 0;
  const rows = db.all(
    `SELECT r.*, o.order_no AS order_no, o.status AS order_status, o.paid_cents AS paid_cents,
            u.nickname AS user_nickname
       FROM refunds r
       LEFT JOIN orders o ON o.id = r.order_id
       LEFT JOIN users u ON u.id = r.user_id
       ${whereSql} ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`,
    ...args,
    paging.limit,
    paging.offset
  );
  const list = rows.map((row) =>
    publicRefund(row, {
      orderNo: row.order_no || '',
      orderStatus: row.order_status || '',
      paidCents: Number(row.paid_cents || 0),
      paidText: centsToYuanString(row.paid_cents),
      userNickname: row.user_nickname || '',
      nickname: row.user_nickname || '',
    })
  );
  const counts = {};
  for (const r of db.all('SELECT status, COUNT(*) AS c FROM refunds GROUP BY status')) counts[r.status] = r.c;
  return { ...validate.pageResult(list, total, paging), counts };
}

/* ------------------------------------------------------------------ *
 * 后台审核
 * ------------------------------------------------------------------ */
function approveRefund(db, refundNoValue, input = {}) {
  const data = validate.object(input, {
    note: { type: 'string', max: 200, label: '审核备注' },
    adminId: { type: 'string', max: 64, label: '审核人' },
  });
  const refund = findRefund(db, refundNoValue);
  if (refund.status === 'succeeded') return { refund: getRefund(db, refund.refund_no).refund, idempotent: true };
  if (refund.status === 'rejected') throw errors.invalidState('该退款单已驳回，不能再次通过');
  if (refund.status === 'failed') throw errors.invalidState('该退款单出款失败，请重新发起');
  if (refund.status !== 'pending' && refund.status !== 'processing') {
    throw errors.invalidState('当前退款单状态不可审核');
  }

  const order = orderOf(db, refund.order_id);
  const ts = nowIso();
  db.tx(() => {
    db.run(
      "UPDATE refunds SET status = 'processing', review_note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?",
      String(data.note || '').slice(0, 200),
      data.adminId || 'admin',
      ts,
      ts,
      refund.id
    );
    if (PAID_ORDER_STATUSES.includes(order.status)) {
      db.run("UPDATE orders SET status = 'refunding', updated_at = ? WHERE id = ?", ts, order.id);
    }
  });

  /* 出款（mock 立即成功）——事务提交后再进入统一成功入口，避免事件早于提交 */
  markRefundSucceeded({ db, refundNo: refund.refund_no, transactionId: `MOCK-RF-${Date.now()}` });
  const fresh = getRefund(db, refund.refund_no);
  void events;
  return { refund: fresh.refund, orderNo: fresh.orderNo, orderStatus: fresh.orderStatus, idempotent: false };
}

function rejectRefund(db, refundNoValue, input = {}) {
  const data = validate.object(input, {
    reason: { type: 'string', required: true, min: 1, max: 200, label: '驳回原因' },
    adminId: { type: 'string', max: 64, label: '审核人' },
  });
  const refund = findRefund(db, refundNoValue);
  if (refund.status === 'rejected') throw errors.invalidState('该退款单已驳回');
  if (refund.status === 'succeeded') throw errors.invalidState('该退款单已退款成功，不能驳回');
  if (refund.status !== 'pending' && refund.status !== 'processing') {
    throw errors.invalidState('当前退款单状态不可驳回');
  }
  const ts = nowIso();
  db.tx(() => {
    db.run(
      "UPDATE refunds SET status = 'rejected', review_note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?",
      String(data.reason).slice(0, 200),
      data.adminId || 'admin',
      ts,
      ts,
      refund.id
    );
    const order = orderOf(db, refund.order_id);
    if (order.status === 'refunding') {
      db.run("UPDATE orders SET status = 'paid', updated_at = ? WHERE id = ?", ts, order.id);
    }
  });
  const fresh = findRefund(db, refund.refund_no);
  return {
    refund: publicRefund(fresh, { orderNo: orderBrief(db, fresh.order_id).orderNo }),
    message: '已驳回该退款申请',
    nextAction: 'contact_service',
  };
}

/* ------------------------------------------------------------------ *
 * 统一退款成功入口（幂等）
 * ------------------------------------------------------------------ */
function markRefundSucceeded(input = {}) {
  const db = input.db || getDb();
  const refund = findRefund(db, input.refundNo);
  const order = orderOf(db, refund.order_id);

  if (refund.status === 'succeeded') {
    return { refund: publicRefund(refund), order: orderService.publicOrder(order), idempotent: true, payload: null };
  }
  if (refund.status === 'rejected') throw errors.invalidState('该退款单已驳回，不能标记退款成功');

  const amountCents = Number(refund.amount_cents || 0);
  const items = db.all('SELECT * FROM order_items WHERE order_id = ?', order.id);
  const ts = nowIso();
  const transactionId = String(input.transactionId || `MOCK-RF-${Date.now()}`);
  let payload = null;

  db.tx(() => {
    const refundedCents = Number(order.refunded_cents || 0) + amountCents;
    const fullRefund = refundedCents >= Number(order.paid_cents || 0);
    const nextStatus = fullRefund ? 'refunded' : 'partial_refunded';

    db.run(
      `UPDATE refunds SET status = 'succeeded', provider_refund_id = ?, refunded_at = ?, updated_at = ?
       WHERE id = ?`,
      transactionId,
      ts,
      ts,
      refund.id
    );
    db.run('UPDATE orders SET status = ?, refunded_cents = ?, updated_at = ? WHERE id = ?', nextStatus, refundedCents, ts, order.id);

    if (fullRefund) {
      /* 全额：权益失效 + 销量回滚 + 库存回滚 */
      db.run("UPDATE entitlements SET status = 'revoked', updated_at = ? WHERE order_id = ?", ts, order.id);
      for (const it of items) {
        db.run('UPDATE products SET sales = MAX(0, sales - ?) WHERE id = ?', Number(it.qty || 0), it.product_id);
      }
      orderService.releaseStock(db, items, 1);
    }

    payload = {
      refundId: refund.id,
      refundNo: refund.refund_no,
      orderId: order.id,
      orderNo: order.order_no,
      userId: order.user_id,
      amountCents,
      refundedAt: ts,
      fullRefund,
    };
  });

  if (payload) events.emit('refund.succeeded', payload);

  return {
    refund: publicRefund(db.get('SELECT * FROM refunds WHERE id = ?', refund.id)),
    order: orderService.publicOrder(db.get('SELECT * FROM orders WHERE id = ?', order.id)),
    payload,
    idempotent: false,
  };
}

module.exports = {
  REASON_TYPES,
  REASON_TYPE_TEXT,
  publicRefund,
  createRefund,
  findRefund,
  listRefunds,
  getRefund,
  adminListRefunds,
  approveRefund,
  rejectRefund,
  markRefundSucceeded,
};
