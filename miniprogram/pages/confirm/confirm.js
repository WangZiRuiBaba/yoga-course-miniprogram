'use strict';
/** 确认订单：核对商品 / 备注 / 提交下单，成功后进入收银台 */
const request = require('../../utils/request.js');
const view = require('../../utils/view.js');
const nav = require('../../utils/nav.js');
const invite = require('../../utils/invite.js');
const platform = require('../../utils/platform.js');

Page({
  data: {
    loading: true,
    error: '',
    submitting: false,
    productId: '',
    skuId: '',
    quantity: 1,
    remark: '',
    product: null,
    sku: null,
    priceText: '—',
    totalText: '—',
    unitCents: 0,
    expireTip: '下单后请在 15 分钟内完成支付',
  },

  onLoad(options) {
    invite.consume(options);
    const productId = (options && options.productId) || '';
    const skuId = (options && options.skuId) || '';
    const quantity = Number((options && options.quantity) || 1) || 1;
    this.setData({ productId: productId, skuId: skuId, quantity: quantity });
    if (!productId) {
      this.setData({ loading: false, error: '缺少课程参数，请从课程详情页重新进入' });
      return;
    }
    this.load();
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
      .get('/api/products/' + this.data.productId, null, { auth: false })
      .then((data) => {
        const d = data || {};
        const product = view.toProductDetail(d.product || {});
        const skus = (Array.isArray(d.skus) ? d.skus : []).map(function (s) {
          return view.toSku(s);
        });
        let sku = null;
        for (let i = 0; i < skus.length; i += 1) {
          if (skus[i].id === this.data.skuId) sku = skus[i];
        }
        if (!sku && skus.length > 0) sku = skus[0];
        this.setData(
          {
            loading: false,
            product: product,
            sku: sku,
            skuId: sku ? sku.id : '',
            priceText: sku ? sku.priceText : product.priceText,
            unitCents: sku ? sku.priceCents : product.priceCents,
          },
          () => {
            this.refreshTotal();
          }
        );
      })
      .catch((err) => {
        this.setData({ loading: false, error: (err && err.message) || '订单信息加载失败' });
      });
  },

  refreshTotal() {
    const qty = this.data.quantity || 1;
    const cents = (this.data.unitCents || 0) * qty;
    const yuan = Math.floor(cents / 100);
    const fen = cents % 100;
    this.setData({ totalText: yuan + '.' + (fen < 10 ? '0' + fen : String(fen)) });
  },

  onRetry() {
    this.load();
  },

  onMinus() {
    const q = this.data.quantity;
    if (q <= 1) return;
    this.setData({ quantity: q - 1 }, () => {
      this.refreshTotal();
    });
  },

  onPlus() {
    const q = this.data.quantity;
    if (q >= 99) return;
    this.setData({ quantity: q + 1 }, () => {
      this.refreshTotal();
    });
  },

  onRemarkInput(e) {
    this.setData({ remark: e.detail.value });
  },

  onSubmit() {
    if (this.data.submitting) return;
    if (platform.guardPay()) return;
    this.setData({ submitting: true });
    const payload = {
      productId: this.data.productId,
      quantity: this.data.quantity,
      source: 'miniprogram',
    };
    if (this.data.skuId) payload.skuId = this.data.skuId;
    if (this.data.remark) payload.remark = String(this.data.remark).slice(0, 200);

    request
      .post('/api/orders', payload)
      .then((data) => {
        const d = data || {};
        this.setData({ submitting: false });
        if (!d.orderNo) {
          request.toast('下单失败，请重试');
          return;
        }
        nav.replace('/pages/pay/pay' + request.pageQuery({ orderNo: d.orderNo }));
      })
      .catch((err) => {
        this.setData({ submitting: false });
        const code = err && err.code;
        if (code === 'OUT_OF_STOCK') request.toast('课程库存不足，请减少数量');
        else if (code === 'VALIDATION_ERROR') request.toast((err && err.message) || '订单参数有误');
      });
  },

  goBack() {
    nav.back('/pages/list/list');
  },
});
