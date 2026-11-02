'use strict';
/**
 * 订单服务（契约第 4 章）。
 * 约定：
 *   - 金额整数「分」+ xxxText（纯数字两位小数，如 "199.00"）+ xxxLabel（带 ¥）；时间 ISO-8601 UTC；
 *   - 状态机 pending → paid → completed；pending → cancelled；paid/partial_refunded → refunding → refunded / partial_refunded；
 *   - 下单即锁库存（product.stock / sku.stock 同时扣减），取消/超时回滚，支付成功累计 sales；
 *   - db.tx 回调全部同步，禁止 await。
 */
const validate = require('../../http/validate');
const { errors } = require('../../http/errors');
const { newId, orderNo } = require('../../utils/id');
const { nowIso, isoPlusMinutes } = require('../../utils/time');
const { fmtYuan, centsToYuanString } = require('../../utils/money');
const { ORDER_STATUS_TEXT, PAID_ORDER_STATUSES, orderStatusText } = require('./constants');

const SOURCES = ['miniprogram', 'h5', 'ai'];
const MAX_QTY = 99;

/* ------------------------------------------------------------------ *
 * 映射
 * ------------------------------------------------------------------ */
function publicOrder(row, extra = {}) {
  if (!row) return null;
  return {
    id: row.id,
    orderNo: row.order_no,
    userId: row.user_id,
    status: row.status,
    statusText: orderStatusText(row.status),
    totalCents: Number(row.total_cents || 0),
    totalText: centsToYuanString(row.total_cents),
    totalLabel: fmtYuan(row.total_cents),
    paidCents: Number(row.paid_cents || 0),
    paidText: centsToYuanString(row.paid_cents),
    paidLabel: fmtYuan(row.paid_cents),
    refundedCents: Number(row.refunded_cents || 0),
    refundedText: centsToYuanString(row.refunded_cents),
    refundedLabel: fmtYuan(row.refunded_cents),
    commissionBaseCents: Number(row.commission_base_cents || 0),
    source: row.source || 'miniprogram',
    remark: row.remark || '',
    cancelReason: row.cancel_reason || '',
    expireAt: row.expire_at || null,
    paidAt: row.paid_at || null,
    closedAt: row.closed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    itemsCount: Number(row.items_count != null ? row.items_count : extra.itemsCount || 0),
    productTitles: row.product_titles || extra.productTitles || '',
    ...extra,
  };
}

function publicItem(row) {
  return {
    id: row.id,
    productId: row.product_id,
    skuId: row.sku_id || null,
    title: row.title,
    cover: row.cover || '',
    spec: row.spec || '',
    priceCents: Number(row.price_cents || 0),
    priceText: centsToYuanString(row.price_cents),
    priceLabel: fmtYuan(row.price_cents),
    quantity: Number(row.qty || 0),
    subtotalCents: Number(row.subtotal_cents || 0),
    subtotalText: centsToYuanString(row.subtotal_cents),
    subtotalLabel: fmtYuan(row.subtotal_cents),
  };
}

function itemsOf(db, orderId) {
  return db
    .all('SELECT * FROM order_items WHERE order_id = ? ORDER BY created_at ASC, id ASC', orderId)
    .map(publicItem);
}

function titlesOf(items) {
  const titles = items.map((i) => i.title).filter(Boolean);
  if (!titles.length) return '';
  const first = titles[0];
  return titles.length > 1 ? `${first} 等 ${titles.length} 件` : first;
}

/**
 * 订单摘要（列表/后台用，自带 items 汇总与 canPay/canCancel/canRefund，避免 N+1）。
 * 列表项与详情用同一套布尔规则，前端无需按 status 猜。
 */
function withSummary(db, rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const items = db.all(`SELECT * FROM order_items WHERE order_id IN (${placeholders})`, ...ids);
  const grouped = new Map();
  for (const it of items) {
    const list = grouped.get(it.order_id) || [];
    list.push(it);
    grouped.set(it.order_id, list);
  }
  /* 批次内一次性取出「审核中的退款」，避免逐行查询 */
  const pendingRefundIds = new Set(
    db
      .all(
        `SELECT DISTINCT order_id FROM refunds
          WHERE order_id IN (${placeholders}) AND status IN ('pending','processing')`,
        ...ids
      )
      .map((r) => r.order_id)
  );
  const windowDays = refundWindowDays(db);
  return rows.map((row) => {
    const list = grouped.get(row.id) || [];
    const remain = refundableCents(row);
    return publicOrder(row, {
      itemsCount: list.reduce((s, i) => s + Number(i.qty || 0), 0),
      productTitles: titlesOf(list),
      refundableCents: remain,
      refundableText: centsToYuanString(remain),
      refundableLabel: fmtYuan(remain),
      hasPendingRefund: pendingRefundIds.has(row.id),
      ...orderFlags(row, { pendingRefund: pendingRefundIds.has(row.id), windowDays }),
    });
  });
}

