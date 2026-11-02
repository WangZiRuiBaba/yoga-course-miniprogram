'use strict';
/** 订单列表：状态筛选 + 翻页 + 快捷操作 */
const request = require('../../utils/request.js');
const view = require('../../utils/view.js');
const nav = require('../../utils/nav.js');
const invite = require('../../utils/invite.js');

const TABS = [
  { key: '', label: '全部' },
  { key: 'pending', label: '待支付' },
  { key: 'paid', label: '已支付' },
  { key: 'completed', label: '已完成' },
  { key: 'refunded', label: '退款' },
];

Page({
  data: {
    loading: true,
    error: '',
    list: [],
    total: 0,
    page: 1,
    size: 10,
    hasMore: false,
    loadingMore: false,
    status: '',
    tabs: TABS,
    emptyText: '还没有订单',
  },

  onLoad(options) {
    invite.consume(options);
    const status = (options && options.status) || '';
    this.setData({ status: status });
    this.load(true);
  },

  onShow() {
    if (this.loadedOnce) this.load(true);
    this.loadedOnce = true;
  },

  onPullDownRefresh() {
    this.load(true).then(
      function () {
        wx.stopPullDownRefresh();
      },
      function () {
        wx.stopPullDownRefresh();
      }
    );
  },

  onReachBottom() {
    if (!this.data.hasMore || this.data.loadingMore || this.data.loading) return;
    this.load(false);
  },

  load(reset) {
    const nextPage = reset ? 1 : this.data.page + 1;
    if (reset) this.setData({ loading: true, error: '' });
    else this.setData({ loadingMore: true });

    const query = { page: nextPage, size: this.data.size };
    if (this.data.status) query.status = this.data.status;

    return request
      .get('/api/orders', query)
      .then((data) => {
        const d = data || {};
        const rows = (Array.isArray(d.list) ? d.list : []).map(function (o) {
          return view.toOrder(o);
        });
        const list = reset ? rows : this.data.list.concat(rows);
        this.setData({
          loading: false,
          loadingMore: false,
          list: list,
          total: d.total || list.length,
          page: d.page || nextPage,
          hasMore: d.hasMore === undefined ? rows.length >= this.data.size : !!d.hasMore,
        });
      })
      .catch((err) => {
        this.setData({
          loading: false,
          loadingMore: false,
          error: reset ? (err && err.message) || '订单加载失败' : '',
        });
        if (!reset) request.toast((err && err.message) || '加载更多失败');
      });
  },

  onRetry() {
    this.load(true);
  },

  onTapTab(e) {
    const key = e.currentTarget.dataset.key === undefined ? '' : e.currentTarget.dataset.key;
    if (key === this.data.status) return;
    this.setData({ status: key, list: [] }, () => {
      this.load(true);
    });
  },

  onTapOrder(e) {
    const orderNo = e.currentTarget.dataset.no || '';
    if (!orderNo) return;
    nav.go('/pages/order-detail/order-detail' + request.pageQuery({ orderNo: orderNo }));
  },

  onPay(e) {
    const orderNo = e.currentTarget.dataset.no || '';
    if (!orderNo) return;
    nav.go('/pages/pay/pay' + request.pageQuery({ orderNo: orderNo }));
  },

  onCancel(e) {
    const orderNo = e.currentTarget.dataset.no || '';
    if (!orderNo) return;
    const self = this;
    wx.showModal({
      title: '取消订单',
      content: '确定要取消这笔订单吗？取消后名额会释放。',
      success(res) {
        if (!res.confirm) return;
        request
          .post('/api/orders/' + orderNo + '/cancel', { reason: '用户主动取消' })
          .then(function () {
            request.toast('订单已取消');
            self.load(true);
          })
          .catch(function () {
            /* request 已 toast */
          });
      },
    });
  },

  onRefund(e) {
    const orderNo = e.currentTarget.dataset.no || '';
    if (!orderNo) return;
    nav.go('/pages/refund/refund' + request.pageQuery({ orderNo: orderNo }));
  },

  onConfirm(e) {
    const orderNo = e.currentTarget.dataset.no || '';
    if (!orderNo) return;
    const self = this;
    wx.showModal({
      title: '确认完成',
      content: '确认课程已经上完并完成订单？',
      success(res) {
        if (!res.confirm) return;
        request
          .post('/api/orders/' + orderNo + '/confirm', {})
          .then(function () {
            request.toast('订单已完成');
            self.load(true);
          })
          .catch(function () {
            /* request 已 toast */
          });
      },
    });
  },

  goShop() {
    nav.go('/pages/list/list');
  },

  onShareAppMessage() {
    return invite.shareMessage('瑜伽课堂 · 我的课程', '/pages/orders/orders');
  },
});
