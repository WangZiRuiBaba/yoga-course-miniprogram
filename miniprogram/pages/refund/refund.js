'use strict';
/** 申请退款：可退金额校验 / 原因选择 / 结果提示 / 退款记录 */
const request = require('../../utils/request.js');
const view = require('../../utils/view.js');
const nav = require('../../utils/nav.js');
const invite = require('../../utils/invite.js');

const REASONS = [
  { key: 'plan_changed', label: '计划有变，暂时上不了' },
  { key: 'time_conflict', label: '时间冲突排不开' },
  { key: 'not_expected', label: '课程与预期不符' },
  { key: 'body_unfit', label: '身体原因不便练习' },
  { key: 'other', label: '其他原因' },
];

/** 元字符串 → 分（不经过浮点运算） */
function yuanToCents(input) {
  const text = String(input || '').trim();
  if (!text) return 0;
  if (!/^\d+(\.\d{0,2})?$/.test(text)) return -1;
  const parts = text.split('.');
  const yuan = parseInt(parts[0] || '0', 10);
  let fen = 0;
  if (parts.length > 1) {
    const frac = (parts[1] + '00').slice(0, 2);
    fen = parseInt(frac, 10);
  }
  return yuan * 100 + fen;
}

function centsToYuan(cents) {
  const c = Number(cents) || 0;
  const yuan = Math.floor(c / 100);
  const fen = c % 100;
  return yuan + '.' + (fen < 10 ? '0' + fen : String(fen));
}

Page({
  data: {
    loading: true,
    error: '',
    orderNo: '',
    order: null,
    refundableCents: 0,
    refundableText: '0.00',
    partial: false,
    amountYuan: '',
    reasonType: '',
    reason: '',
    reasons: REASONS,
    submitting: false,
    result: null,
    refunds: [],
    loadingRefunds: false,
  },

  onLoad(options) {
    invite.consume(options);
    const orderNo = (options && options.orderNo) || '';
    this.setData({ orderNo: orderNo });
    if (!orderNo) {
      this.setData({ loading: false, error: '缺少订单号，请从订单详情进入' });
      return;
    }
    this.load();
    this.loadRefunds();
  },

  onPullDownRefresh() {
    Promise.all([this.load(), this.loadRefunds()]).then(
      function () {
        wx.stopPullDownRefresh();
      },
      function () {
        wx.stopPullDownRefresh();
      }
    );
  },

  load() {
    this.setData({ loading: true, error: '' });
    return request
      .get('/api/orders/' + this.data.orderNo)
      .then((data) => {
        const d = data || {};
        const order = view.toOrder(d.order || {});
        const paid = typeof d.order.paidCents === 'number' ? d.order.paidCents : 0;
        const refunded = typeof d.order.refundedCents === 'number' ? d.order.refundedCents : 0;
        const refundable = d.order.refundableCents !== undefined ? Number(d.order.refundableCents) : paid - refunded;
        const cents = refundable > 0 ? refundable : 0;
        this.setData({
          loading: false,
          order: order,
          refundableCents: cents,
          refundableText: centsToYuan(cents),
          amountYuan: centsToYuan(cents),
        });
      })
      .catch((err) => {
        this.setData({ loading: false, error: (err && err.message) || '订单信息加载失败' });
      });
  },

  loadRefunds() {
    this.setData({ loadingRefunds: true });
    return request
      .get('/api/refunds', { page: 1, size: 20 }, { silent: true })
      .then((data) => {
        const d = data || {};
        const rows = Array.isArray(d.list) ? d.list : Array.isArray(d) ? d : [];
        const mine = rows
          .filter((r) => (r && r.orderNo) === this.data.orderNo)
          .map(function (r) {
            return view.toRefund(r);
          });
        this.setData({ loadingRefunds: false, refunds: mine });
      })
      .catch(() => {
        this.setData({ loadingRefunds: false });
      });
  },

  onRetry() {
    this.load();
    this.loadRefunds();
  },

  onTogglePartial() {
    const partial = !this.data.partial;
    this.setData({
      partial: partial,
      amountYuan: partial ? '' : centsToYuan(this.data.refundableCents),
    });
  },

  onAmountInput(e) {
    this.setData({ amountYuan: e.detail.value });
  },

  onPickReason(e) {
    const key = e.currentTarget.dataset.key || '';
    const found = REASONS.filter(function (r) {
      return r.key === key;
    })[0];
    this.setData({ reasonType: key, reason: found ? found.label : '' });
  },

  onReasonInput(e) {
    this.setData({ reason: e.detail.value });
  },

  onSubmit() {
    if (this.data.submitting) return;
    if (!this.data.reason) {
      request.toast('请选择或填写退款原因');
      return;
    }
    const payload = { reason: String(this.data.reason).slice(0, 200) };
    if (this.data.reasonType) payload.reasonType = this.data.reasonType;
    // 后端要求 amountCents 必填（>=1），全额退款也要显式传可退金额
    if (this.data.partial) {
      const cents = yuanToCents(this.data.amountYuan);
      if (cents <= 0) {
        request.toast('请输入正确的退款金额');
        return;
      }
      if (cents > this.data.refundableCents) {
        request.toast('退款金额不能超过可退金额 ¥' + this.data.refundableText);
        return;
      }
      payload.amountCents = cents;
    } else {
      if (!this.data.refundableCents || this.data.refundableCents < 1) {
        request.toast('当前订单没有可退金额');
        return;
      }
      payload.amountCents = this.data.refundableCents;
    }

    this.setData({ submitting: true });
    request
      .post('/api/orders/' + this.data.orderNo + '/refund', payload)
      .then((data) => {
        const d = data || {};
        const result = view.toRefund(d);
        this.setData({ submitting: false, result: result });
        this.loadRefunds();
        if (result.nextAction === 'none') request.toast('退款已到账');
        else if (result.nextAction === 'wait_review') request.toast('已提交，等待商家审核');
        else request.toast('已提交，请留意客服消息');
      })
      .catch((err) => {
        this.setData({ submitting: false });
        const code = err && err.code;
        if (code === 'INVALID_STATE') request.toast('当前订单状态不支持退款');
        else if (code === 'VALIDATION_ERROR') request.toast((err && err.message) || '退款金额不合法');
      });
  },

  goOrder() {
    nav.go('/pages/order-detail/order-detail' + request.pageQuery({ orderNo: this.data.orderNo }));
  },

  goService() {
    nav.go('/pages/service/service');
  },
});
