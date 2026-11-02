'use strict';
/**
 * 迷你路由：支持 :param 与 * 通配，支持路由级鉴权声明，自动封装响应。
 *
 * 用法：
 *   const router = createRouter();
 *   router.get('/api/products', handler);
 *   router.post('/api/orders', { auth: true }, handler);
 *   router.get('/api/admin/orders', { auth: 'admin' }, handler);
 *
 * handler: async (ctx) => data        // 返回值自动变成 { ok:true, data }
 *          async (ctx) => { ctx.json(...) }  // 自行响应也可以
 */
const { ApiError, errors } = require('./errors');

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compile(pattern) {
  const clean = pattern.split('?')[0];
  const segs = clean.split('/').filter((s) => s.length > 0);
  const keys = [];
  const parts = segs.map((seg) => {
    if (seg.startsWith(':')) {
      keys.push(seg.slice(1));
      return '/([^/]+)';
    }
    if (seg === '*') {
      keys.push('*');
      return '(?:/(.*))?';
    }
    return `/${escapeRegex(seg)}`;
  });
  const source = `^${parts.join('') || '/'}/?$`;
  return { regex: new RegExp(source), keys, pattern };
}

function createRouter() {
  const routes = [];

  function add(method, pattern, opts, handler) {
    const compiled = compile(pattern);
    routes.push({ method: method.toUpperCase(), handler, opts: opts || {}, ...compiled });
  }

  function register(method) {
    return (pattern, opts, handler) => {
      if (typeof opts === 'function') {
        add(method, pattern, {}, opts);
      } else {
        add(method, pattern, opts || {}, handler);
      }
    };
  }

  const router = {
    routes,
    add,
    get: register('GET'),
    post: register('POST'),
    put: register('PUT'),
    patch: register('PATCH'),
    delete: register('DELETE'),
    all: register('ALL'),

    match(method, pathname) {
      const upper = String(method || 'GET').toUpperCase();
      for (const route of routes) {
        if (route.method !== 'ALL' && route.method !== upper) continue;
        const m = route.regex.exec(pathname);
        if (!m) continue;
        const params = {};
        route.keys.forEach((key, i) => {
          const raw = m[i + 1];
          if (raw === undefined) return;
          if (key === '*') params['*'] = raw;
          else {
            try {
              params[key] = decodeURIComponent(raw);
            } catch {
              params[key] = raw;
            }
          }
        });
        return { route, params };
      }
      return null;
    },

    /** @returns {Promise<boolean>} 是否命中路由 */
    async handle(ctx) {
      const matched = router.match(ctx.method, ctx.path);
      if (!matched) return false;
      const { route, params } = matched;
      ctx.params = params;

      try {
        const mode = route.opts.auth;
        if (mode === 'admin') ctx.adminAuth();
        else if (mode === true || mode === 'user') ctx.auth();

        const result = await route.handler(ctx);
        if (!ctx.sent && result !== undefined) ctx.json(result);
        else if (!ctx.sent) ctx.json(null);
      } catch (err) {
        const e = err instanceof ApiError ? err : errors.internal(err && err.message ? err.message : '服务异常');
        if (!(err instanceof ApiError)) {
          console.error(`[route] ${ctx.method} ${ctx.path}`, err && err.stack ? err.stack : err);
        }
        ctx.fail(e);
      }
      return true;
    },
  };

  return router;
}

module.exports = { createRouter, compile };
