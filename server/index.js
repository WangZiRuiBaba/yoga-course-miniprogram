'use strict';
/**
 * 瑜伽卖课小程序 —— 服务入口。
 * 零运行时依赖：node:http + node:sqlite + node:crypto。
 *
 *   node server/index.js          # 生产式启动
 *   node --watch server/index.js  # 开发热重载
 *
 * 路由文件缺失会被跳过并在 /api/_health 暴露，便于分阶段开发。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const config = require('./config');
const { openDb } = require('./db');
const { seed, ensureInviteCodes } = require('./seed');
const { createRouter } = require('./http/router');
const { createContext } = require('./http/ctx');
const { resolveUser, resolveAdmin } = require('./http/auth');
const { serveStatic } = require('./http/static');
const { errors } = require('./http/errors');
const sweep = require('./sweep');

const MODULES = [
  'auth',
  'product',
  'order',
  'payment',
  'refund',
  'entitlement',
  'distribution',
  'service',
  'ai',
  'admin',
];

const MAX_BODY_BYTES = 1024 * 1024;

function createApp() {
  const db = openDb(config.dbPath);
  seed(db);
  ensureInviteCodes(db);

  const router = createRouter();
  const loaded = [];
  const missing = [];

  for (const name of MODULES) {
    const file = path.join(__dirname, 'modules', name, 'index.js');
    if (!fs.existsSync(file)) {
      missing.push(name);
      console.warn(`[boot] 模块未就绪，跳过: ${name}`);
      continue;
    }
    try {
      const mod = require(file);
      if (mod && typeof mod.mount === 'function') {
        mod.mount(router);
        loaded.push(name);
      } else {
        console.warn(`[boot] 模块 ${name} 未导出 mount()`);
        missing.push(name);
      }
    } catch (err) {
      console.error(`[boot] 模块 ${name} 加载失败:`, err && err.stack ? err.stack : err);
      missing.push(name);
    }
  }

  router.get('/api/_health', (ctx) => ({
    ok: true,
    time: new Date().toISOString(),
    env: config.env,
    modules: { loaded, missing },
    pay: { provider: config.pay.provider, mockAutoPay: config.pay.mockAutoPay },
    ai: { provider: config.ai.provider, model: config.ai.model },
    wx: { mock: config.wx.mock },
    sweeper: sweep.list(),
    version: require('../package.json').version,
  }));

  return { db, router, loaded, missing };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(errors.badRequest('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseBody(buf, contentType) {
  if (!buf || buf.length === 0) return {};
  const text = buf.toString('utf8');
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('application/json')) {
    if (!text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw errors.badRequest('请求体不是合法 JSON');
    }
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    const out = {};
    for (const [k, v] of new URLSearchParams(text)) out[k] = v;
    return out;
  }
  // 无 content-type 时尽力解析 JSON
  try {
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

/** 请求处理主函数；测试可直接 createServer(createHandler(app)) 复用。 */
async function handleRequest({ db, router }, req, res) {
    const started = Date.now();
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      res.statusCode = 400;
      res.end('Bad Request');
      return;
    }
    const pathname = decodeURIComponent(url.pathname);
    const query = {};
    for (const [k, v] of url.searchParams) query[k] = v;

    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Admin-Token');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Vary', 'Origin');

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    const ctx = createContext({
      req,
      res,
      pathname,
      query,
      params: {},
      body: {},
      db,
      config,
      log: (...args) => {
        if (!config.isProd) console.log('[req]', ...args);
      },
    });

    try {
      ctx.user = resolveUser(db, req, config);
      ctx.admin = resolveAdmin(db, req, config);

      if (pathname.startsWith('/api/')) {
        const rawBuffer = await readBody(req);
        /* 原始字节保留给需要验签的通道（微信支付 v3 回调必须对 raw body 验签） */
        ctx.rawBuffer = rawBuffer;
        ctx.rawBody = rawBuffer.toString('utf8');
        ctx.body = parseBody(rawBuffer, req.headers['content-type']);
      }

      // 后台页面别名
      if (pathname === '/admin' || pathname === '/admin/') {
        if (serveStatic(ctx, path.join(config.root, 'web'), '/admin.html')) return;
      }

      const hit = await router.handle(ctx);
      if (hit) return;

      // 静态资源：/mp/ 映射到 miniprogram 源码预览
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (pathname.startsWith('/mp/')) {
          if (serveStatic(ctx, path.join(config.root, 'miniprogram'), pathname.slice(3))) return;
        } else if (serveStatic(ctx, path.join(config.root, 'web'), pathname)) {
          return;
        }
        // SPA 兜底
        if (!pathname.startsWith('/api/')) {
          const indexHtml = path.join(config.root, 'web', 'index.html');
          if (fs.existsSync(indexHtml) && serveStatic(ctx, path.join(config.root, 'web'), '/index.html')) return;
        }
      }

      if (pathname.startsWith('/api/')) throw errors.notFound(`接口不存在: ${req.method} ${pathname}`);
      ctx.status(404).raw('text/plain; charset=utf-8', 'Not Found');
    } catch (err) {
      ctx.fail(err);
    } finally {
      if (!config.isProd && Date.now() - started > 1500) {
        console.warn(`[slow] ${req.method} ${pathname} ${Date.now() - started}ms`);
      }
    }
}

function createHandler(app) {
  return (req, res) => handleRequest(app, req, res);
}

function main() {
  const app = createApp();
  const { db, loaded, missing } = app;
  const server = http.createServer(createHandler(app));

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`\n[启动失败] 端口 ${config.port} 已被占用。换个端口：PORT=3101 node server/index.js\n`);
    } else {
      console.error('[server error]', err);
    }
    process.exitCode = 1;
  });

  server.listen(config.port, config.host, () => {
    sweep.start(10000);
    const shownHost = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
    console.log('');
    console.log('  瑜伽卖课小程序 · 后端已启动');
    console.log(`  H5 商城      http://${shownHost}:${config.port}/`);
    console.log(`  AI 商城      http://${shownHost}:${config.port}/#/ai`);
    console.log(`  后台管理      http://${shownHost}:${config.port}/admin`);
    console.log(`  健康检查      http://${shownHost}:${config.port}/api/_health`);
    console.log(`  环境 ${config.env} | 支付 ${config.pay.provider} | AI ${config.ai.provider} | 模块 ${loaded.length}/${MODULES.length}`);
    if (missing.length) console.log(`  ⚠ 未就绪模块: ${missing.join(', ')}`);
    console.log('');
  });

  const shutdown = (signal) => {
    console.log(`\n[shutdown] 收到 ${signal}，正在关闭…`);
    sweep.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => {
      db.close();
      process.exit(0);
    }, 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
  process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

  return server;
}

if (require.main === module) main();

module.exports = { main, createApp, createHandler };