function statusTextOk(status) {
  return ORDER_STATUS_TEXT[status] ? status : status;
}

/* ------------------------------------------------------------------ *
 * 库存
 * ------------------------------------------------------------------ */
function readSellable(db, { productId, skuId }) {
  const product = db.get('SELECT * FROM products WHERE id = ?', String(productId == null ? '' : productId));
  if (!product || product.status !== 'on') throw errors.notFound('课程不存在或已下架');
  let sku = null;
  if (skuId !== undefined && skuId !== null && skuId !== '') {
    sku = db.get('SELECT * FROM skus WHERE id = ?', String(skuId));
    if (!sku || sku.product_id !== product.id || sku.status !== 'on') throw errors.notFound('课程规格不存在或已下架');
  }
  return {
    product,
    sku,
    priceCents: Number(sku ? sku.price_cents : product.price_cents),
    stock: Number(sku ? sku.stock : product.stock),
  };
}

/** 事务内扣库存；任一环节不足即抛 OUT_OF_STOCK（外层事务回滚） */
function lockStock(db, { product, sku, qty }) {
  if (sku) {
    const r = db.run('UPDATE skus SET stock = stock - ? WHERE id = ? AND stock >= ?', qty, sku.id, qty);
    if (!r.changes) throw errors.outOfStock(`库存不足，当前仅剩 ${Number(sku.stock || 0)} 份`);
  }
  const r2 = db.run('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?', qty, product.id, qty);
  if (!r2.changes) throw errors.outOfStock(`库存不足，当前仅剩 ${Number(product.stock || 0)} 份`);
}

/** 回滚库存（取消/超时/全额退款） */
function releaseStock(db, items, direction = 1) {
  for (const it of items) {
    const qty = Number(it.qty || 0);
    if (qty <= 0) continue;
    if (it.sku_id) db.run('UPDATE skus SET stock = stock + ? WHERE id = ?', qty * direction, it.sku_id);
    db.run('UPDATE products SET stock = stock + ? WHERE id = ?', qty * direction, it.product_id);
  }
}

/* ------------------------------------------------------------------ *
 * 下单
 * ------------------------------------------------------------------ */
function nextOrderNo(db) {
  for (let i = 0; i < 8; i++) {
    const candidate = orderNo();
    if (!db.get('SELECT 1 AS x FROM orders WHERE order_no = ?', candidate)) return candidate;
  }
  throw errors.internal('订单号生成失败，请重试');
}

const REMARK_MAX = 200;

