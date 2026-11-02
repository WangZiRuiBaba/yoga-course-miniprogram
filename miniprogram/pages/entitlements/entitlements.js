'use strict';
/** 我的课程（权益）：列表 / 筛选 / 核销码复制 / 进详情 */
const request = require('../../utils/request.js');
const format = require('../../utils/format.js');
const nav = require('../../utils/nav.js');
const view = require('../../utils/view.js');

const FILTERS = [
  { key: '', label: '全部' },
  { key: 'active', label: '有效' },
  { key: 'expired', label: '已过期' },
];

Page({
  data: {
    loading: true,
    error: '',
    list: [],
    all: [],
    filter: '',
    filters: FILTERS,
    total: 0,
    activeCount: 0,
  },

  onLoad() {
    this.load();
  },

  onShow() {
    if (this.loadedOnce) this.load(true);
    this.loadedOnce = true;
  },

  onPullDownRefresh() {
    this.load(true).then(
      () => {
        wx.stopPullDownRefresh();
      },
      () => {
        wx.stopPullDownRefresh();
      }
    );
  },

  onRetry() {
    this.load();
  },

  load(silent) {
    if (!silent) this.setData({ loading: true, error: '' });
    return request
      .get('/api/my/entitlements')
      .then((data) => {
        const rows = Array.isArray(data) ? data : (data && data.list) || [];
        const all = rows.map(view.toEntitlement);
        const activeCount = all.filter(function (e) {
          return e.status !== 'expired';
        }).length;
        this.setData(
          {
            loading: false,
            all: all,
            total: all.length,
            activeCount: activeCount,
          },
          () => {
            this.applyFilter();
          }
        );
      })
      .catch((err) => {
        if (silent) {
          this.setData({ loading: false });
          return;
        }
        this.setData({ loading: false, error: (err && err.message) || '课程加载失败' });
      });
  },

  applyFilter() {
    const key = this.data.filter;
    const all = this.data.all || [];
    let list = all;
    if (key === 'active') {
      list = all.filter(function (e) {
        return e.status !== 'expired';
      });
    } else if (key === 'expired') {
      list = all.filter(function (e) {
        return e.status === 'expired';
      });
    }
    this.setData({ list: list });
  },

  onTapFilter(e) {
    const key = e.currentTarget.dataset.key || '';
    if (key === this.data.filter) return;
    this.setData({ filter: key }, () => {
      this.applyFilter();
    });
  },

  onTapItem(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    nav.go('/pages/ent-detail/ent-detail' + request.pageQuery({ id: id }));
  },

  onCopyCode(e) {
    const code = e.currentTarget.dataset.code;
    if (!code) {
      request.toast('暂无核销码');
      return;
    }
    wx.setClipboardData({
      data: code,
      success() {
        request.toast('核销码已复制');
      },
    });
  },

  goList() {
    nav.go('/pages/list/list');
  },
});
