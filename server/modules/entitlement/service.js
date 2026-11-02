'use strict';
/**
 * 权益模块（契约第 7 章）。
 *   - 订阅 order.paid   → 按订单明细发放权益（verify_code 8 位数字，membership 一年有效）
 *   - 订阅 refund.succeeded（fullRefund） → 权益置失效 status='revoked'
 * 事件订阅方一律同步执行，保证 markPaid() 返回时权益已落库。
 */
const { getDb } = require('../../db');
const validate = require('../../http/validate');
const { errors } = require('../../http/errors');
const { newId, verifyCode } = require('../../utils/id');
const { nowIso, isoPlusDays } = require('../../utils/time');
const events = require('../../events');

const ENTITLEMENT_STATUS_TEXT = {
  active: '有效',
  used: '已核销',
  expired: '已过期',
  revoked: '已失效',
};

const TYPE_TEXT = {
  online: '线上课',
  offline: '到店课',
  membership: '会员卡',
};

const NOTICE = {
  online: '线上课程永久回看：在小程序「我的课程」点开即可观看；直播课请按课表准时进入直播间。',
  offline: '到店课程请提前 10 分钟入场，向前台出示核销码完成签到；请自带瑜伽垫或提前向馆内借用。',
  membership: '会员卡自开通日起 365 天有效，可参加馆内常规团课；预约请提前一天在客服号登记。',
};

function statusTextOf(status) {
  return ENTITLEMENT_STATUS_TEXT[status] || '有效';
}

