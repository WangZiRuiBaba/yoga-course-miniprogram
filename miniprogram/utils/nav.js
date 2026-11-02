'use strict';
/** 页面跳转封装：tabBar 页用 switchTab，其余用 navigateTo */

const TAB_PAGES = ['/pages/index/index', '/pages/list/list', '/pages/ai/ai', '/pages/mine/mine'];

function pathOf(url) {
  return String(url || '').split('?')[0];
}

function isTab(url) {
  return TAB_PAGES.indexOf(pathOf(url)) >= 0;
}

/** 跳转（自动区分 tabBar / 普通页；当前页不重复跳） */
function go(url, options) {
  const target = String(url || '');
  if (!target) return;
  const opts = options || {};
  if (isTab(target)) {
    wx.switchTab({ url: pathOf(target) });
    return;
  }
  const navigate = opts.replace ? wx.redirectTo : wx.navigateTo;
  navigate({ url: target });
}

function replace(url) {
  go(url, { replace: true });
}

function back(fallback) {
  const pages = (typeof getCurrentPages === 'function' && getCurrentPages()) || [];
  if (pages.length > 1) {
    wx.navigateBack({ delta: 1 });
    return;
  }
  go(fallback || '/pages/index/index');
}

/** 回到首页（tabBar） */
function home() {
  wx.switchTab({ url: '/pages/index/index' });
}

module.exports = { TAB_PAGES: TAB_PAGES, isTab: isTab, go: go, replace: replace, back: back, home: home, pathOf: pathOf };
