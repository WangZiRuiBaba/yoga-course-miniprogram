'use strict';
/**
 * 瑜伽卖课小程序 —— App 入口。
 * 启动即静默登录（mock 环境走 dev-login），并消费分享链接上的 inviteCode 绑定上级。
 */
const config = require('./utils/config.js');
const request = require('./utils/request.js');
const invite = require('./utils/invite.js');

App({
  globalData: {
    user: null,
    inviteCode: '',
    ready: false,
    launchQuery: {},
  },

  onLaunch(options) {
    const opts = options || {};
    this.globalData.launchQuery = opts.query || {};
    this.captureInvite(opts);

    request
      .login()
      .then((session) => {
        this.globalData.user = (session && session.user) || request.getUser();
        this.globalData.inviteCode = (this.globalData.user && this.globalData.user.inviteCode) || '';
        this.globalData.ready = true;
      })
      .catch(() => {
        // 登录失败不阻塞首屏：各页面 ensureLogin 时会再试一次
        this.globalData.ready = false;
      });
  },

  onShow(options) {
    this.captureInvite(options || {});
  },

  onError(err) {
    console.error('[app.onError]', err);
  },

  /** 解析分享链接里的 inviteCode → 绑定上级 */
  captureInvite(options) {
    const code = invite.readFrom(options);
    if (!code) return;
    this.globalData.inviteCode = code;
    config.storageSet(config.STORAGE_KEYS.inviteCode, code);
    invite.bind(code);
  },

  /** 页面共用：当前用户（可能为 null） */
  currentUser() {
    return this.globalData.user || request.getUser();
  },
});