function publicEntitlement(row, extra = {}) {
  if (!row) return null;
  const type = row.product_type || row.type || 'online';
  return {
    id: row.id,
    userId: row.user_id,
    productId: row.product_id,
    orderId: row.order_id,
    orderNo: row.order_no || '',
    title: row.title || row.product_title || '课程',
    cover: row.cover || `/api/media/cover/${row.product_id}`,
    type,
    typeText: TYPE_TEXT[type] || '课程',
    verifyCode: row.verify_code || '',
    grantedAt: row.starts_at || row.created_at,
    startsAt: row.starts_at || row.created_at,
    expiresAt: row.expires_at || null,
    status: row.status || 'active',
    statusText: statusTextOf(row.status),
    teacher: row.teacher || '',
    schedule: row.schedule || '',
    durationMin: Number(row.duration_min || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...extra,
  };
}

/* ------------------------------------------------------------------ *
 * 发放（order.paid 订阅）
 * ------------------------------------------------------------------ */
function uniqueVerifyCode(db) {
  for (let i = 0; i < 20; i++) {
    const code = verifyCode();
    if (!db.get('SELECT 1 AS x FROM entitlements WHERE verify_code = ?', code)) return code;
  }
  throw errors.internal('核销码生成失败，请重试');
}

function grantOrder(db, payload = {}) {
  const orderId = payload.orderId;
  if (!orderId) return [];
  const order = db.get('SELECT * FROM orders WHERE id = ?', orderId);
  if (!order) return [];
  const items = Array.isArray(payload.items) && payload.items.length
    ? payload.items
    : db.all('SELECT product_id AS productId, title, quantity FROM order_items WHERE order_id = ?', orderId);
  const paidAt = payload.paidAt || order.paid_at || nowIso();
  const granted = [];

  for (const item of items) {
    const productId = item.productId || item.product_id;
    if (!productId) continue;
    const product = db.get('SELECT * FROM products WHERE id = ?', productId);
    const type = product ? product.type : 'online';
    const existing = db.get('SELECT * FROM entitlements WHERE order_id = ? AND product_id = ?', orderId, productId);
    if (existing) {
      if (existing.status === 'revoked') {
        db.run("UPDATE entitlements SET status = 'active', updated_at = ? WHERE id = ?", nowIso(), existing.id);
      }
      granted.push(existing.id);
      continue;
    }
    const id = newId('ent_');
    const ts = nowIso();
    const expiresAt = type === 'membership' ? isoPlusDays(paidAt, 365) : null;
    db.run(
      `INSERT INTO entitlements
        (id, user_id, product_id, order_id, status, verify_code, starts_at, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      id,
      order.user_id,
      productId,
      orderId,
      uniqueVerifyCode(db),
      paidAt,
      expiresAt,
      ts,
      ts
    );
    granted.push(id);
  }
  return granted;
}

function onOrderPaid(payload) {
  try {
    return grantOrder(getDb(), payload);
  } catch (err) {
    console.error('[entitlement] 发放失败', err && err.message);
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * 回收（refund.succeeded 订阅）
 * ------------------------------------------------------------------ */
function revokeOrder(db, orderId, at) {
  const ts = at || nowIso();
  db.run("UPDATE entitlements SET status = 'revoked', updated_at = ? WHERE order_id = ?", ts, orderId);
  return db.pluck('SELECT COUNT(*) FROM entitlements WHERE order_id = ?', orderId) || 0;
}

function onRefundSucceeded(payload) {
  try {
    const db = getDb();
    if (!payload || !payload.fullRefund || !payload.orderId) return 0;
    return revokeOrder(db, payload.orderId, payload.refundedAt);
  } catch (err) {
    console.error('[entitlement] 回收失败', err && err.message);
    return 0;
  }
}

let subscribed = false;
function subscribe() {
  if (subscribed) return;
  subscribed = true;
  events.on('order.paid', onOrderPaid);
  events.on('refund.succeeded', onRefundSucceeded);
}

/* ------------------------------------------------------------------ *
 * 查询
 * ------------------------------------------------------------------ */
const SELECT_SQL = `SELECT e.*, p.title AS product_title, p.cover AS cover, p.type AS product_type,
                           p.teacher AS teacher, p.schedule AS schedule, p.duration_min AS duration_min,
                           o.order_no AS order_no
                      FROM entitlements e
                      LEFT JOIN products p ON p.id = e.product_id
                      LEFT JOIN orders o ON o.id = e.order_id`;

function listMine(db, userId) {
  const rows = db.all(`${SELECT_SQL} WHERE e.user_id = ? ORDER BY e.created_at DESC, e.rowid DESC`, userId);
  return rows.map((row) => publicEntitlement(row));
}

function getMine(db, id, userId) {
  const row = db.get(`${SELECT_SQL} WHERE e.id = ?`, String(id || '').trim());
  if (!row) throw errors.notFound('课程权益不存在');
  if (userId && row.user_id !== userId) throw errors.forbidden('无权查看该课程权益');
  const ent = publicEntitlement(row);
  /* 上课须知：课程详情优先，缺省按类型给默认文案 */
  const product = db.get('SELECT detail_html, teacher, schedule, duration_min FROM products WHERE id = ?', row.product_id);
  return {
    entitlement: ent,
    notice: NOTICE[ent.type] || NOTICE.online,
    noticeHtml: product && product.detail_html ? product.detail_html : '',
    teacher: product ? product.teacher || '' : '',
    schedule: product ? product.schedule || '' : '',
    durationMin: product ? Number(product.duration_min || 0) : 0,
    orderNo: ent.orderNo,
    verifyTip: ent.status === 'active' ? '到店出示该核销码即可签到' : '该权益已不可核销',
  };
}

function adminList(db, query = {}) {
  const paging = validate.paging(query);
  const where = [];
  const args = [];
  const status = String(query.status || '').trim();
  if (status && ENTITLEMENT_STATUS_TEXT[status]) {
    where.push('e.status = ?');
    args.push(status);
  }
  const keyword = String(query.keyword || '').trim();
  if (keyword) {
    where.push('(e.verify_code LIKE ? OR p.title LIKE ? OR o.order_no LIKE ? OR u.nickname LIKE ?)');
    const like = `%${keyword}%`;
    args.push(like, like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total =
    db.pluck(
      `SELECT COUNT(*) FROM entitlements e
         LEFT JOIN products p ON p.id = e.product_id
         LEFT JOIN orders o ON o.id = e.order_id
         LEFT JOIN users u ON u.id = e.user_id ${whereSql}`,
      ...args
    ) || 0;
  const rows = db.all(
    `SELECT e.*, p.title AS product_title, p.cover AS cover, p.type AS product_type,
            p.teacher AS teacher, p.duration_min AS duration_min,
            o.order_no AS order_no, u.nickname AS user_nickname
       FROM entitlements e
       LEFT JOIN products p ON p.id = e.product_id
       LEFT JOIN orders o ON o.id = e.order_id
       LEFT JOIN users u ON u.id = e.user_id
       ${whereSql} ORDER BY e.created_at DESC, e.rowid DESC LIMIT ? OFFSET ?`,
    ...args,
    paging.limit,
    paging.offset
  );
  const list = rows.map((row) =>
    publicEntitlement(row, { userNickname: row.user_nickname || '' })
  );
  return validate.pageResult(list, total, paging);
}

/** 门店核销：把 active 权益标记为 used */
function useEntitlement(db, id, input = {}) {
  const data = validate.object(input, {
    verifyCode: { type: 'string', max: 32, label: '核销码' },
    operatorId: { type: 'string', max: 64, label: '操作人' },
  });
  const row = db.get(`${SELECT_SQL} WHERE e.id = ?`, String(id || '').trim());
  if (!row) throw errors.notFound('课程权益不存在');
  if (data.verifyCode && data.verifyCode !== row.verify_code) {
    throw errors.validation('核销码不正确');
  }
  if (row.status === 'used') return { entitlement: publicEntitlement(row), idempotent: true };
  if (row.status !== 'active') throw errors.invalidState('该权益已失效，无法核销');
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    throw errors.invalidState('该权益已过期，无法核销');
  }
  const ts = nowIso();
  db.run("UPDATE entitlements SET status = 'used', updated_at = ? WHERE id = ?", ts, row.id);
  const fresh = db.get(`${SELECT_SQL} WHERE e.id = ?`, row.id);
  return { entitlement: publicEntitlement(fresh), idempotent: false, verifiedAt: ts };
}

module.exports = {
  ENTITLEMENT_STATUS_TEXT,
  TYPE_TEXT,
  publicEntitlement,
  grantOrder,
  revokeOrder,
  subscribe,
  listMine,
  getMine,
  adminList,
  useEntitlement,
};
