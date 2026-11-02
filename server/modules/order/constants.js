'use strict';
/** 订单/退款共用的状态字典（避免模块间循环依赖） */

const ORDER_STATUS_TEXT = {
  created: '已创建',
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
  processing: '退款中',
  succeeded: '退款成功',
  rejected: '已驳回',
  failed: '出款失败',
};

/** 可申请退款 / 可确认完成的订单状态 */
const PAID_ORDER_STATUSES = ['paid', 'completed', 'partial_refunded'];
const SETTLED_ORDER_STATUSES = ['paid', 'completed', 'refunding', 'refunded', 'partial_refunded'];

function orderStatusText(status) {
  return ORDER_STATUS_TEXT[status] || String(status || '');
}

function refundStatusText(status) {
  return REFUND_STATUS_TEXT[status] || String(status || '');
}

module.exports = {
  ORDER_STATUS_TEXT,
  REFUND_STATUS_TEXT,
  PAID_ORDER_STATUSES,
  SETTLED_ORDER_STATUSES,
  orderStatusText,
  refundStatusText,
};
