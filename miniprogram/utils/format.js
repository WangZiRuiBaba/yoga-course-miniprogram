'use strict';
/**
 * 展示层格式化：只做时间格式化与状态文案映射。
 * 金额一律原样使用后端 xxxText（priceText / totalText / amountText ...），此处不做任何除法。
 */
const config = require('./config.js');

const ORDER_STATUS = {
  pending: '待支付',
  paid: '已支付',
  completed: '已完成',
  cancelled: '已取消',
  refunding: '退款中',
  refunded: '已退款',
  partial_refunded: '部分退款',
};

const REFUND_STATUS = {
  pending: '待审核',
  processing: '退款中',
  succeeded: '已退款',
  rejected: '已驳回',
  failed: '退款失败',
};

const PAY_STATUS = {
  pending: '待支付',
  success: '支付成功',
  succeeded: '支付成功',
  paid: '支付成功',
  failed: '支付失败',
  closed: '已关闭',
  refunded: '已退款',
};

const ENTITLEMENT_STATUS = {
  active: '有效',
  granted: '有效',
  expired: '已过期',
  revoked: '已失效',
  pending: '待生效',
};

const PRODUCT_TYPE = {
  online: '线上课',
  offline: '到店课',
  membership: '会员卡',
};

const SENDER_TYPE = {
  user: '我',
  admin: '客服',
  system: '系统',
  ai: 'AI 顾问',
};

const WITHDRAW_STATUS = {
  pending: '待审核',
  approved: '已通过',
  rejected: '已驳回',
  paid: '已打款',
};

const COMMISSION_STATUS = {
  pending: '冻结中',
  available: '可提现',
  reversed: '已冲正',
  cancelled: '已取消',
};

function pad(value) {
  return value < 10 ? '0' + value : String(value);
}

function toDate(iso) {
  if (!iso) return null;
  const text = String(iso);
  const date = new Date(text);
  if (!isNaN(date.getTime())) return date;
  const fallback = new Date(text.replace(/-/g, '/').replace('T', ' ').replace(/\.\d+Z?$/, ''));
  return isNaN(fallback.getTime()) ? null : fallback;
}

/** 2026-11-02 21:30 */
function timeText(iso) {
  const d = toDate(iso);
  if (!d) return '';
  return (
    d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
  );
}

/** 11-02 21:30 */
function shortTimeText(iso) {
  const d = toDate(iso);
  if (!d) return '';
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** 21:30 */
function clockText(iso) {
  const d = toDate(iso);
  if (!d) return '';
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** 2026-11-02 */
function dateText(iso) {
  const d = toDate(iso);
  if (!d) return '';
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function timestamp(iso) {
  const d = toDate(iso);
  return d ? d.getTime() : 0;
}

/** 距离过期还剩多少毫秒（已过期返回 0） */
function remainMs(expireAt) {
  const d = toDate(expireAt);
  if (!d) return 0;
  const diff = d.getTime() - Date.now();
  return diff > 0 ? diff : 0;
}

/** 01:23 形式的倒计时文案 */
function countdownText(expireAt) {
  const ms = remainMs(expireAt);
  if (!ms) return '';
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return hours + ' 小时 ' + (minutes % 60) + ' 分';
  }
  return pad(minutes) + ':' + pad(seconds);
}

function statusText(status) {
  return ORDER_STATUS[status] || status || '';
}

function refundStatusText(status) {
  return REFUND_STATUS[status] || status || '';
}

function payStatusText(status) {
  return PAY_STATUS[status] || status || '';
}

function entitlementStatusText(status) {
  return ENTITLEMENT_STATUS[status] || status || '';
}

function productTypeText(type) {
  return PRODUCT_TYPE[type] || '课程';
}

function senderText(type) {
  return SENDER_TYPE[type] || '对方';
}

function withdrawStatusText(status) {
  return WITHDRAW_STATUS[status] || status || '';
}

function commissionStatusText(status) {
  return COMMISSION_STATUS[status] || status || '';
}

/**
 * 金额展示：优先用后端返回的 xxxText（priceText/totalText/amountText...）。
 * 仅当后端漏了该字段时，用字符串切分兜底（不做浮点除法，避免 0.1+0.2 那种误差）。
 * @param {string} text 后端 xxxText
 * @param {number} cents 后端 xxxCents（兜底用）
 */
function moneyText(text, cents, fallback) {
  if (text !== undefined && text !== null && text !== '') return String(text);
  if (cents !== undefined && cents !== null && cents !== '') {
    const n = Math.round(Number(cents));
    if (isFinite(n)) {
      let digits = String(Math.abs(n));
      while (digits.length < 3) digits = '0' + digits;
      return (n < 0 ? '-' : '') + digits.slice(0, -2) + '.' + digits.slice(-2);
    }
  }
  return fallback === undefined ? '—' : fallback;
}

function safeList(value) {
  return Array.isArray(value) ? value : [];
}

function textOr(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback || '';
  return String(value);
}

/** 把后端 detailHtml 里的相对 img src 补全为绝对地址（rich-text 不认相对路径） */
function absoluteHtml(html) {
  const text = String(html || '');
  if (!text) return '';
  const base = config.baseUrl();
  return text.replace(/src=(["'])(\/[^"']+)\1/g, function (all, quote, src) {
    return 'src=' + quote + base + src + quote;
  });
}

module.exports = {
  pad: pad,
  toDate: toDate,
  timeText: timeText,
  shortTimeText: shortTimeText,
  clockText: clockText,
  dateText: dateText,
  timestamp: timestamp,
  remainMs: remainMs,
  countdownText: countdownText,
  statusText: statusText,
  refundStatusText: refundStatusText,
  payStatusText: payStatusText,
  entitlementStatusText: entitlementStatusText,
  productTypeText: productTypeText,
  senderText: senderText,
  withdrawStatusText: withdrawStatusText,
  commissionStatusText: commissionStatusText,
  moneyText: moneyText,
  safeList: safeList,
  textOr: textOr,
  absoluteHtml: absoluteHtml,
  ORDER_STATUS: ORDER_STATUS,
  REFUND_STATUS: REFUND_STATUS,
};
