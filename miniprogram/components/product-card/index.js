'use strict';
/** 商品卡：首页/列表/相关推荐共用 */
const view = require('../../utils/view.js');
const nav = require('../../utils/nav.js');

Component({
  options: { addGlobalClass: true },
  properties: {
    item: {
      type: Object,
      value: null,
      observer: 'onItemChange',
    },
    showType: { type: Boolean, value: true },
  },
  data: {
    card: null,
  },
  methods: {
    onItemChange(item) {
      if (!item) {
        this.setData({ card: null });
        return;
      }
      this.setData({ card: view.toProduct(item) });
    },
    onTap() {
      const card = this.data.card;
      if (!card || !card.id) return;
      nav.go('/pages/detail/detail?id=' + card.id);
    },
  },
});
