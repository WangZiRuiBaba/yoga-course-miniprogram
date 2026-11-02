'use strict';
/**
 * 统一请求层。
 * - 自动带 Authorization: Bearer <token>
 * - 401 自动重新登录（wx.login → /api/auth/wx-login；mock 环境 mock=true 时用 dev-login 兜底），并重试一次
 * - 统一处理 {ok:true,data} / {ok:false,code,message}，失败 toast message 并 reject
 * - BASE_URL 由 utils/config.js 提供，可运行时覆盖
 */
const config = require('./config.js');

const KEYS = config.STORAGE_KEYS;
const DEFAULT_TIMEOUT = 20000;

let loginTask = null;

/* ------------------------------ 会话 ------------------------------ */

function getToken() {
  return config.storageGet(KEYS.token, '');
}

function setToken(token) {
  if (token) config.storageSet(KEYS.token, token);
  else config.storageRemove(KEYS.token);
}

function getUser() {
  return config.storageGet(KEYS.user, null) || null;
}

function setUser(user) {
  if (user) config.storageSet(KEYS.user, user);
  else config.storageRemove(KEYS.user);
}

function getOpenid() {
  return config.storageGet(KEYS.openid, 'dev_demo_a');
}

function setOpenid(openid) {
  config.storageSet(KEYS.openid, openid || 'dev_demo_a');
}

function clearSession() {
  setToken('');
  setUser(null);
}

/* ------------------------------ 工具 ------------------------------ */

function toast(message) {
  const title = String(message || '').slice(0, 60);
  if (!title) return;
  if (typeof wx !== 'undefined' && wx.showToast) {
    wx.showToast({ title: title, icon: 'none', duration: 2200 });
  }
}

function defaultMessage(status) {
  if (status === 401) return '登录已过期，正在重新登录';
  if (status === 403) return '没有权限执行该操作';
  if (status === 404) return '内容不存在或已下架';
  if (status === 429) return '操作太频繁，请稍后再试';
  if (status >= 500) return '服务开小差了，请稍后重试';
  return '请求失败，请稍后重试';
}

function makeError(body, status) {
  const payload = body && typeof body === 'object' ? body : {};
  const err = new Error(payload.message || defaultMessage(status));
  err.code = payload.code || 'HTTP_' + status;
  err.status = status || 0;
  err.details = payload.details || null;
  return err;
}

function buildQuery(query) {
  if (!query) return '';
  const parts = [];
  Object.keys(query).forEach(function (key) {
    const value = query[key];
    if (value === undefined || value === null || value === '') return;
    parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
  });
  return parts.join('&');
}

/** 页面跳转用的查询串：返回 '' 或 '?a=1&b=2'（可直接拼在页面路径后） */
function pageQuery(query) {
  const qs = buildQuery(query);
  return qs ? '?' + qs : '';
}

function rawRequest(options) {
  return new Promise(function (resolve, reject) {
    if (typeof wx === 'undefined' || !wx.request) {
      const err = new Error('当前环境不支持 wx.request');
      err.code = 'NO_WX';
      reject(err);
      return;
    }
    wx.request({
      url: options.url,
      method: options.method,
      data: options.data,
      header: options.header,
      timeout: options.timeout || DEFAULT_TIMEOUT,
      success: function (res) {
        resolve(res || { statusCode: 0, data: null });
      },
      fail: function (err) {
        const e = new Error((err && err.errMsg) || '网络请求失败');
        e.code = 'NETWORK_ERROR';
        e.status = 0;
        e.network = true;
        reject(e);
      },
    });
  });
}

/* ------------------------------ 发送 ------------------------------ */

function send(path, options) {
  const opts = options || {};
  const method = String(opts.method || 'GET').toUpperCase();
  let url = /^https?:\/\//i.test(path) ? path : config.baseUrl() + (String(path).charAt(0) === '/' ? path : '/' + path);
  const qs = buildQuery(opts.query);
  if (qs) url += (url.indexOf('?') >= 0 ? '&' : '?') + qs;

  const header = Object.assign({ 'content-type': 'application/json' }, opts.header || {});
  if (opts.auth !== false) {
    const token = getToken();
    if (token) header.Authorization = 'Bearer ' + token;
  }

  const methodHasBody = method !== 'GET' && method !== 'HEAD';
  return rawRequest({
    url: url,
    method: method,
    data: methodHasBody ? opts.data : undefined,
    header: header,
    timeout: opts.timeout,
  }).then(function (res) {
    const status = res.statusCode || 0;
    const body = res.data;
    if (status >= 200 && status < 300) {
      // raw: 直接返回完整 body（AI 动作接口把 ok/result/needConfirm 放在顶层，需要按 ok 自行判断）
      if (opts.raw) return body;
      if (body && typeof body === 'object' && body.ok === true) return body.data;
      if (body && typeof body === 'object' && body.ok === false) throw makeError(body, status);
      return body;
    }
    if (status === 200 && body === '') return {};
    throw makeError(body, status);
  });
}

