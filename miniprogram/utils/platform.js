'use strict';
/**
 * 平台能力判定（零依赖）。
 * 目前只处理一件事：iOS 端按微信规则不得在小程序内售卖虚拟商品（课程），
 * 因此购买/支付入口在 iOS 上要隐藏，并引导到客服报名。
 *
 * 用法：
 *   const platform = require('../../utils/platform.js');
 *   if (platform.payBlocked()) { platform.explainBlocked(); return; }
 */
const config = require('./config.js');

let cached = '';

/** 取平台标识：ios / android / devtools / windows / mac ... */
function platform() {
  if (cached) return cached;
  try {
    const info = wx.getSystemInfoSync();
    cached = String((info && info.platform) || '').toLowerCase();
  } catch (err) {
    cached = '';
  }
  return cached;
}

function isIOS() {
  return platform() === 'ios';
}

/** 是否禁止在线购买（iOS + 开关打开） */
function payBlocked() {
  return !!config.IOS_PAY_DISABLED && isIOS();
}

/** 拦截文案 */
function blockText() {
  return 'iOS 端暂不支持在线购买课程，可联系客服报名，或在安卓设备上完成购买';
}

/**
 * 拦截时给统一提示；返回 true 表示已被拦截（调用方直接 return）
 * @param {object} [opts] { back: 是否提示后返回上一页 }
 */
function guardPay(opts) {
  if (!payBlocked()) return false;
  const options = opts || {};
  wx.showModal({
    title: '暂不支持在线购买',
    content: blockText(),
    showCancel: !!options.back,
    cancelText: '知道了',
    confirmText: options.back ? '联系客服' : '知道了',
    success(res) {
      if (res.confirm && options.back) {
        wx.navigateTo({ url: '/pages/service/service' });
      } else if (options.back && !res.confirm) {
        wx.navigateBack({ delta: 1 });
      }
    },
  });
  return true;
}

/** 重置缓存（切换设备调试时用） */
function reset() {
  cached = '';
}

module.exports = {
  platform,
  isIOS,
  payBlocked,
  blockText,
  guardPay,
  reset,
};
