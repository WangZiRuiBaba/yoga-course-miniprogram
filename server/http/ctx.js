'use strict';
/** 请求上下文：路由 handler 的唯一入参，负责统一响应封装 */
const { ApiError, errors } = require('./errors');

function createContext({ req, res, pathname, query, params, body, db, config, log = () => {} }) {
  const headers = req.headers || {};
  const ctx = {
    req,
    res,
    db,
    config,
    log,
    method: req.method,
    path: pathname,
    query,
    params,
    body: body || {},
    /* 原始请求体：验签通道（微信支付 v3 回调）必须用原始字节，不要用解析后的对象 */
    rawBody: '',
    rawBuffer: null,
    headers,
    user: null,
    admin: null,
    ip: req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '',
    state: {},
    _sent: false,
    get sent() {
      return this._sent;
    },

    /** 强制要求已登录用户 */
    auth() {
      if (!ctx.user) throw errors.unauthorized();
      return ctx.user;
    },

    /** 强制要求后台身份 */
    adminAuth() {
      if (!ctx.admin) throw errors.unauthorized('请先登录后台');
      return ctx.admin;
    },

    header(name, value) {
      res.setHeader(name, value);
      return ctx;
    },

    status(code) {
      res.statusCode = code;
      return ctx;
    },

    /** 统一成功响应：{ ok:true, data } */
    json(data = null, status = 200) {
      if (ctx._sent) return;
      ctx._sent = true;
      const payload = JSON.stringify({ ok: true, data });
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Length', Buffer.byteLength(payload));
      res.end(payload);
    },

    /** 统一失败响应：{ ok:false, code, message, details } */
    fail(err) {
      if (ctx._sent) return;
      const e = err instanceof ApiError ? err : errors.internal(err && err.message);
      if (!(err instanceof ApiError)) {
        console.error(`[error] ${ctx.method} ${ctx.path}:`, err && err.stack ? err.stack : err);
      }
      ctx._sent = true;
      const payload = JSON.stringify({
        ok: false,
        code: e.code,
        message: e.message,
        ...(e.details ? { details: e.details } : {}),
      });
      res.statusCode = e.status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Length', Buffer.byteLength(payload));
      res.end(payload);
    },

    /** 原始响应（图片/SVG/文本/跳转） */
    raw(contentType, payload, status = 200, extraHeaders = {}) {
      if (ctx._sent) return;
      ctx._sent = true;
      const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
      res.statusCode = status;
      res.setHeader('Content-Type', contentType);
      for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
      res.setHeader('Content-Length', buf.length);
      res.end(buf);
    },

    redirect(location, status = 302) {
      if (ctx._sent) return;
      ctx._sent = true;
      res.statusCode = status;
      res.setHeader('Location', location);
      res.end();
    },
  };

  return ctx;
}

module.exports = { createContext };
