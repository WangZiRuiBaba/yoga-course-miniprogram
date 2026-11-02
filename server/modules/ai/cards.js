'use strict';
/**
 * AI 卡片 / 动作按钮工厂。
 * 字段与 docs/API.md §10 对齐：
 *   卡片 type: product | order | pay | refund | entitlement | text
 *   动作 action: create_order | pay_order | mock_pay | refund_order |
 *               open_product | open_orders | open_service | bind_invite | open_dist
 */
const { centsToYuanString } = require('../../utils/money');

const ORDER_STATUS_TEXT = {
  created: '待支付',
  pending: '待支付',
  paid: '已支付',
  completed: '已完成',
  cancelled: '已取消',
  refunding: '退款中',
  refunded: '已退款',
  partial_refunded: '部分退款',
};

const REFUND_STATUS_TEXT = {
  pending: '待审核',
  approved: '已通过',
  processing: '退款中',
  succeeded: '退款成功',
  rejected: '已驳回',
  failed: '退款失败',
};

const ENTITLEMENT_STATUS_TEXT = {
  active: '有效',
  revoked: '已失效',
  expired: '已过期',
};

const PRODUCT_TYPE_TEXT = {
  online: '线上课程',
  offline: '到店课程',
  membership: '会员卡',
};

function yuan(cents) {
  return centsToYuanString(cents);
}

function splitTags(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 折扣文案：19900 / 39900 → "5.0 折" */
function discountOf(priceCents, originalPriceCents) {
  const price = Number(priceCents || 0);
  const origin = Number(originalPriceCents || 0);
  if (price <= 0 || origin <= price) return '';
  return `${((price / origin) * 10).toFixed(1)} 折`;
}

function orderStatusText(status) {
  return ORDER_STATUS_TEXT[status] || '处理中';
}

function refundStatusText(status) {
  return REFUND_STATUS_TEXT[status] || '处理中';
}

function entitlementStatusText(status) {
  return ENTITLEMENT_STATUS_TEXT[status] || '处理中';
}

function productTypeText(type) {
  return PRODUCT_TYPE_TEXT[type] || '课程';
}

/* ------------------------------- 卡片 ------------------------------- */

function textCard(text) {
  return { type: 'text', text: String(text === null || text === undefined ? '' : text) };
}

/** products 表行 → product 卡片 */
function productCard(row) {
  if (!row) return null;
  const tags = splitTags(row.goal_tags);
  return {
    type: 'product',
    productId: row.id,
    title: row.title,
    subtitle: row.subtitle || '',
    cover: row.cover || `/api/media/cover/${row.id}`,
    productType: row.type,
    typeText: productTypeText(row.type),
    goalTags: tags,
    tags,
    priceCents: Number(row.price_cents || 0),
    priceText: yuan(row.price_cents),
    originalPriceCents: Number(row.original_price_cents || 0),
    originalPriceText: yuan(row.original_price_cents),
    discountText: discountOf(row.price_cents, row.original_price_cents),
    stock: Number(row.stock || 0),
    sales: Number(row.sales || 0),
    teacher: row.teacher || '',
    durationMin: Number(row.duration_min || 0),
    schedule: row.schedule || '',
  };
}

/** orders 表行 → order 卡片 */
function orderCard(row, extra = {}) {
  if (!row) return null;
  return {
    type: 'order',
    orderNo: row.order_no,
    orderId: row.id,
    status: row.status,
    statusText: orderStatusText(row.status),
    totalCents: Number(row.total_cents || 0),
    totalText: yuan(row.total_cents),
    paidCents: Number(row.paid_cents || 0),
    paidText: yuan(row.paid_cents),
    refundedCents: Number(row.refunded_cents || 0),
    refundedText: yuan(row.refunded_cents),
    payExpireAt: row.expire_at || null,
    paidAt: row.paid_at || null,
    createdAt: row.created_at,
    ...extra,
  };
}

/** 收银台卡片 */
function payCard(input) {
  const data = input || {};
  const amountCents = Number(data.amountCents || 0);
  return {
    type: 'pay',
    orderNo: data.orderNo || null,
    outTradeNo: data.outTradeNo || null,
    provider: data.provider || 'mock',
    mock: !!data.mock,
    amountCents,
    amountText: yuan(amountCents),
    payParams: data.payParams || null,
    tip: data.mock ? '模拟支付：点「我已支付」立即到账' : '请在小程序内完成支付',
  };
}

/** 退款卡片 */
function refundCard(input) {
  const data = input || {};
  const amountCents = Number(data.amountCents || 0);
  return {
    type: 'refund',
    refundNo: data.refundNo || null,
    orderNo: data.orderNo || null,
    status: data.status || 'pending',
    statusText: refundStatusText(data.status),
    amountCents,
    amountText: yuan(amountCents),
    autoApproved: !!data.autoApproved,
    nextAction: data.nextAction || 'wait_review',
    message: data.message || '',
    createdAt: data.createdAt || null,
  };
}

/** 已开通课程卡片（含核销码） */
function entitlementCard(row) {
  if (!row) return null;
  return {
    type: 'entitlement',
    entitlementId: row.id,
    productId: row.product_id,
    title: row.title || '已开通课程',
    cover: row.cover || '',
    productType: row.product_type || row.type || 'online',
    typeText: productTypeText(row.product_type || row.type),
    verifyCode: row.verify_code || '',
    status: row.status || 'active',
    statusText: entitlementStatusText(row.status),
    orderNo: row.order_no || null,
    grantedAt: row.created_at || null,
    expiresAt: row.expires_at || null,
  };
}

/* ------------------------------ 动作按钮 ------------------------------ */

function btnCreateOrder(productId) {
  return { label: '立即下单', action: 'create_order', payload: { productId: productId || null } };
}

function btnOpenProduct(productId, label = '看看详情') {
  return { label, action: 'open_product', payload: { productId: productId || null } };
}

function btnPayOrder(orderNo) {
  return { label: '去支付', action: 'pay_order', payload: { orderNo: orderNo || null } };
}

function btnMockPay(payload) {
  return {
    label: '我已支付',
    action: 'mock_pay',
    payload: { orderNo: (payload && payload.orderNo) || null, outTradeNo: (payload && payload.outTradeNo) || null },
  };
}

function btnRefund(orderNo) {
  return { label: '一键退款', action: 'refund_order', payload: { orderNo: orderNo || null } };
}

function btnOpenOrders() {
  return { label: '我的订单', action: 'open_orders', payload: {} };
}

function btnOpenService(conversationId) {
  return { label: '联系客服', action: 'open_service', payload: { conversationId: conversationId || null } };
}

function btnOpenDist() {
  return { label: '分销中心', action: 'open_dist', payload: {} };
}

function btnBindInvite(inviteCode) {
  return { label: `绑定邀请码 ${inviteCode}`, action: 'bind_invite', payload: { inviteCode } };
}

module.exports = {
  ORDER_STATUS_TEXT,
  REFUND_STATUS_TEXT,
  ENTITLEMENT_STATUS_TEXT,
  PRODUCT_TYPE_TEXT,
  yuan,
  splitTags,
  discountOf,
  orderStatusText,
  refundStatusText,
  entitlementStatusText,
  productTypeText,
  textCard,
  productCard,
  orderCard,
  payCard,
  refundCard,
  entitlementCard,
  btnCreateOrder,
  btnOpenProduct,
  btnPayOrder,
  btnMockPay,
  btnRefund,
  btnOpenOrders,
  btnOpenService,
  btnOpenDist,
  btnBindInvite,
};
