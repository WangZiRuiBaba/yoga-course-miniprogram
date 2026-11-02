'use strict';
/** 订单详情：状态 / 明细 / 支付信息 / 权益 / 时间线 / 操作 */
const request = require('../../utils/request.js');
const view = require('../../utils/view.js');
const format = require('../../utils/format.js');
const nav = require('../../utils/nav.js');
const invite = require('../../utils/invite.js');

Page({
  data: {
    loading: true,
    error: '',
    orderNo: '',
    order: null,
    items: [],
    payment: null,
    entitlements: [],
    timeline: [],
    canPay: false,
    canCancel: false,
    canRefund: false,
    paidFlash: false,
    remainText: '',
  },

  onLoad(options) {
    invite.consume(options);
    const orderNo = (options && options.orderNo) || '';
    this.setData({
      orderNo: orderNo,
      paidFlash: !!(options && options.paid),
    });
    if (!orderNo) {
      this.setData({ loading: false, error: '缺少订单号，请从订单列表进入' });
      return;
    }
    this.load();
  },

  onShow() {
    if (this.loadedOnce) this.load();
    this.loadedOnce = true;
  },

  onUnload() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
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
        const ents = (Array.isArray(d.entitlements) ? d.entitlements : []).map(function (e) {
          return view.toEntitlement(e);
        });
        this.setData(
          {
            loading: false,
            order: order,
            items: items,
            payment: d.payment || null,
            entitlements: ents,
            timeline: view.toTimeline(d.timeline),
            canPay: !!d.canPay,
            canCancel: !!d.canCancel,
            canRefund: !!d.canRefund,
          },
          () => {
            this.startTimer(order);
          }
        );
      })
      .catch((err) => {
        this.setData({ loading: false, error: (err && err.message) || '订单加载失败' });
      });
  },

  startTimer(order) {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!order || order.status !== 'pending' || !order.expireAt) return;
    const self = this;
    const tick = function () {
      const left = format.remainMs(order.expireAt || '');
      self.setData({ remainText: left > 0 ? format.countdownText(left) : '已超时' });
    };
    tick();
    this.timer = setInterval(tick, 1000);
  },

  onRetry() {
    this.load();
  },

  onPay() {
    nav.go('/pages/pay/pay' + request.pageQuery({ orderNo: this.data.orderNo }));
  },

  onCancel() {
    const self = this;
    wx.showModal({
      title: '取消订单',
      content: '确定要取消这笔订单吗？',
      success(res) {
        if (!res.confirm) return;
        request
          .post('/api/orders/' + self.data.orderNo + '/cancel', { reason: '用户主动取消' })
          .then(function () {
            request.toast('订单已取消');
            self.load();
          })
          .catch(function () {
            /* request 已 toast */
          });
      },
    });
  },

  onConfirm() {
    const self = this;
    wx.showModal({
      title: '确认完成',
      content: '确认课程已经上完并完成订单？',
      success(res) {
        if (!res.confirm) return;
        request
          .post('/api/orders/' + self.data.orderNo + '/confirm', {})
          .then(function () {
            request.toast('订单已完成');
            self.load();
          })
          .catch(function () {
            /* request 已 toast */
          });
      },
    });
  },

  onRefund() {
    nav.go('/pages/refund/refund' + request.pageQuery({ orderNo: this.data.orderNo }));
  },

  onTapEntitlement(e) {
    const id = e.currentTarget.dataset.id || '';
    if (!id) return;
    nav.go('/pages/ent-detail/ent-detail' + request.pageQuery({ id: id }));
  },

  onTapItem(e) {
    const productId = e.currentTarget.dataset.pid || '';
    if (!productId) return;
    nav.go('/pages/detail/detail' + request.pageQuery({ id: productId }));
  },

  copyOrderNo() {
    const self = this;
    if (typeof wx === 'undefined' || typeof wx.setClipboardData !== 'function') return;
    wx.setClipboardData({
      data: this.data.orderNo,
      success() {
        request.toast('订单号已复制');
      },
      fail() {
        self.setData({});
      },
    });
  },

  goService() {
    nav.go('/pages/service/service');
  },
});
