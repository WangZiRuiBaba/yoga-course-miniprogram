'use strict';
/** 课程详情：SKU 选择 / 数量 / 详情富文本 / FAQ / 相关推荐 */
const request = require('../../utils/request.js');
const view = require('../../utils/view.js');
const nav = require('../../utils/nav.js');
const invite = require('../../utils/invite.js');
const platform = require('../../utils/platform.js');

Page({
  data: {
    loading: true,
    error: '',
    productId: '',
    product: null,
    skus: [],
    faq: [],
    related: [],
    skuId: '',
    quantity: 1,
    submitting: false,
    soldOut: false,
    iosBlocked: false,
    priceText: '—',
    totalText: '—',
  },

  onLoad(options) {
    invite.consume(options);
    const id = (options && options.id) || '';
    this.setData({ productId: id, iosBlocked: platform.payBlocked() });
    if (!id) {
      this.setData({ loading: false, error: '课程参数缺失，请返回列表重新进入' });
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
        const related = (Array.isArray(d.related) ? d.related : []).map(function (p) {
          return view.toProduct(p);
        });
        const firstSku = skus.length > 0 ? skus[0] : null;
        this.setData(
          {
            loading: false,
            product: product,
            skus: skus,
            faq: view.toFaq(d.faq),
            related: related,
            skuId: firstSku ? firstSku.id : '',
            soldOut: !!product.soldOut || (firstSku ? firstSku.stock <= 0 : false),
            priceText: firstSku ? firstSku.priceText : product.priceText,
            totalText: firstSku ? firstSku.priceText : product.priceText,
          },
          () => {
            this.refreshTotal();
          }
        );
        wx.setNavigationBarTitle({ title: product.title || '课程详情' });
      })
      .catch((err) => {
        this.setData({ loading: false, error: (err && err.message) || '课程加载失败' });
      });
  },

  refreshTotal() {
    const product = this.data.product;
    if (!product) return;
    const sku = this.findSku(this.data.skuId);
    const unitCents = sku ? sku.priceCents : product.priceCents;
    const unitText = sku ? sku.priceText : product.priceText;
    const qty = this.data.quantity || 1;
    let totalText = unitText;
    if (qty > 1) {
      // 金额展示不做除法，纯整数相乘后按分转字符串
      const cents = (unitCents || 0) * qty;
      const yuan = Math.floor(cents / 100);
      const fen = cents % 100;
      totalText = yuan + '.' + (fen < 10 ? '0' + fen : String(fen));
    }
    this.setData({ priceText: unitText, totalText: totalText });
  },

  findSku(id) {
    const list = this.data.skus || [];
    for (let i = 0; i < list.length; i += 1) {
      if (list[i].id === id) return list[i];
    }
    return null;
  },

  onRetry() {
    this.load();
  },

  onPickSku(e) {
    const id = e.currentTarget.dataset.id || '';
    const sku = this.findSku(id);
    if (!sku) return;
    if (sku.stock <= 0) {
      request.toast('该规格已售罄');
      return;
    }
    this.setData({ skuId: id, soldOut: false }, () => {
      this.refreshTotal();
    });
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
    const sku = this.findSku(this.data.skuId);
    const stock = sku ? sku.stock : this.data.product ? this.data.product.stock : 0;
    if (stock && q >= stock) {
      request.toast('库存只剩 ' + stock + ' 份');
      return;
    }
    if (q >= 99) return;
    this.setData({ quantity: q + 1 }, () => {
      this.refreshTotal();
    });
  },

  onToggleFaq(e) {
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.faq[index];
    if (!item) return;
    const patch = {};
    patch['faq[' + index + '].open'] = !item.open;
    this.setData(patch);
  },

  onBuy() {
    if (this.data.submitting) return;
    if (platform.guardPay()) return;
    if (this.data.soldOut) {
      request.toast('该课程已售罄');
      return;
    }
    const query = {
      productId: this.data.productId,
      quantity: this.data.quantity,
    };
    if (this.data.skuId) query.skuId = this.data.skuId;
    nav.go('/pages/confirm/confirm' + request.pageQuery(query));
  },

  goService() {
    nav.go('/pages/service/service');
  },

  onShareAppMessage() {
    const product = this.data.product || {};
    return invite.shareMessage(
      product.title || '瑜伽课堂',
      '/pages/detail/detail?id=' + this.data.productId
    );
  },
});