function createOrder(db, input = {}) {
  const data = validate.object(input, {
    userId: { type: 'string', required: true, max: 64, label: '用户' },
    productId: { type: 'string', required: true, max: 64, label: '课程' },
    skuId: { type: 'string', max: 64, label: '课程规格' },
    quantity: { type: 'int', default: 1, min: 1, max: MAX_QTY, label: '数量' },
    remark: { type: 'string', max: REMARK_MAX, label: '备注' },
    source: { type: 'enum', values: SOURCES, default: 'miniprogram', label: '来源' },
  });
  const quantity = data.quantity;
  const sellable = readSellable(db, { productId: data.productId, skuId: data.skuId });
  if (sellable.stock < quantity) {
    throw errors.outOfStock(`库存不足，当前仅剩 ${sellable.stock} 份`);
  }

  const timeoutMinutes = Math.max(1, db.getSettingNumber('order_timeout_minutes', 15));
  const totalCents = sellable.priceCents * quantity;
  const id = newId('ord_');
  const no = nextOrderNo(db);
  const ts = nowIso();
  const expireAt = isoPlusMinutes(timeoutMinutes);

  db.tx(() => {
    lockStock(db, { product: sellable.product, sku: sellable.sku, qty: quantity });
    db.run(
      `INSERT INTO orders
        (id, order_no, user_id, status, total_cents, paid_cents, refunded_cents, commission_base_cents,
         source, remark, cancel_reason, expire_at, paid_at, closed_at, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, 0, 0, ?, ?, ?, '', ?, NULL, NULL, ?, ?)`,
      id,
      no,
      data.userId,
      totalCents,
      totalCents,
      data.source,
      data.remark || '',
      expireAt,
      ts,
      ts
    );
    db.run(
      `INSERT INTO order_items
        (id, order_id, product_id, sku_id, title, cover, spec, price_cents, qty, subtotal_cents, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId('oit_'),
      id,
      sellable.product.id,
      sellable.sku ? sellable.sku.id : null,
      sellable.product.title,
      sellable.product.cover || '',
      sellable.sku ? `${sellable.sku.name}${sellable.sku.spec ? ` · ${sellable.sku.spec}` : ''}` : '',
      sellable.priceCents,
      quantity,
      totalCents,
      ts
    );
  });

  const items = itemsOf(db, id);
  return {
    orderId: id,
    orderNo: no,
    status: 'pending',
    totalCents,
    totalText: centsToYuanString(totalCents),
    totalLabel: fmtYuan(totalCents),
    expireAt,
    items: items.map((i) => ({
      productId: i.productId,
      title: i.title,
      priceCents: i.priceCents,
      quantity: i.quantity,
    })),
  };
}

function findOrder(db, orderNoValue) {
  const no = String(orderNoValue == null ? '' : orderNoValue).trim();
  if (!no) throw errors.validation('缺少订单号');
  const row = db.get('SELECT * FROM orders WHERE order_no = ?', no);
  if (!row) throw errors.notFound('订单不存在');
  return row;
}

/** 归属校验：user 视角必须本人 */
function assertOwner(order, userId) {
  if (userId && order.user_id !== userId) throw errors.forbidden('无权访问该订单');
}

/* ------------------------------------------------------------------ *
 * 详情
 * ------------------------------------------------------------------ */
function latestPayment(db, orderId) {
  const row = db.get(
    'SELECT * FROM payments WHERE order_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
    orderId
  );
  if (!row) return null;
  return {
    id: row.id,
    outTradeNo: row.out_trade_no,
    provider: row.provider,
    amountCents: Number(row.amount_cents || 0),
    amountText: centsToYuanString(row.amount_cents),
    amountLabel: fmtYuan(row.amount_cents),
    status: row.status,
    prepayId: row.prepay_id || null,
    transactionId: row.transaction_id || null,
    paidAt: row.paid_at || null,
    createdAt: row.created_at,
  };
}

function latestRefund(db, orderId) {
  const row = db.get(
    'SELECT * FROM refunds WHERE order_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
    orderId
  );
  if (!row) return null;
  return {
    id: row.id,
    refundNo: row.refund_no,
    amountCents: Number(row.amount_cents || 0),
    amountText: centsToYuanString(row.amount_cents),
    amountLabel: fmtYuan(row.amount_cents),
    status: row.status,
    reason: row.reason || '',
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at || null,
    refundedAt: row.refunded_at || null,
  };
}

function entitlementsOf(db, orderId) {
  return db.all('SELECT * FROM entitlements WHERE order_id = ? ORDER BY created_at ASC', orderId).map((row) => ({
    id: row.id,
    productId: row.product_id,
    status: row.status,
    verifyCode: row.verify_code || '',
    grantedAt: row.created_at,
    expiresAt: row.expires_at || null,
  }));
}

function buildTimeline(order, refund) {
  const out = [{ at: order.created_at, key: 'created', title: '提交订单' }];
  if (order.paid_at) out.push({ at: order.paid_at, key: 'paid', title: '支付成功' });
  if (order.status === 'completed') out.push({ at: order.updated_at, key: 'completed', title: '课程已完成' });
  if (refund) {
    out.push({ at: refund.createdAt, key: 'refund_requested', title: '申请退款', desc: refund.reason });
    if (refund.reviewedAt) out.push({ at: refund.reviewedAt, key: 'refund_reviewed', title: '退款审核完成' });
    if (refund.refundedAt) out.push({ at: refund.refundedAt, key: 'refunded', title: '退款成功' });
  }
  if (order.status === 'cancelled' && order.closed_at) {
    out.push({ at: order.closed_at, key: 'closed', title: '订单已关闭', desc: order.cancel_reason || '' });
  }
  return out
    .filter((t) => !!t.at)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

function refundableCents(order) {
  return Math.max(0, Number(order.paid_cents || 0) - Number(order.refunded_cents || 0));
}

/** 可退款窗口天数（settings.refund_window_days） */
function refundWindowDays(db) {
  const n = Number(db.getSettingNumber('refund_window_days', 7));
  return Number.isFinite(n) && n >= 0 ? n : 7;
}

/**
 * 列表/详情共用的可操作布尔：
 *   canPay    = pending 且未过期
 *   canCancel = pending
 *   canRefund = paid/completed/partial_refunded 且仍在退款窗口内、有可退金额、没有审核中的退款
 */
function orderFlags(row, { pendingRefund = false, windowDays = 7, now = Date.now() } = {}) {
  const canPay = row.status === 'pending' && new Date(row.expire_at || 0).getTime() > now;
  const canCancel = row.status === 'pending';
  const paidAt = row.paid_at ? new Date(row.paid_at).getTime() : 0;
  const inWindow = paidAt > 0 && now - paidAt <= windowDays * 86400000;
  const canRefund =
    PAID_ORDER_STATUSES.includes(row.status) && refundableCents(row) > 0 && inWindow && !pendingRefund;
  return { canPay, canCancel, canRefund };
}

function getOrderDetail(db, orderNoValue, userId) {
  const order = findOrder(db, orderNoValue);
  assertOwner(order, userId);
  const items = itemsOf(db, order.id);
  const payment = latestPayment(db, order.id);
  const refund = latestRefund(db, order.id);
  const entitlements = entitlementsOf(db, order.id);
  const pendingRefund = db.get(
    "SELECT id FROM refunds WHERE order_id = ? AND status IN ('pending','processing') LIMIT 1",
    order.id
  );

  const flags = orderFlags(order, {
    pendingRefund: !!pendingRefund,
    windowDays: refundWindowDays(db),
  });

  const base = publicOrder(order, {
    itemsCount: items.reduce((s, i) => s + i.quantity, 0),
    productTitles: titlesOf(items),
  });

  return {
    order: {
      ...base,
      refundableCents: refundableCents(order),
      refundableText: centsToYuanString(refundableCents(order)),
      refundableLabel: fmtYuan(refundableCents(order)),
      hasPendingRefund: !!pendingRefund,
    },
    items,
    payment,
    refund,
    entitlements,
    canPay: flags.canPay,
    canCancel: flags.canCancel,
    canRefund: flags.canRefund,
    timeline: buildTimeline(order, refund),
  };
}

/* ------------------------------------------------------------------ *
 * 用户侧列表 / 取消 / 完成
 * ------------------------------------------------------------------ */
function listOrders(db, userId, query = {}) {
  const paging = validate.paging(query);
  const where = ['o.user_id = ?'];
  const args = [userId];
  const status = String(query.status || '').trim();
  if (status === 'refunding') {
    where.push("o.status IN ('refunding')");
  } else if (status && ORDER_STATUS_TEXT[status]) {
    where.push('o.status = ?');
    args.push(statusTextOk(status));
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = db.pluck(`SELECT COUNT(*) FROM orders o ${whereSql}`, ...args) || 0;
  const rows = db.all(
    `SELECT o.* FROM orders o ${whereSql} ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?`,
    ...args,
    paging.limit,
    paging.offset
  );
  return validate.pageResult(withSummary(db, rows), total, paging);
}

function cancelOrder(db, orderNoValue, userId, reason = '') {
  const order = findOrder(db, orderNoValue);
  assertOwner(order, userId);
  if (order.status !== 'pending') throw errors.invalidState('该订单当前状态不可取消');
  const items = db.all('SELECT * FROM order_items WHERE order_id = ?', order.id);
  const ts = nowIso();
  db.tx(() => {
    releaseStock(db, items, 1);
    db.run(
      `UPDATE orders SET status = 'cancelled', cancel_reason = ?, closed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
      String(reason || '用户取消').slice(0, 100),
      ts,
      ts,
      order.id
    );
  });
  return getOrderDetail(db, order.order_no, userId);
}

