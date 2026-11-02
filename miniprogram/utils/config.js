'use strict';
/**
 * 全局配置（零依赖）。
 * BASE_URL 默认 http://127.0.0.1:3100，可在本地覆盖：
 *   wx.setStorageSync('mp_base_url', 'http://192.168.1.8:3100')
 * 或在我的页面里调用 config.setBaseUrl()。
 */

const DEFAULT_BASE_URL = 'http://127.0.0.1:3100';

/**
 * iOS 端是否关闭「在线购买」入口。
 * 微信规则：小程序内售卖课程属虚拟商品，iOS 端不得提供支付入口
 * （安卓可直接购买）。如需临时放开（例如仅内部测试），把它改成 false。
 */
const IOS_PAY_DISABLED = true;

const THEME = {
  primary: '#6C5CE7',
  primarySoft: '#EEEBFF',
  accent: '#FF7A59',
  text: '#1F1F2C',
  sub: '#8A8AA3',
  line: '#EFEFF6',
  bg: '#F7F7FB',
};

/** 本地演示身份（对应 server/seed.js 的 A/B/C） */
const DEMO_ACCOUNTS = [
  { openid: 'dev_demo_a', label: '馆主·林梵（一级）' },
  { openid: 'dev_demo_b', label: '学员·小满（A 的下级）' },
  { openid: 'dev_demo_c', label: '学员·阿橘（B 的下级）' },
];

const STORAGE_KEYS = {
  token: 'mp_token',
  user: 'mp_user',
  openid: 'mp_openid',
  baseUrl: 'mp_base_url',
  inviteCode: 'mp_invite_code',
  boundCode: 'mp_bound_code',
  aiSession: 'mp_ai_session',
};

function hasWx() {
  return typeof wx !== 'undefined' && wx && typeof wx.getStorageSync === 'function';
}

function storageGet(key, fallback) {
  if (!hasWx()) return fallback;
  try {
    const value = wx.getStorageSync(key);
    if (value === '' || value === null || value === undefined) return fallback;
    return value;
  } catch (err) {
    return fallback;
  }
}

function storageSet(key, value) {
  if (!hasWx()) return;
  try {
    wx.setStorageSync(key, value);
  } catch (err) {
    /* 存储失败不影响主流程 */
  }
}

function storageRemove(key) {
  if (!hasWx()) return;
  try {
    wx.removeStorageSync(key);
  } catch (err) {
    /* ignore */
  }
}

function baseUrl() {
  const saved = storageGet(STORAGE_KEYS.baseUrl, '');
  const url = String(saved || DEFAULT_BASE_URL);
  return url.replace(/\/+$/, '');
}

function setBaseUrl(url) {
  storageSet(STORAGE_KEYS.baseUrl, String(url || '').replace(/\/+$/, ''));
}

/** 后端返回的 cover 是相对路径（/api/media/cover/xxx），统一补成绝对地址 */
function mediaUrl(path) {
  const raw = String(path || '');
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw) || raw.indexOf('data:') === 0) return raw;
  return baseUrl() + (raw.charAt(0) === '/' ? raw : '/' + raw);
}

module.exports = {
  DEFAULT_BASE_URL,
  IOS_PAY_DISABLED,
  THEME,
  DEMO_ACCOUNTS,
  STORAGE_KEYS,
  storageGet,
  storageSet,
  storageRemove,
  baseUrl,
  setBaseUrl,
  mediaUrl,
};
