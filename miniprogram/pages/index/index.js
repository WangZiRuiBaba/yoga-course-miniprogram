'use strict';
/** 首页：banner + 目标筛选入口 + 推荐分区 */
const request = require('../../utils/request.js');
const config = require('../../utils/config.js');
const format = require('../../utils/format.js');
const nav = require('../../utils/nav.js');
const invite = require('../../utils/invite.js');

const BANNER_SKINS = ['bn-a', 'bn-b', 'bn-c'];

function normalizeBanners(list) {
  if (!Array.isArray(list)) return [];
  return list.map(function (b, i) {
    const item = b || {};
    return {
      key: item.id || 'bn-' + i,
      title: format.textOr(item.title, '瑜伽课堂'),
      subtitle: format.textOr(item.subtitle),
      image: config.mediaUrl(item.image || item.cover || ''),
      skin: BANNER_SKINS[i % BANNER_SKINS.length],
      productId: item.productId || '',
    };
  });
}

function normalizeSections(list) {
  if (!Array.isArray(list)) return [];
  return list.map(function (s, i) {
    const sec = s || {};
    return {
      key: sec.key || 'sec-' + i,
      title: format.textOr(sec.title, '推荐课程'),
      subtitle: format.textOr(sec.subtitle),
      products: Array.isArray(sec.products) ? sec.products : [],
    };
  });
}

function normalizeGoals(list) {
  if (!Array.isArray(list)) return [];
  return list.map(function (g, i) {
    const goal = g || {};
    return {
      key: goal.key || 'goal-' + i,
      label: format.textOr(goal.label, goal.key || '目标'),
      icon: format.textOr(goal.icon, '✨'),
      count: goal.count || 0,
    };
  });
}

Page({
  data: {
    loading: true,
    error: '',
    notice: '',
    banners: [],
    sections: [],
    goals: [],
    inviteCode: '',
    greeting: '今天想练点什么？',
    userId: '',
  },

  onLoad(options) {
    const code = invite.consume(options);
    this.setData({
      inviteCode: code || config.storageGet(config.STORAGE_KEYS.inviteCode, ''),
    });
    this.loadHome();
    this.loadGoals();
  },

  onShow() {
    const code = config.storageGet(config.STORAGE_KEYS.inviteCode, '');
    if (code && code !== this.data.inviteCode) this.setData({ inviteCode: code });
    const app = typeof getApp === 'function' ? getApp() : null;
    const user = (app && app.globalData && app.globalData.user) || request.getUser();
    if (user && user.id !== this.data.userId) {
      this.setData({
        userId: user.id || '',
        greeting: '你好，' + format.textOr(user.nickname, '瑜伽伙伴') + '，今天想练点什么？',
      });
    }
  },

  onPullDownRefresh() {
    Promise.all([this.loadHome(), this.loadGoals()]).then(
      function () {
        wx.stopPullDownRefresh();
      },
      function () {
        wx.stopPullDownRefresh();
      }
    );
  },

  loadHome() {
    this.setData({ loading: true, error: '' });
    return request
      .get('/api/home', null, { auth: false })
      .then((data) => {
        const d = data || {};
        this.setData({
          loading: false,
          notice: format.textOr(d.notice),
          banners: normalizeBanners(d.banners),
          sections: normalizeSections(d.sections),
        });
      })
      .catch((err) => {
        this.setData({ loading: false, error: (err && err.message) || '首页加载失败' });
      });
  },

  loadGoals() {
    return request
      .get('/api/goals', null, { auth: false, silent: true })
      .then((data) => {
        this.setData({ goals: normalizeGoals(data) });
      })
      .catch(function () {
        /* 目标标签属于增强信息，失败静默 */
      });
  },

  onRetry() {
    this.loadHome();
    this.loadGoals();
  },

  onTapGoal(e) {
    const goal = e.currentTarget.dataset.goal || '';
    nav.go('/pages/list/list?goal=' + encodeURIComponent(goal));
  },

  onTapBanner(e) {
    const productId = e.currentTarget.dataset.id || '';
    if (productId) nav.go('/pages/detail/detail?id=' + productId);
    else nav.go('/pages/list/list');
  },

  onTapSearch() {
    nav.go('/pages/list/list?focus=1');
  },

  onTapMore(e) {
    const goal = e.currentTarget.dataset.goal || '';
    nav.go('/pages/list/list' + (goal ? '?goal=' + encodeURIComponent(goal) : ''));
  },

  goAi() {
    nav.go('/pages/ai/ai');
  },

  onShareAppMessage() {
    return invite.shareMessage('瑜伽课堂 · 每天 30 分钟，跟练不掉队', '/pages/index/index');
  },

  onShareTimeline() {
    return { title: '瑜伽课堂 · 每天 30 分钟，跟练不掉队', query: '' };
  },
});
