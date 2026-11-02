'use strict';
/** 权益详情：核销码 / 有效期 / 上课须知 */
const request = require('../../utils/request.js');
const format = require('../../utils/format.js');
const nav = require('../../utils/nav.js');
const view = require('../../utils/view.js');

Page({
  data: {
    loading: true,
    error: '',
    id: '',
    ent: null,
    notice: '',
    noticeHtml: '',
    notices: [],
    teacher: '',
    schedule: '',
    durationText: '',
    verifyTip: '',
    productId: '',
    orderNo: '',
    verifyCode: '',
    statusText: '',
    status: '',
    expiresAtText: '',
    grantedAtText: '',
    title: '',
    cover: '',
    typeText: '',
  },

  onLoad(options) {
    const id = (options && options.id) || '';
    this.setData({ id: id });
    if (!id) {
      this.setData({ loading: false, error: '缺少课程参数' });
      return;
    }
    this.load();
  },

  onRetry() {
    this.load();
  },

  load() {
    this.setData({ loading: true, error: '' });
    return request
      .get('/api/my/entitlements/' + encodeURIComponent(this.data.id))
      .then((data) => {
        const d = data || {};
        const raw = d.entitlement || d.ent || d;
        const ent = view.toEntitlement(raw);
        const noticeList = d.notices || raw.notices;
        let notices = [];
        if (Array.isArray(noticeList)) {
          notices = noticeList.map(function (n, i) {
            return {
              key: 'nt-' + i,
              text: typeof n === 'string' ? n : format.textOr(n.text || n.content),
            };
          });
        }
        const notice = format.textOr(d.notice || raw.notice);
        const noticeHtml = format.absoluteHtml(d.noticeHtml || raw.noticeHtml || ent.contentHtml || '');
        this.setData({
          loading: false,
          ent: ent,
          title: ent.title,
          cover: ent.cover,
          typeText: ent.typeText,
          status: ent.status,
          statusText: ent.statusText,
          verifyCode: ent.verifyCode,
          expiresAtText: ent.expiresAtText,
          grantedAtText: ent.grantedAtText,
          orderNo: ent.orderNo,
          productId: ent.productId,
          notice: notice,
          noticeHtml: noticeHtml,
          notices: notices,
          teacher: format.textOr(d.teacher || raw.teacher),
          schedule: format.textOr(d.schedule || raw.schedule),
          durationText: (d.durationMin || raw.durationMin) ? (d.durationMin || raw.durationMin) + ' 分钟' : '',
          verifyTip: format.textOr(d.verifyTip),
        });
        wx.setNavigationBarTitle({ title: ent.title || '课程详情' });
      })
      .catch((err) => {
        this.setData({ loading: false, error: (err && err.message) || '课程详情加载失败' });
      });
  },

  onCopyCode() {
    const code = this.data.verifyCode;
    if (!code) {
      request.toast('该课程暂无核销码');
      return;
    }
    wx.setClipboardData({
      data: code,
      success() {
        request.toast('核销码已复制');
      },
    });
  },

  goOrder() {
    const orderNo = this.data.orderNo;
    if (!orderNo) {
      nav.go('/pages/orders/orders');
      return;
    }
    nav.go('/pages/order-detail/order-detail' + request.pageQuery({ orderNo: orderNo }));
  },

  goProduct() {
    const productId = this.data.productId;
    if (!productId) return;
    nav.go('/pages/detail/detail' + request.pageQuery({ id: productId }));
  },

  goService() {
    nav.go('/pages/service/service');
  },
});
