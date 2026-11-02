'use strict';
/** 课程列表：目标 / 类型 / 排序 / 关键词筛选 + 翻页 */
const request = require('../../utils/request.js');
const format = require('../../utils/format.js');
const invite = require('../../utils/invite.js');
const nav = require('../../utils/nav.js');

const TYPES = [
  { key: '', label: '全部' },
  { key: 'online', label: '线上课' },
  { key: 'offline', label: '到店课' },
  { key: 'membership', label: '会员卡' },
];

const SORTS = [
  { key: 'hot', label: '综合' },
  { key: 'new', label: '最新' },
  { key: 'price_asc', label: '价格↑' },
  { key: 'price_desc', label: '价格↓' },
];

function normalizeGoals(list) {
  if (!Array.isArray(list)) return [];
  return list.map(function (g, i) {
    const goal = g || {};
    return {
      key: goal.key || 'goal-' + i,
      label: format.textOr(goal.label, goal.key || '目标'),
      icon: format.textOr(goal.icon, ''),
    };
  });
}

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
    keyword: '',
    keywordInput: '',
    goal: '',
    type: '',
    sort: 'hot',
    goals: [],
    types: TYPES,
    sorts: SORTS,
    focus: false,
    emptyText: '还没有符合条件的课程',
  },

  onLoad(options) {
    invite.consume(options);
    const goal = options && options.goal ? String(options.goal) : '';
    const type = options && options.type ? String(options.type) : '';
    const keyword = options && options.keyword ? String(options.keyword) : '';
    this.setData({
      goal: goal,
      type: type,
      keyword: keyword,
      keywordInput: keyword,
      focus: !!(options && options.focus),
    });
    this.loadGoals();
    this.load(true);
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

  loadGoals() {
    return request
      .get('/api/goals', null, { auth: false, silent: true })
      .then((data) => {
        this.setData({ goals: normalizeGoals(data) });
      })
      .catch(function () {
        /* 增强信息，失败静默 */
      });
  },

  load(reset) {
    const nextPage = reset ? 1 : this.data.page + 1;
    if (reset) this.setData({ loading: true, error: '' });
    else this.setData({ loadingMore: true });

    const query = {
      page: nextPage,
      size: this.data.size,
      sort: this.data.sort || 'hot',
    };
    if (this.data.type) query.type = this.data.type;
    if (this.data.goal) query.goal = this.data.goal;
    if (this.data.keyword) query.keyword = this.data.keyword;

    return request
      .get('/api/products', query, { auth: false })
      .then((data) => {
        const d = data || {};
        const rows = Array.isArray(d.list) ? d.list : [];
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
          error: reset ? (err && err.message) || '课程加载失败' : '',
        });
        if (!reset) request.toast((err && err.message) || '加载更多失败');
      });
  },

  onRetry() {
    this.load(true);
  },

  onSearchInput(e) {
    this.setData({ keywordInput: e.detail.value });
  },

  onSearchConfirm() {
    this.setData({ keyword: this.data.keywordInput }, () => {
      this.load(true);
    });
  },

  onClearKeyword() {
    this.setData({ keyword: '', keywordInput: '' }, () => {
      this.load(true);
    });
  },

  onTapGoal(e) {
    const key = e.currentTarget.dataset.key || '';
    this.setData({ goal: key === this.data.goal ? '' : key }, () => {
      this.load(true);
    });
  },

  onTapType(e) {
    const key = e.currentTarget.dataset.key || '';
    this.setData({ type: key }, () => {
      this.load(true);
    });
  },

  onTapSort(e) {
    const key = e.currentTarget.dataset.key || 'hot';
    if (key === this.data.sort) return;
    this.setData({ sort: key }, () => {
      this.load(true);
    });
  },

  onTapProduct(e) {
    const id = e.currentTarget.dataset.id || '';
    if (id) nav.go('/pages/detail/detail?id=' + id);
  },

  onShareAppMessage() {
    return invite.shareMessage('瑜伽课堂 · 6 门精选课程', '/pages/list/list');
  },
});
