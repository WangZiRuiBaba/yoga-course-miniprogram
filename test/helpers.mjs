/**
 * 测试辅助（仅测试使用）。
 *
 * 每个测试文件是独立进程，所以这里用 pid 生成独立 SQLite 文件，
 * 绝不碰 data/dev.db —— 多人并行开发时不会互相干扰。
 *
 * 用法：
 *   import { startServer, api, demoLogin, adminLogin } from './helpers.mjs';
 *   const ctx = await startServer();          // 随机端口
 *   const tok = await demoLogin(ctx.base, 'dev_demo_a');
 *   const r = await api(ctx.base, 'GET', '/api/products', { token: tok });
 *   t.after(() => ctx.close());
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- 必须先设环境变量，再 require 服务（config 在 require 时读取） ----
const dbFile = path.join(ROOT, 'data', `test-${process.pid}.db`);
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
for (const suffix of ['', '-wal', '-shm']) {
  try {
    fs.rmSync(dbFile + suffix);
  } catch {
    /* 不存在即可 */
  }
}
process.env.DB_PATH = dbFile;
process.env.MOCK_AUTO_PAY = process.env.MOCK_AUTO_PAY || '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-do-not-use-in-prod';
process.env.ALLOW_DEV_LOGIN = process.env.ALLOW_DEV_LOGIN || '1';

const require = createRequire(import.meta.url);
const { createApp, createHandler } = require(path.join(ROOT, 'server', 'index.js'));

export { require, dbFile };

/** 起一个真实 HTTP 服务（随机端口），返回 { base, app, db, close } */
export async function startServer() {
  const app = createApp();
  const server = http.createServer(createHandler(app));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    app,
    db: app.db,
    server,
    base,
    loaded: app.loaded,
    missing: app.missing,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      try {
        app.db.close();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * 调接口。
 * @returns {Promise<{status:number, ok:boolean, code?:string, message?:string, data:any, raw:any}>}
 */
export async function api(base, method, p, opts = {}) {
  const { body, token, adminToken, headers = {} } = opts;
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = `Bearer ${token}`;
  if (adminToken) h['x-admin-token'] = adminToken;
  const res = await fetch(base + p, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let raw;
  try {
    raw = text ? JSON.parse(text) : null;
  } catch {
    raw = text;
  }
  return {
    status: res.status,
    ok: res.ok && raw && raw.ok === true,
    code: raw && raw.code,
    message: raw && raw.message,
    data: raw && raw.ok ? raw.data : undefined,
    raw,
  };
}

/** 演示用户登录 → token（openid: dev_demo_a / dev_demo_b / dev_demo_c 或任意自造） */
export async function demoLogin(base, openid = 'dev_demo_a', nickname) {
  const r = await api(base, 'POST', '/api/auth/dev-login', { body: { openid, nickname } });
  if (!r.ok) throw new Error(`dev-login 失败: ${JSON.stringify(r.raw)}`);
  return r.data.token;
}

/** 后台登录 → token（默认 admin/admin123） */
export async function adminLogin(base, username = 'admin', password = 'admin123') {
  const r = await api(base, 'POST', '/api/admin/login', { body: { username, password } });
  if (!r.ok) throw new Error(`admin 登录失败: ${JSON.stringify(r.raw)}`);
  return r.data.token;
}

/** 断言成功，失败时把完整响应打出来，便于定位 */
export function assertOk(res, label = '') {
  if (!res.ok) {
    throw new Error(`${label} 期望成功，实际 ${res.status} ${res.code}: ${res.message}\n${JSON.stringify(res.raw)}`);
  }
  return res.data;
}

/** 睡一会儿（等异步事件/定时任务） */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
