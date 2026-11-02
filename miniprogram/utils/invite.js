'use strict';
/**
 * 邀请码处理：
 * - 分享链接形如 /pages/index/index?inviteCode=DEMOA
 * - 进入任意页面若带 inviteCode，则调 POST /api/dist/bind 绑定上级（仅一次，重复绑定后端返回 DUPLICATE，静默忽略）
 */
const config = require('./config.js');
const request = require('./request.js');

const KEYS = config.STORAGE_KEYS;

/** 从页面/启动参数里提取 inviteCode */
function readFrom(options) {
  const opts = options || {};
  const query = opts.query || {};
  const raw = query.inviteCode || query.invitecode || query.code || '';
  return String(raw || '').trim().slice(0, 32);
}

/** 记录待绑定邀请码（登录后由 bindPending 消费） */
function remember(code) {
  const value = String(code || '').trim();
  if (!value) return;
  config.storageSet(KEYS.inviteCode, value);
}

/**
 * 绑定上级。已绑定过 / 绑定失败都不打扰用户。
 * @returns {Promise<{bound:boolean, reason?:string}>}
 */
function bind(code) {
  const value = String(code || '').trim();
  if (!value) return Promise.resolve({ bound: false, reason: 'empty' });
  if (config.storageGet(KEYS.boundCode, '') === value) {
    return Promise.resolve({ bound: false, reason: 'done' });
  }
  remember(value);
  return request
    .ensureLogin()
    .then(function () {
      return request.post('/api/dist/bind', { inviteCode: value }, { silent: true });
    })
    .then(function (data) {
      config.storageSet(KEYS.boundCode, value);
      return { bound: true, data: data };
    })
    .catch(function (err) {
      const code2 = (err && err.code) || '';
      if (code2 === 'DUPLICATE' || code2 === 'VALIDATION_ERROR' || code2 === 'FORBIDDEN') {
        config.storageSet(KEYS.boundCode, value);
        return { bound: false, reason: code2, message: err.message };
      }
      return { bound: false, reason: 'error', message: (err && err.message) || '' };
    });
}

/** 页面 onLoad 统一入口：解析 + 绑定（不阻塞渲染） */
function consume(options) {
  const code = readFrom(options);
  if (!code) return '';
  remember(code);
  bind(code);
  return code;
}

function sharePath(pagePath) {
  const code = config.storageGet(KEYS.inviteCode, '');
  const base = pagePath || '/pages/index/index';
  if (!code) return base;
  return base + (base.indexOf('?') >= 0 ? '&' : '?') + 'inviteCode=' + encodeURIComponent(code);
}

/** 分享文案（页面 onShareAppMessage 复用） */
function shareMessage(title, pagePath) {
  return {
    title: title || '瑜伽课堂 · 每天 30 分钟，跟练不掉队',
    path: sharePath(pagePath),
  };
}

module.exports = {
  readFrom: readFrom,
  remember: remember,
  bind: bind,
  consume: consume,
  sharePath: sharePath,
  shareMessage: shareMessage,
};