/**
 * 业务请求入口。
 * @param {string} path 接口路径（/api/...）
 * @param {{method?:string, data?:object, query?:object, auth?:boolean, silent?:boolean, retry?:boolean, header?:object}} options
 */
function request(path, options) {
  const opts = options || {};
  const canRetry = opts.retry !== false && opts.auth !== false;
  const silent = !!opts.silent;

  const task = send(path, opts).catch(function (err) {
    if (err && err.status === 401 && canRetry) {
      return login(true).then(function () {
        return send(path, opts);
      });
    }
    throw err;
  });

  return task.catch(function (err) {
    if (!silent) {
      if (err && err.status === 401) toast('登录状态已失效，请重新进入页面');
      else toast((err && err.message) || '请求失败');
    }
    throw err;
  });
}

function get(path, query, options) {
  return request(path, Object.assign({ method: 'GET', query: query }, options || {}));
}

function post(path, data, options) {
  return request(path, Object.assign({ method: 'POST', data: data || {} }, options || {}));
}

function put(path, data, options) {
  return request(path, Object.assign({ method: 'PUT', data: data || {} }, options || {}));
}

function patch(path, data, options) {
  return request(path, Object.assign({ method: 'PATCH', data: data || {} }, options || {}));
}

function del(path, data, options) {
  return request(path, Object.assign({ method: 'DELETE', data: data || {} }, options || {}));
}

/* ------------------------------ 登录 ------------------------------ */

function wxLoginCode() {
  return new Promise(function (resolve, reject) {
    if (typeof wx === 'undefined' || !wx.login) {
      reject(new Error('当前环境不支持 wx.login'));
      return;
    }
    wx.login({
      success: function (res) {
        if (res && res.code) resolve(res.code);
        else reject(new Error('wx.login 未返回 code'));
      },
      fail: function (err) {
        reject(new Error((err && err.errMsg) || 'wx.login 失败'));
      },
    });
  });
}

function saveSession(payload) {
  if (!payload || !payload.token) return payload;
  setToken(payload.token);
  if (payload.user) setUser(payload.user);
  return payload;
}

function doLogin() {
  const inviteCode = config.storageGet(KEYS.inviteCode, '');
  return wxLoginCode()
    .then(function (code) {
      return post(
        '/api/auth/wx-login',
        { code: code, inviteCode: inviteCode || undefined },
        { auth: false, silent: true, retry: false }
      ).then(function (data) {
        // mock=true 表示后端未接真实微信，本次身份不稳定 → 走 dev-login 兜底拿演示账号
        if (data && data.token && !data.mock) return saveSession(data);
        return null;
      });
    })
    .catch(function () {
      return null;
    })
    .then(function (session) {
      if (session) return session;
      return post(
        '/api/auth/dev-login',
        { openid: getOpenid() },
        { auth: false, silent: true, retry: false }
      ).then(saveSession);
    });
}

/**
 * 登录（并发去重）。force=true 时强制重新登录。
 * @returns {Promise<{token:string, user:object, mock:boolean}>}
 */
function login(force) {
  if (loginTask) return loginTask;
  if (!force && getToken()) {
    return Promise.resolve({ token: getToken(), user: getUser() });
  }
  loginTask = doLogin()
    .then(function (data) {
      loginTask = null;
      return data;
    })
    .catch(function (err) {
      loginTask = null;
      throw err;
    });
  return loginTask;
}

/** 已有 token 直接返回，否则登录 */
function ensureLogin() {
  if (getToken()) return Promise.resolve({ token: getToken(), user: getUser() });
  return login().catch(function (err) {
    toast((err && err.message) || '登录失败，请稍后重试');
    throw err;
  });
}

/** 刷新当前用户信息（GET /api/me） */
function me() {
  return ensureLogin().then(function () {
    return get('/api/me').then(function (data) {
      if (data && data.user) setUser(data.user);
      return data;
    });
  });
}

function logout() {
  clearSession();
}

module.exports = {
  request: request,
  get: get,
  post: post,
  put: put,
  patch: patch,
  del: del,
  login: login,
  ensureLogin: ensureLogin,
  me: me,
  logout: logout,
  toast: toast,
  getToken: getToken,
  setToken: setToken,
  getUser: getUser,
  setUser: setUser,
  getOpenid: getOpenid,
  setOpenid: setOpenid,
  clearSession: clearSession,
  buildQuery: buildQuery,
  pageQuery: pageQuery,
};
