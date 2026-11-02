'use strict';
/** 我的：账号信息 / 功能入口 / 邀请码 / 演示账号切换 / 服务地址 */
const request = require('../../utils/request.js');
const config = require('../../utils/config.js');
const format = require('../../utils/format.js');
const nav = require('../../utils/nav.js');
const invite = require('../../utils/invite.js');

Page({
  data: {
    loading: true,
    error: '',
    user: null,
    nickname: '',
    initial: '瑜',
    avatar: '',
    roleText: '',
    openid: 'dev_demo_a',
    demoAccounts: config.DEMO_ACCOUNTS,
    inviteCode: '',
    isDistributor: false,
    hasOpenConversation: false,
    baseUrlText: '',
    entCount: 0,
    orderCount: 0,
  },

  onShow() {
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
    this.setData({
      loading: true,
      error: '',
      openid: request.getOpenid(),
      baseUrlText: config.baseUrl(),
    });
    return request
      .me()
      .then((data) => {
        const d = data || {};
        const user = d.user || request.getUser() || null;
        const nickname = user ? format.textOr(user.nickname, '瑜伽伙伴') : '';
        this.setData({
          loading: false,
          user: user,
          nickname: nickname,
          avatar: user ? format.textOr(user.avatar) : '',
          initial: nickname ? nickname.charAt(0) : '瑜',
          roleText: user && user.role === 'admin' ? '馆主' : user ? '学员' : '',
          inviteCode: format.textOr(d.inviteCode || (user && user.inviteCode)),
          isDistributor: !!(user && user.distEnabled),
          hasOpenConversation: !!d.hasOpenConversation,
          baseUrlText: config.baseUrl(),
        });
        this.loadCounts();
      })
      .catch((err) => {
        this.setData({ loading: false, error: (err && err.message) || '账号信息加载失败' });
      });
  },

  loadCounts() {
    request
      .get('/api/my/entitlements', null, { silent: true })
      .then((data) => {
        const list = Array.isArray(data) ? data : (data && data.list) || [];
        this.setData({ entCount: list.length });
      })
      .catch(function () {
        /* 统计失败不影响主流程 */
      });
    request
      .get('/api/orders', { page: 1, size: 1 }, { silent: true })
      .then((data) => {
        this.setData({ orderCount: (data && data.total) || 0 });
      })
      .catch(function () {
        /* 统计失败不影响主流程 */
      });
  },

  onRetry() {
    this.load();
  },

  goOrders() {
    nav.go('/pages/orders/orders');
  },

  goEntitlements() {
    nav.go('/pages/entitlements/entitlements');
  },

  goDist() {
    nav.go('/pages/dist/dist');
  },

  goService() {
    nav.go('/pages/service/service');
  },

  goAi() {
    nav.go('/pages/ai/ai');
  },

  goShop() {
    nav.go('/pages/list/list');
  },

  /** 复制邀请码（用于分享给朋友绑定关系） */
  copyInvite() {
    if (!this.data.inviteCode) {
      request.toast('邀请码还没生成，稍后再试');
      return;
    }
    if (typeof wx === 'undefined' || !wx.setClipboardData) return;
    const code = this.data.inviteCode;
    wx.setClipboardData({
      data: code,
      success() {
        request.toast('邀请码已复制：' + code);
      },
    });
  },

  /** 切换演示账号：清会话后按新 openid 重新登录 */
  onSwitchAccount() {
    const accounts = this.data.demoAccounts || [];
    const labels = accounts.map(function (a) {
      return a.label;
    });
    const self = this;
    wx.showActionSheet({
      itemList: labels,
      success(res) {
        const picked = accounts[res.tapIndex];
        if (!picked) return;
        request.setOpenid(picked.openid);
        request.clearSession();
        request
          .login(true)
          .then(function () {
            request.toast('已切换为 ' + picked.label);
            self.load();
          })
          .catch(function () {
            self.setData({ loading: false, error: '切换账号失败，请重试' });
          });
      },
    });
  },

  /** 修改后端服务地址（本地调试用） */
  onEditBaseUrl() {
    const self = this;
    wx.showModal({
      title: '服务地址',
      editable: true,
      placeholderText: 'http://127.0.0.1:3100',
      content: this.data.baseUrlText,
      success(res) {
        if (!res.confirm) return;
        const value = String(res.content || '').trim();
        if (!value) {
          request.toast('地址不能为空');
          return;
        }
        config.setBaseUrl(value);
        request.clearSession();
        request
          .login(true)
          .then(function () {
            request.toast('已切换服务地址');
            self.load();
          })
          .catch(function () {
            self.setData({ loading: false, error: '连接新地址失败，请检查后端是否启动' });
          });
      },
    });
  },

  onLogout() {
    const self = this;
    wx.showModal({
      title: '退出登录',
      content: '退出后需要重新登录才能查看订单与课程',
      success(res) {
        if (!res.confirm) return;
        request.logout();
        self.setData({ user: null, nickname: '', inviteCode: '', isDistributor: false, entCount: 0, orderCount: 0 });
        request
          .login(true)
          .then(function () {
            self.load();
          })
          .catch(function () {
            self.setData({ loading: false, error: '重新登录失败，请点重试' });
          });
      },
    });
  },

  onShareAppMessage() {
    return invite.shareMessage('瑜伽课堂 · 一起练更持久', '/pages/index/index');
  },
});
