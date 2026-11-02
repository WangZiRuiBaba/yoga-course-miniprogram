'use strict';
/** 收银台：发起支付（mock / wxpay）+ 轮询支付结果 + 倒计时 */
const request = require('../../utils/request.js');
const view = require('../../utils/view.js');
const format = require('../../utils/format.js');
const nav = require('../../utils/nav.js');
const invite = require('../../utils/invite.js');
const platform = require('../../utils/platform.js');

const SUCCESS_STATUS = ['success', 'succeeded', 'paid', 'SUCCESS', 'TRADE_SUCCESS', 'settled'];

Page({
  data: {
    loading: true,
    error: '',
    orderNo: '',
    order: null,
    orderItems: [],
    canPay: true,
    paid: false,
    paying: false,
    waiting: false,
    mock: false,
    provider: '',
    outTradeNo: '',
    mockTip: '',
    payParams: null,
    expireText: '',
    polling: false,
  },

  onLoad(options) {
    invite.consume(options);
    const orderNo = (options && options.orderNo) || '';
    this.setData({ orderNo: orderNo });
    if (orderNo && platform.guardPay({ back: true })) return;
    if (!orderNo) {
      this.setData({ loading: false, error: '缺少订单号，请从订单列表进入' });
      return;
    }
    this.load();
  },

  onUnload() {
    this.stopTimer();
  },

  onHide() {
    this.stopTimer();
  },

  onPullDownRefresh() {
    this.load().then(
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
        const items = (Array.isArray(d.items) ? d.items : []).map(function (it) {
          return view.toOrderItem(it);
        });
        const paid = order.status === 'paid' || order.status === 'completed';
        this.setData({
          loading: false,
          order: order,
          orderItems: items,
          canPay: !!d.canPay,
          paid: paid,
        });
        this.startTimer(order);
      })
      .catch((err) => {
        this.setData({ loading: false, error: (err && err.message) || '订单信息加载失败' });
      });
  },

  startTimer(order) {
    this.stopTimer();
    if (!order || !order.expireAt) return;
    const self = this;
    const tick = function () {
      const left = format.remainMs(order.expireAt);
      if (left <= 0) {
        self.setData({ expireText: '支付已超时' });
        self.stopTimer();
        return;
      }
      self.setData({ expireText: format.countdownText(left) });
    };
    tick();
    this.timer = setInterval(tick, 1000);
  },

  stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  onRetry() {
    this.load();
  },

  /** 发起支付 */
  onPay() {
    if (this.data.paying || this.data.paid) return;
    this.setData({ paying: true });
    request
      .post('/api/orders/' + this.data.orderNo + '/pay', {})
      .then((data) => {
        const d = data || {};
        const payParams = d.payParams || {};
        const provider = d.provider || payParams.provider || 'mock';
        const outTradeNo = payParams.outTradeNo || (d.payment && d.payment.outTradeNo) || '';
        const isMock = provider === 'mock' || payParams.mock === true || d.mock === true;
        this.setData({
          paying: false,
          provider: provider,
          payParams: payParams,
          outTradeNo: outTradeNo,
          mock: isMock,
          mockTip: payParams.message || '模拟支付：点击「我已支付」即成功',
        });
        if (isMock) {
          this.setData({ waiting: true });
          this.pollStatus(0);
        } else {
          this.requestWxPayment();
        }
      })
      .catch((err) => {
        this.setData({ paying: false });
        if (err && err.code === 'INVALID_STATE') request.toast('订单当前状态不可支付');
      });
  },

  requestWxPayment() {
    const params = this.data.payParams || {};
    const self = this;
    if (typeof wx === 'undefined' || typeof wx.requestPayment !== 'function') {
      request.toast('当前环境不支持微信支付');
      return;
    }
    wx.requestPayment({
      timeStamp: params.timeStamp,
      nonceStr: params.nonceStr,
      package: params.package,
      signType: params.signType || 'RSA',
      paySign: params.paySign,
      success() {
        self.setData({ waiting: true });
        self.pollStatus(0);
      },
      fail(err2) {
        const msg = (err2 && err2.errMsg) || '';
        if (msg.indexOf('cancel') >= 0) request.toast('已取消支付');
        else request.toast('支付失败，请重试');
        self.setData({ paying: false });
      },
    });
  },

  /** 模拟支付：手动确认 */
  onMockPaid() {
    if (!this.data.outTradeNo) {
      request.toast('支付单号缺失，请重新发起支付');
      return;
    }
    this.setData({ paying: true });
    request
      .post('/api/pay/mock-notify', { outTradeNo: this.data.outTradeNo, success: true }, { silent: true })
      .then(() => {
        this.setData({ paying: false, waiting: true });
        this.pollStatus(0);
      })
      .catch((err) => {
        this.setData({ paying: false });
        request.toast((err && err.message) || '确认支付失败，请重试');
      });
  },

  /** 轮询支付状态：最多约 20 次，每次 800ms */
  pollStatus(attempt) {
    if (this.data.polling && attempt === 0) return;
    if (!this.data.outTradeNo || attempt > 20) {
      this.setData({ polling: false, waiting: false });
      if (attempt > 20) request.toast('支付结果确认超时，请稍后在订单列表查看');
      return;
    }
    if (attempt === 0) this.setData({ polling: true });
    const self = this;
    request
      .get('/api/pay/status/' + this.data.outTradeNo, null, { silent: true })
      .then((data) => {
        const d = data || {};
        const status = String(d.status || '');
        const orderStatus = String(d.orderStatus || '');
        if (SUCCESS_STATUS.indexOf(status) >= 0 || orderStatus === 'paid' || orderStatus === 'completed') {
          self.stopTimer();
          self.setData({ polling: false, waiting: false, paid: true, canPay: false, paying: false });
          request.toast('支付成功');
          setTimeout(function () {
            nav.replace('/pages/order-detail/order-detail' + request.pageQuery({ orderNo: self.data.orderNo, paid: 1 }));
          }, 600);
          return;
        }
        if (status === 'closed' || status === 'failed' || orderStatus === 'cancelled') {
          self.setData({ polling: false, waiting: false, paying: false });
          request.toast('支付已关闭，请重新下单');
          return;
        }
        setTimeout(function () {
          self.pollStatus(attempt + 1);
        }, 800);
      })
      .catch(function () {
        setTimeout(function () {
          self.pollStatus(attempt + 1);
        }, 1200);
      });
  },

  goOrders() {
    nav.go('/pages/order-detail/order-detail' + request.pageQuery({ orderNo: this.data.orderNo }));
  },

  goEntitlements() {
    nav.go('/pages/entitlements/entitlements');
  },

  goService() {
    nav.go('/pages/service/service');
  },

  onCancelOrder() {
    const self = this;
    if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') return;
    wx.showModal({
      title: '取消订单',
      content: '确定要取消这笔订单吗？',
      success(res) {
        if (!res.confirm) return;
        request
          .post('/api/orders/' + self.data.orderNo + '/cancel', { reason: '用户主动取消' })
          .then(function () {
            request.toast('订单已取消');
            nav.replace('/pages/orders/orders');
          })
          .catch(function () {
            /* request 已 toast */
          });
      },
    });
  },
});
