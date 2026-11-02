#!/usr/bin/env node
/**
 * 端到端冒烟：真实起一个 HTTP 服务（独立临时库），跑完整业务主链路。
 *
 *   node scripts/smoke.mjs          # 逐项打印 PASS/FAIL
 *   node scripts/smoke.mjs --keep   # 保留数据库文件便于排查
 *
 * 覆盖：健康检查 → 三账号登录 → 二级分销绑定 → 商品 → 下单 → 支付 → 权益
 *      → 佣金（一级/二级）→ 退款 → 佣金冲正 → 订单终态 → AI 商城对话 → 后台看板
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
const dbFile = path.join(ROOT, 'data', 'smoke.db');
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
if (!keep) {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
}

process.env.DB_PATH = dbFile;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'smoke-secret';
process.env.MOCK_AUTO_PAY = '1';
process.env.MOCK_PAY_DELAY_MS = '0';
process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
const { createApp, createHandler } = require(path.join(ROOT, 'server', 'index.js'));

const results = [];
function pass(name, extra = '') {
  results.push({ ok: true, name, extra });
  console.log(`  ✓ ${name}${extra ? `  ${extra}` : ''}`);
}
function fail(name, detail) {
  results.push({ ok: false, name, detail });
  console.log(`  ✗ ${name}\n      ${String(detail).slice(0, 400)}`);
}
function skip(name, why) {
  results.push({ ok: null, name, why });
  console.log(`  - ${name}（跳过：${why}）`);
}

async function main() {
  const app = createApp();
  const server = http.createServer(createHandler(app));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`\n  冒烟测试 → ${base}\n  模块：${app.loaded.join(', ') || '(无)'}`);
  if (app.missing.length) console.log(`  未加载：${app.missing.join(', ')}\n`);

  async function call(method, p, { body, token, admin } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    if (admin) headers['x-admin-token'] = admin;
    const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { ok: false, message: text.slice(0, 200) };
    }
    return { status: res.status, status2: res.status, ok: res.ok && json.ok === true, ...json };
  }

  const step = async (name, fn) => {
    try {
      await fn();
    } catch (err) {
      fail(name, err && err.stack ? err.stack : err);
    }
  };

  let tokA = '';
  let tokB = '';
  let tokC = '';
  let adminToken = '';
  let productId = '';
  let orderNo = '';
  let refundNo = '';
  let outTradeNo = '';

  await step('健康检查', async () => {
    const r = await call('GET', '/api/_health');
    if (!r.ok) return fail('/api/_health', JSON.stringify(r));
    if (r.data.modules.missing.length) fail('模块未全部就绪', r.data.modules.missing.join(','));
    else pass('健康检查', `模块 ${r.data.modules.loaded.length} 个`);
  });

  await step('登录与分销绑定', async () => {
    for (const [openid, key] of [['dev_demo_a', 'A'], ['dev_demo_b', 'B'], ['dev_demo_c', 'C']]) {
      const r = await call('POST', '/api/auth/dev-login', { body: { openid } });
      if (!r.ok) return fail(`登录 ${key}`, JSON.stringify(r));
      if (key === 'A') tokA = r.data.token;
      if (key === 'B') tokB = r.data.token;
      if (key === 'C') tokC = r.data.token;
    }
    pass('三个演示账号登录');

    /* 种子数据里 B 已绑 A、C 已绑 B，所以「已绑定」也算通过；只有既不是成功也不是重复绑定才算失败 */
    const bindB = await call('POST', '/api/dist/bind', { token: tokB, body: { inviteCode: 'DEMOA' } });
    if (bindB.ok) pass('B 绑定 A');
    else if (bindB.code === 'DUPLICATE') pass('B 绑定 A', '种子数据已绑定，跳过');
    else fail('B 绑定 A 的邀请码', JSON.stringify(bindB));

    const bindC = await call('POST', '/api/dist/bind', { token: tokC, body: { inviteCode: 'DEMOB' } });
    if (bindC.ok) pass('C 绑定 B');
    else if (bindC.code === 'DUPLICATE') pass('C 绑定 B', '种子数据已绑定，跳过');
    else fail('C 绑定 B 的邀请码', JSON.stringify(bindC));
  });

  await step('商品', async () => {
    const r = await call('GET', '/api/products');
    if (!r.ok) return fail('GET /api/products', JSON.stringify(r));
    const list = r.data.list || [];
    if (!list.length) return fail('商品列表为空', 'seed 未生效？');
    productId = list[0].id;
    pass('商品列表', `${list.length} 门，首门 ${list[0].title} ${list[0].priceText}`);
  });

  await step('下单', async () => {
    const r = await call('POST', '/api/orders', { token: tokC, body: { productId, quantity: 1, source: 'h5' } });
    if (!r.ok) return fail('下单', JSON.stringify(r));
    orderNo = r.data.orderNo;
    pass('C 下单', `${orderNo} ${r.data.totalText}`);
  });

  await step('支付', async () => {
    const r = await call('POST', `/api/orders/${orderNo}/pay`, { token: tokC });
    if (!r.ok) return fail('发起支付', JSON.stringify(r));
    outTradeNo = r.data.payParams && r.data.payParams.outTradeNo ? r.data.payParams.outTradeNo : r.data.payment && r.data.payment.outTradeNo;
    pass('发起支付', `provider=${r.data.provider}`);

    const n = await call('POST', '/api/pay/mock-notify', { body: { outTradeNo, success: true } });
    if (!n.ok) return fail('mock 支付回调', JSON.stringify(n));
    pass('mock 支付成功');

    let paid = false;
    for (let i = 0; i < 30; i += 1) {
      const s = await call('GET', `/api/pay/status/${outTradeNo}`, { token: tokC });
      if (s.ok && ['paid', 'completed'].includes(s.data.orderStatus)) {
        paid = true;
        break;
      }
      await new Promise((r2) => setTimeout(r2, 100));
    }
    if (!paid) fail('支付后订单状态', '轮询 3s 仍未 paid');
    else pass('订单状态已支付');
  });

  await step('权益', async () => {
    const r = await call('GET', '/api/my/entitlements', { token: tokC });
    if (!r.ok) return fail('我的课程', JSON.stringify(r));
    const list = r.data.list || r.data || [];
    if (!Array.isArray(list) || list.length === 0) return fail('支付后无权益', JSON.stringify(r.data).slice(0, 200));
    pass('权益已发放', `核销码 ${list[0].verifyCode}`);
  });

  await step('佣金', async () => {
    const b = await call('GET', '/api/dist/overview', { token: tokB });
    const a = await call('GET', '/api/dist/overview', { token: tokA });
    if (!b.ok) return fail('B 分销概览', JSON.stringify(b));
    if (!a.ok) return fail('A 分销概览', JSON.stringify(a));
    const bGot = (b.data.balance && (b.data.balance.pendingCents + b.data.balance.availableCents)) || 0;
    const aGot = (a.data.balance && (a.data.balance.pendingCents + a.data.balance.availableCents)) || 0;
    if (bGot <= 0) return fail('B 未获得一级佣金', JSON.stringify(b.data.balance));
    if (aGot <= 0) return fail('A 未获得二级佣金', JSON.stringify(a.data.balance));
    pass('两级佣金已产生', `一级 ${(bGot / 100).toFixed(2)} 元 / 二级 ${(aGot / 100).toFixed(2)} 元`);
  });

  await step('退款', async () => {
    const r = await call('POST', `/api/orders/${orderNo}/refund`, { token: tokC, body: { reason: '临时有事，先不学了' } });
    if (!r.ok) return fail('申请退款', JSON.stringify(r));
    refundNo = r.data.refundNo;
    pass('申请退款', `${refundNo} ${r.data.status} ${r.data.autoApproved ? '(自动通过)' : ''}`);

    if (r.data.status === 'pending') {
      const login = await call('POST', '/api/admin/login', { body: { username: 'admin', password: 'admin123' } });
      if (!login.ok) return fail('后台登录', JSON.stringify(login));
      adminToken = login.data.token;
      const ap = await call('POST', `/api/admin/refunds/${refundNo}/approve`, { admin: adminToken, body: {} });
      if (!ap.ok) return fail('后台通过退款', JSON.stringify(ap));
      pass('后台通过退款');
    }

    let done = false;
    for (let i = 0; i < 30; i += 1) {
      const d = await call('GET', `/api/orders/${orderNo}`, { token: tokC });
      if (d.ok && ['refunded', 'partial_refunded'].includes(d.data.order.status)) {
        done = true;
        break;
      }
      await new Promise((r2) => setTimeout(r2, 100));
    }
    if (!done) fail('订单退款终态', '3s 内未变成 refunded');
    else pass('订单已退款');
  });

  await step('佣金冲正', async () => {
    const b = await call('GET', '/api/dist/overview', { token: tokB });
    if (!b.ok) return fail('B 分销概览', JSON.stringify(b));
    const bal = b.data.balance || {};
    const net = (bal.pendingCents || 0) + (bal.availableCents || 0);
    if (net !== 0) fail('退款后佣金未归零', JSON.stringify(bal));
    else pass('佣金已冲正归零');
  });

  await step('AI 商城', async () => {
    const s = await call('POST', '/api/ai/session', { token: tokA });
    if (!s.ok) return fail('创建 AI 会话', JSON.stringify(s));
    const sid = s.data.sessionId;
    const c1 = await call('POST', '/api/ai/chat', { token: tokA, body: { sessionId: sid, text: '我想减脂，推荐个课程' } });
    if (!c1.ok) return fail('AI 推荐', JSON.stringify(c1));
    const cards = (c1.data.reply && c1.data.reply.cards) || [];
    if (!cards.some((c) => c.type === 'product')) fail('AI 未返回商品卡', JSON.stringify(c1.data.reply).slice(0, 300));
    else pass('AI 推荐出商品卡', cards[0].title);
  });

  await step('后台', async () => {
    if (!adminToken) {
      const login = await call('POST', '/api/admin/login', { body: { username: 'admin', password: 'admin123' } });
      if (!login.ok) return fail('后台登录', JSON.stringify(login));
      adminToken = login.data.token;
    }
    const st = await call('GET', '/api/admin/stats', { admin: adminToken });
    if (!st.ok) return fail('后台看板', JSON.stringify(st));
    pass('后台看板', `GMV ${st.data.orders.gmvText} / 退款 ${st.data.orders.refundedText} / 订单 ${st.data.orders.total}`);
  });

  const okCount = results.filter((r) => r.ok === true).length;
  const failCount = results.filter((r) => r.ok === false).length;
  const skipCount = results.filter((r) => r.ok === null).length;
  console.log(`\n  合计：通过 ${okCount} / 失败 ${failCount} / 跳过 ${skipCount}\n`);

  await new Promise((r) => server.close(r));
  try {
    app.db.close();
  } catch {
    /* ignore */
  }
  if (!keep) {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
  } else {
    console.log(`  数据库保留在 ${dbFile}\n`);
  }
  process.exitCode = failCount > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('\n  冒烟脚本异常：', err);
  process.exitCode = 1;
});