function confirmOrder(db, orderNoValue, userId) {
  const order = findOrder(db, orderNoValue);
  assertOwner(order, userId);
  if (order.status !== 'paid') throw errors.invalidState('仅已支付订单可确认完成');
  db.run("UPDATE orders SET status = 'completed', updated_at = ? WHERE id = ?", nowIso(), order.id);
  return getOrderDetail(db, order.order_no, userId);
}

/* ------------------------------------------------------------------ *
 * 后台
 * ------------------------------------------------------------------ */
function adminListOrders(db, query = {}) {
  const paging = validate.paging(query);
  const where = [];
  const args = [];
  const status = String(query.status || '').trim();
  if (status && ORDER_STATUS_TEXT[status]) {
    where.push('o.status = ?');
    args.push(status);
  }
  const keyword = String(query.keyword || '').trim();
  if (keyword) {
    where.push('(o.order_no LIKE ? OR u.nickname LIKE ? OR o.user_id LIKE ?)');
    const like = `%${keyword}%`;
    args.push(like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total =
    db.pluck(
      `SELECT COUNT(*) FROM orders o LEFT JOIN users u ON u.id = o.user_id ${whereSql}`,
      ...args
    ) || 0;
  const rows = db.all(
    `SELECT o.*, u.nickname AS user_nickname, u.phone AS user_phone
       FROM orders o LEFT JOIN users u ON u.id = o.user_id
       ${whereSql} ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?`,
    ...args,
    paging.limit,
    paging.offset
  );
  const list = withSummary(db, rows).map((o, i) => ({
    ...o,
    userNickname: rows[i].user_nickname || '',
    nickname: rows[i].user_nickname || '',
    userPhone: rows[i].user_phone || '',
  }));
  return validate.pageResult(list, total, paging);
}

function adminGetOrder(db, orderNoValue) {
  const detail = getOrderDetail(db, orderNoValue);
  const user = db.get('SELECT id, nickname, phone FROM users WHERE id = ?', detail.order.userId);
  const refunds = db
    .all('SELECT * FROM refunds WHERE order_id = ? ORDER BY created_at DESC', detail.order.id)
    .map((row) => ({
      refundNo: row.refund_no,
      amountCents: Number(row.amount_cents || 0),
      amountText: centsToYuanString(row.amount_cents),
      status: row.status,
      reason: row.reason || '',
      reviewNote: row.review_note || '',
      createdAt: row.created_at,
      reviewedAt: row.reviewed_at || null,
      refundedAt: row.refunded_at || null,
    }));
  return {
    ...detail,
    user: user ? { id: user.id, nickname: user.nickname, phone: user.phone || '' } : null,
    refunds,
  };
}

/** 后台强制关单：仅待支付订单可直接关闭（已支付订单走退款） */
function adminCloseOrder(db, orderNoValue, reason = '') {
  const order = findOrder(db, orderNoValue);
  if (order.status === 'pending') {
    return cancelOrder(db, order.order_no, null, reason || '后台关单');
  }
  throw errors.invalidState('该订单已支付，请通过退款流程处理');
}

function adminCompleteOrder(db, orderNoValue) {
  const order = findOrder(db, orderNoValue);
  if (order.status !== 'paid') throw errors.invalidState('仅已支付订单可标记完成');
  db.run("UPDATE orders SET status = 'completed', updated_at = ? WHERE id = ?", nowIso(), order.id);
  return adminGetOrder(db, order.order_no);
}

/* ------------------------------------------------------------------ *
 * 超时关单（sweeper 'order:expire'，每 60 秒）
 * ------------------------------------------------------------------ */
function expireOrders(db) {
  const now = nowIso();
  const rows = db.all(
    "SELECT * FROM orders WHERE status = 'pending' AND expire_at IS NOT NULL AND expire_at < ? LIMIT 200",
    now
  );
  let closed = 0;
  for (const order of rows) {
    const items = db.all('SELECT * FROM order_items WHERE order_id = ?', order.id);
    const changed = db.tx(() => {
      const r = db.run(
        `UPDATE orders SET status = 'cancelled', cancel_reason = '超时未支付', closed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
        now,
        now,
        order.id
      );
      if (!r.changes) return false;
      releaseStock(db, items, 1);
      return true;
    });
    if (changed) closed += 1;
  }
  return closed;
}

module.exports = {
  SOURCES,
  MAX_QTY,
  publicOrder,
  publicItem,
  itemsOf,
  createOrder,
  findOrder,
  getOrderDetail,
  listOrders,
  cancelOrder,
  confirmOrder,
  adminListOrders,
  adminGetOrder,
  adminCloseOrder,
  adminCompleteOrder,
  expireOrders,
  releaseStock,
  refundableCents,
  latestPayment,
  latestRefund,
};
