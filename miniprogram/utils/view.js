'use strict';
/**
 * 视图模型归一化：把后端 camelCase 响应转成模板友好的结构。
 * 只做字段补全与文案映射，金额一律走 format.moneyText(xxxText, xxxCents)。
 */
const config = require('./config.js');
const format = require('./format.js');

const CARD_TYPE_TEXT = {
  product: '课程推荐',
  order: '订单',
  pay: '收银台',
  refund: '退款',
  entitlement: '已开通',
  text: '消息',
};

/** 商品卡（/api/products、/api/home 里的 productCard） */
function toProduct(raw) {
  const p = raw || {};
  const goalTags = Array.isArray(p.goalTags) ? p.goalTags : [];
  const badges = Array.isArray(p.badges) ? p.badges : [];
  return {
    id: p.id || '',
    title: format.textOr(p.title, '未命名课程'),
    subtitle: format.textOr(p.subtitle),
    cover: config.mediaUrl(p.cover || (p.id ? '/api/media/cover/' + p.id : '')),
    type: format.textOr(p.type, 'online'),
    typeText: format.productTypeText(p.type),
    goalTags: goalTags,
    priceCents: typeof p.priceCents === 'number' ? p.priceCents : 0,
    priceText: format.moneyText(p.priceText, p.priceCents),
    originalPriceText: format.moneyText(p.originalPriceText, p.originalPriceCents, ''),
    discountText: format.textOr(p.discountText),
    stock: typeof p.stock === 'number' ? p.stock : null,
    soldOut: typeof p.stock === 'number' && p.stock <= 0,
    sales: p.sales || 0,
    teacher: format.textOr(p.teacher),
    durationMin: p.durationMin || 0,
    durationText: p.durationMin ? p.durationMin + ' 分钟' : '',
    schedule: format.textOr(p.schedule),
    badges: badges,
  };
}

function toProductDetail(raw) {
  const p = raw || {};
  const base = toProduct(p);
  return Object.assign(base, {
    detailHtml: format.absoluteHtml(p.detailHtml),
    faq: toFaq(p.faq),
    related: [],
  });
}

/** FAQ 兼容 {q,a} 与 {question,answer} 两种写法 */
function toFaq(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  list.forEach(function (item, index) {
    if (!item || typeof item !== 'object') return;
    const q = item.q || item.question || item.title || '';
    const a = item.a || item.answer || item.content || '';
    if (!q && !a) return;
    out.push({ key: 'faq-' + index, q: String(q), a: String(a), open: false });
  });
  return out;
}

function toSku(raw) {
  const s = raw || {};
  return {
    id: s.id || '',
    productId: s.productId || '',
    name: format.textOr(s.name, '默认规格'),
    spec: format.textOr(s.spec),
    priceCents: typeof s.priceCents === 'number' ? s.priceCents : 0,
    priceText: format.moneyText(s.priceText, s.priceCents),
    stock: typeof s.stock === 'number' ? s.stock : null,
    soldOut: typeof s.stock === 'number' && s.stock <= 0,
  };
}

/** 订单（order 结构） */
function toOrder(raw) {
  const o = raw || {};
  const status = format.textOr(o.status);
  return {
    id: o.id || '',
    orderNo: o.orderNo || o.id || '',
    status: status,
    statusText: format.statusText(status),
    totalText: format.moneyText(o.totalText, o.totalCents),
    paidText: format.moneyText(o.paidText, o.paidCents, ''),
    refundedText: format.moneyText(o.refundedText, o.refundedCents, ''),
    itemsCount: o.itemsCount || 0,
    productTitles: format.textOr(o.productTitles),
    remark: format.textOr(o.remark),
    sourceText: o.source === 'miniprogram' ? '小程序' : o.source === 'h5' ? 'H5' : o.source === 'ai' ? 'AI 商城' : '',
    createdAtText: format.timeText(o.createdAt),
    paidAtText: format.timeText(o.paidAt),
    expireAt: o.expireAt || '',
    expireAtText: format.timeText(o.expireAt),
    expireCountdown: status === 'pending' ? format.countdownText(o.expireAt) : '',
    // 列表接口只给 order 结构，没有 canPay 等布尔位时按状态推导
    canPay: o.canPay === undefined ? status === 'pending' : !!o.canPay,
    canCancel: o.canCancel === undefined ? status === 'pending' : !!o.canCancel,
    canRefund:
      o.canRefund === undefined
        ? status === 'paid' || status === 'completed' || status === 'partial_refunded'
        : !!o.canRefund,
    refundable: o.canRefund === undefined ? status === 'paid' || status === 'completed' : !!o.canRefund,
  };
}

function toOrderItem(raw) {
  const it = raw || {};
  const cover = it.cover || (it.productId ? '/api/media/cover/' + it.productId : '');
  return {
    id: it.id || it.productId || '',
    productId: it.productId || '',
    skuId: it.skuId || '',
    title: format.textOr(it.title, '课程'),
    skuName: format.textOr(it.skuName || it.spec),
    cover: config.mediaUrl(cover),
    quantity: it.quantity || 1,
    priceText: format.moneyText(it.priceText, it.priceCents),
    subtotalText: format.moneyText(it.subtotalText, it.subtotalCents, ''),
    remark: format.textOr(it.remark),
  };
}

/** 权益（我的课程） */
function toEntitlement(raw) {
  const e = raw || {};
  const status = format.textOr(e.status, 'active');
  return {
    id: e.id || '',
    productId: e.productId || '',
    title: format.textOr(e.title, '课程'),
    cover: config.mediaUrl(e.cover || (e.productId ? '/api/media/cover/' + e.productId : '')),
    type: format.textOr(e.type, 'online'),
    typeText: format.productTypeText(e.type),
    verifyCode: format.textOr(e.verifyCode),
    grantedAtText: format.timeText(e.grantedAt),
    expiresAtText: e.expiresAt ? format.dateText(e.expiresAt) : '长期有效',
    statusText: format.entitlementStatusText(status),
    status: status,
    orderNo: format.textOr(e.orderNo),
    notice: format.textOr(e.notice),
    contentHtml: format.absoluteHtml(e.contentHtml || e.noticeHtml || ''),
  };
}

/** 退款单 */
function toRefund(raw) {
  const r = raw || {};
  const status = format.textOr(r.status, 'pending');
  return {
    refundNo: r.refundNo || '',
    orderNo: r.orderNo || '',
    status: status,
    statusText: format.refundStatusText(status),
    amountText: format.moneyText(r.amountText, r.amountCents),
    reason: format.textOr(r.reason),
    message: format.textOr(r.message),
    nextAction: format.textOr(r.nextAction),
    createdAtText: format.timeText(r.createdAt),
    refundedAtText: format.timeText(r.refundedAt),
  };
}

/** 时间线 */
function toTimeline(list) {
  if (!Array.isArray(list)) return [];
  return list.map(function (item, index) {
    const t = item || {};
    const status = t.status || '';
    return {
      key: 'tl-' + index,
      label: format.textOr(t.title || t.label || t.statusText, format.statusText(status) || '进度'),
      timeText: format.timeText(t.at || t.createdAt || t.time || t.updatedAt),
      note: format.textOr(t.note || t.remark || t.desc),
    };
  });
}

/** AI 卡片归一化（product/order/pay/refund/entitlement/text） */
function toAiCard(raw) {
  const c = raw || {};
  const type = format.textOr(c.type, 'text');
  return {
    type: type,
    typeText: CARD_TYPE_TEXT[type] || '',
    productId: c.productId || '',
    title: format.textOr(c.title),
    subtitle: format.textOr(c.subtitle),
    cover: config.mediaUrl(c.cover || (c.productId ? '/api/media/cover/' + c.productId : '')),
    priceText: format.moneyText(c.priceText, c.priceCents, ''),
    tags: Array.isArray(c.tags) ? c.tags : [],
    orderNo: c.orderNo || '',
    statusText: format.textOr(c.statusText, format.statusText(c.status)),
    totalText: format.moneyText(c.totalText, c.totalCents, ''),
    outTradeNo: c.outTradeNo || '',
    amountText: format.moneyText(c.amountText, c.amountCents, ''),
    refundNo: c.refundNo || '',
    verifyCode: format.textOr(c.verifyCode),
    message: format.textOr(c.message),
    provider: format.textOr(c.provider),
    mock: !!c.mock,
    payExpireText: c.payExpireAt ? format.timeText(c.payExpireAt) : '',
    content: format.textOr(c.content || c.text),
  };
}

/** AI 消息（历史 role/content/cards/actions 与实时 reply 都能喂进来） */
function toAiMessage(raw, index) {
  const m = raw || {};
  const role = m.role === 'user' ? 'user' : 'assistant';
  const cards = Array.isArray(m.cards) ? m.cards.map(toAiCard) : [];
  const actions = Array.isArray(m.actions)
    ? m.actions.map(function (a, i) {
        const act = a || {};
        return {
          key: 'act-' + index + '-' + i,
          label: format.textOr(act.label, '操作'),
          action: format.textOr(act.action),
          payload: act.payload || {},
        };
      })
    : [];
  return {
    key: 'msg-' + index + '-' + (m.createdAt || ''),
    role: role,
    mine: role === 'user',
    content: format.textOr(m.content),
    cards: cards,
    actions: actions,
    timeText: format.clockText(m.createdAt),
  };
}

/** 客服消息 */
function toServiceMessage(raw, index) {
  const m = raw || {};
  const senderType = format.textOr(m.senderType, 'system');
  return {
    key: 'svc-' + index + '-' + (m.id || m.createdAt || ''),
    id: m.id || '',
    senderType: senderType,
    senderText: format.senderText(senderType),
    mine: senderType === 'user',
    content: format.textOr(m.content),
    timeText: format.clockText(m.createdAt),
    createdAt: m.createdAt || '',
  };
}

module.exports = {
  CARD_TYPE_TEXT: CARD_TYPE_TEXT,
  toProduct: toProduct,
  toProductDetail: toProductDetail,
  toFaq: toFaq,
  toSku: toSku,
  toOrder: toOrder,
  toOrderItem: toOrderItem,
  toEntitlement: toEntitlement,
  toRefund: toRefund,
  toTimeline: toTimeline,
  toAiCard: toAiCard,
  toAiMessage: toAiMessage,
  toServiceMessage: toServiceMessage,
};
