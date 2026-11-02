#!/usr/bin/env node
'use strict';
/**
 * 浏览器端到端自检（零依赖）：用本机 Chrome / Edge 的 headless 模式 + CDP 协议，
 * 真实点击走一遍 H5 商城与后台，并截图留证。
 *
 * 用法：
 *   node scripts/browser-check.mjs                 # 默认 http://127.0.0.1:3100
 *   node scripts/browser-check.mjs --port 3220
 *   node scripts/browser-check.mjs --shots .tmp/shots --keep-open
 *
 * 退出码：0 = 全部通过；1 = 有失败项或页面有 JS 报错。
 * 说明：脚本不引入任何 npm 依赖，浏览器用系统已装的 Chrome/Edge；找不到浏览器时跳过并以 0 退出。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/* ------------------------------- 参数 ------------------------------- */
const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const PORT = Number(argOf('port', process.env.PORT || 3100));
const BASE = argOf('base', `http://127.0.0.1:${PORT}`);
const SHOTS = path.resolve(argOf('shots', path.join(os.tmpdir(), 'yoga-shots')));
const KEEP_OPEN = argv.includes('--keep-open');

/* ---------------------- 结果收集与打印 ---------------------- */
const results = [];
const consoleErrors = [];
let shots = 0;
function ok(label, extra) {
  results.push({ ok: true, label, extra });
  console.log(`  ✓ ${label}${extra ? '  ' + extra : ''}`);
}
function bad(label, extra) {
  results.push({ ok: false, label, extra });
  console.log(`  ✗ ${label}${extra ? '  ' + extra : ''}`);
}
function step(title) {
  console.log(`\n【${title}】`);
}

/* ---------------------- 找浏览器 ---------------------- */
function findBrowser() {
  const cands = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return cands.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

/* ---------------------- 极简 CDP 客户端 ---------------------- */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.onEvent = () => {};
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || 'CDP error'));
        else resolve(msg.result);
      } else if (msg.method) {
        this.onEvent(msg);
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
    });
    return new CDP(ws);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, 30000);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------- 启动浏览器 ---------------------- */
async function launch() {
  const exe = findBrowser();
  if (!exe) return null;
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoga-chrome-'));
  const dbgPort = Number(argOf('cdp-port', 9333));

  /* 注意：本机沙箱可能禁止「被捕获的管道 stdio」，因此用 stdio:'ignore' 启动，
     改从 http://127.0.0.1:<port>/json/version 取 DevTools 地址（比解析 stderr 更稳）。 */
  const proc = spawn(
    exe,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--hide-scrollbars',
      '--mute-audio',
      '--window-size=430,932',
      `--remote-debugging-port=${dbgPort}`,
      `--user-data-dir=${userDir}`,
      'about:blank',
    ],
    { stdio: 'ignore', detached: false }
  );

  const spawnError = await new Promise((resolve) => {
    proc.once('error', (e) => resolve(e));
    setTimeout(() => resolve(null), 300);
  });
  if (spawnError) {
    console.log(`  ⚠ 浏览器启动失败（${spawnError.code || spawnError.message}），跳过浏览器部分`);
    return null;
  }

  let wsUrl = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    try {
      const r = await fetch(`http://127.0.0.1:${dbgPort}/json/version`);
      const j = await r.json();
      if (j.webSocketDebuggerUrl) {
        wsUrl = j.webSocketDebuggerUrl;
        break;
      }
    } catch {
      /* 端口还没起来，继续等 */
    }
    if (proc.exitCode !== null) break;
    await sleep(250);
  }
  if (!wsUrl) {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    return null;
  }

  return { exe, proc, wsUrl, userDir };
}

/* ---------------------- 页面会话封装 ---------------------- */
function createPage(cdp, sessionId) {
  const errors = [];
  const httpErrors = [];
  cdp.onEvent = (msg) => {
    if (msg.sessionId !== sessionId) return;
    const p = msg.params || {};
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = p.exceptionDetails || {};
      errors.push('异常: ' + (d.exception?.description || d.text || 'unknown').split('\n')[0]);
    } else if (msg.method === 'Runtime.consoleAPICalled' && p.type === 'error') {
      errors.push('console.error: ' + (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
    } else if (msg.method === 'Network.responseReceived') {
      const r = p.response || {};
      if (r.status >= 400 && !/favicon/.test(r.url || '')) {
        httpErrors.push(`${r.status} ${String(r.url).replace(/^https?:\/\/[^/]+/, '')}`);
      }
    }
  };

  const page = {
    errors,
    httpErrors,
    async evaluate(expression) {
      const r = await cdp.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true, userGesture: true },
        sessionId
      );
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'evaluate 失败');
      }
      return r.result ? r.result.value : undefined;
    },
    async gotourl(url) {
      await cdp.send('Page.navigate', { url }, sessionId);
      await sleep(400);
      await page.waitFor('document.readyState === "complete"', 12000);
      await sleep(500);
    },
    async go(hash) {
      await page.evaluate(`location.hash = ${JSON.stringify(hash)}`);
      await sleep(700);
    },
    async text() {
      return (await page.evaluate('document.body ? document.body.innerText : ""')) || '';
    },
    async waitFor(expression, timeout = 8000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        try {
          if (await page.evaluate(`!!(${expression})`)) return true;
        } catch {
          /* 页面切换过程中可能取不到 document，重试 */
        }
        await sleep(150);
      }
      return false;
    },
    async click(selector, label) {
      const r = await page.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return 'missing';
        el.scrollIntoView({ block: 'center' });
        el.click();
        return 'ok';
      })()`);
      if (r !== 'ok') throw new Error(`找不到元素 ${label || selector}`);
      await sleep(350);
    },
    async fill(selector, value) {
      const r = await page.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return 'missing';
        el.focus();
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return 'ok';
      })()`);
      if (r !== 'ok') throw new Error(`找不到输入框 ${selector}`);
      await sleep(150);
    },
    async shot(name) {
      try {
        fs.mkdirSync(SHOTS, { recursive: true });
        const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
        const file = path.join(SHOTS, name.endsWith('.png') ? name : name + '.png');
        fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
        shots += 1;
        return file;
      } catch {
        return null;
      }
    },
  };
  return page;
}

/* ---------------------- 主流程 ---------------------- */
async function main() {
  console.log('瑜伽卖课小程序 · 浏览器端到端自检');
  console.log(`  目标：${BASE}`);
  console.log(`  截图：${SHOTS}`);

  /* 服务可达性 */
  try {
    const r = await fetch(BASE + '/api/_health');
    const j = await r.json();
    if (!j.ok) throw new Error('health 返回异常');
    step('服务');
    ok('服务可达', `模块 ${j.data.modules.loaded.length} 个，missing ${j.data.modules.missing.length} 个`);
    if (j.data.modules.missing.length) bad('模块未全部就绪', j.data.modules.missing.join(','));
  } catch (err) {
    console.error(`\n✗ 服务不可达：${BASE}（先执行 node server/index.js）`);
    process.exit(1);
  }

  const browser = await launch();
  if (!browser) {
    console.log('\n⚠ 未找到 Chrome/Edge，跳过浏览器部分（其余检查请用 scripts/smoke.mjs）');
    process.exit(0);
  }
  console.log(`  浏览器：${browser.exe}`);

  const cdp = await CDP.connect(browser.wsUrl);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width: 430, height: 932, deviceScaleFactor: 2, mobile: true },
    sessionId
  );
  const page = createPage(cdp, sessionId);

  let fatal = null;
  try {
    /* ---------- 1. H5 登录与首页 ---------- */
    step('H5 商城：登录 / 首页 / 列表');
    await page.gotourl(`${BASE}/#/login?demo=dev_demo_c`);
    await sleep(1500);
    await page.shot('01-login');
    const bodyAfterLogin = await page.text();
    if (/退出|我的|课程/.test(bodyAfterLogin)) ok('演示账号 dev_demo_c 自动登录');
    else bad('演示账号自动登录', bodyAfterLogin.slice(0, 80).replace(/\n/g, ' '));

    await page.go('/home');
    await page.waitFor('document.querySelector("#view") && document.querySelector("#view").innerText.length > 0');
    const homeText = await page.text();
    await page.shot('02-home');
    if (/课程|瑜伽/.test(homeText)) ok('首页渲染');
    else bad('首页渲染', homeText.slice(0, 80).replace(/\n/g, ' '));

    await page.go('/products');
    await page.waitFor('document.querySelector("#view").innerText.length > 0');
    const listText = await page.text();
    await page.shot('03-products');
    if (/¥|价格|课程/.test(listText)) ok('商品列表渲染');
    else bad('商品列表渲染', listText.slice(0, 80).replace(/\n/g, ' '));

    /* ---------- 2. 商品 → 下单 → 支付 ---------- */
    step('主流程：商品详情 → 下单 → 收银台支付');
    const firstId = await page.evaluate(
      `fetch('/api/products?size=1').then(r => r.json()).then(j => (j.data.list[0] || {}).id || '')`
    );
    if (!firstId) throw new Error('取不到商品 ID');
    await page.go(`/product/${firstId}`);
    await page.waitFor('document.querySelector("#buy-now")');
    await page.shot('04-product');
    ok('商品详情打开', firstId);

    await page.click('#buy-now', '#buy-now');
    await page.waitFor('document.querySelector("#submit-order")');
    await page.shot('05-checkout');
    ok('结算页打开');

    await page.click('#submit-order', '#submit-order');
    const gotCashier = await page.waitFor('document.querySelector("#paid-btn") || /cashier/.test(location.hash)', 10000);
    await page.shot('06-cashier');
    if (gotCashier) ok('收银台已生成订单');
    else bad('收银台未打开', (await page.text()).slice(0, 120).replace(/\n/g, ' '));

    /* mock 环境 200ms 自动支付成功，这里点「我已支付」走 mock-notify 幂等通道 */
    if (await page.waitFor('document.querySelector("#paid-btn")', 4000)) {
      await page.click('#paid-btn', '#paid-btn');
      const paid = await page.waitFor('/已支付|支付成功|待核销|查看我的课程/.test(document.body.innerText)', 12000);
      await sleep(600);
      await page.shot('07-paid');
      if (paid) ok('mock 支付成功并进入已支付态');
      else bad('支付后状态未刷新', (await page.text()).slice(0, 120).replace(/\n/g, ' '));
    }

    /* 订单号从 hash 路由里取（/cashier/<orderNo>），把正则放在 Node 侧，
       避免在 Runtime.evaluate 模板串里二次转义 \d 出错 */
    const hashNow = await page.evaluate('location.hash');
    const orderNo = (/#\/cashier\/(YO[0-9]+)/.exec(hashNow) || [])[1] || '';

    /* ---------- 3. 订单 → 退款 ---------- */
    step('主流程：订单列表 → 申请退款');
    await page.go('/orders');
    await page.waitFor('document.querySelector("#view").innerText.length > 0');
    await page.shot('08-orders');
    const ordersText = await page.text();
    if (orderNo ? ordersText.includes(orderNo) : /订单|待/.test(ordersText)) ok('订单列表可见');
    else bad('订单列表缺新订单', ordersText.slice(0, 100).replace(/\n/g, ' '));

    const refundOrderNo =
      orderNo ||
      (await page.evaluate(
        `fetch('/api/orders?size=1', { headers: { authorization: 'Bearer ' + (localStorage.getItem('yoga_user_token') || '') } }).then(r => r.json()).then(j => ((j.data && j.data.list) || [])[0]?.orderNo || '')`
      ));
    if (refundOrderNo) {
      await page.go(`/refund/${refundOrderNo}`);
      await page.waitFor('document.querySelector("#refund-submit")', 8000);
      await page.shot('09-refund');
      const canRefund = await page.evaluate(
        `(() => { const b = document.querySelector('#refund-submit'); return !!(b && !b.disabled); })()`
      );
      if (canRefund) {
        await page.click('#refund-submit', '#refund-submit');
        const refunded = await page.waitFor('/退款|已提交|审核/.test(document.body.innerText)', 12000);
        await sleep(800);
        await page.shot('10-refund-done');
        if (refunded) ok('退款申请已提交');
        else bad('退款申请无反馈', (await page.text()).slice(0, 120).replace(/\n/g, ' '));
      } else {
        ok('退款页正确置灰（订单不可退）');
      }
    } else {
      bad('取不到可退款订单号');
    }

    /* ---------- 4. AI 商城 ---------- */
    step('AI 商城：引导 → 商品卡 → 下单 → 支付 → 退款');
    await page.go('/ai');
    await page.waitFor('document.querySelector("#ai-input")', 10000);
    await page.shot('11-ai');
    await page.fill('#ai-input', '我想减脂');
    await page.click('#ai-send', '#ai-send');
    const gotCard = await page.waitFor('/¥|卡片|训练营|年卡|推荐/.test(document.body.innerText)', 12000);
    await sleep(600);
    await page.shot('12-ai-recommend');
    if (gotCard) ok('AI 推荐出商品');
    else bad('AI 未给出商品推荐', (await page.text()).slice(0, 140).replace(/\n/g, ' '));

    const actionBtn = await page.evaluate(
      `(() => {
        const btns = [...document.querySelectorAll('[data-ai-action]')];
        const pick = btns.find(b => /create_order/.test(b.dataset.aiAction)) || btns[0];
        return pick ? pick.dataset.aiAction + '|' + (pick.textContent || '').trim() : '';
      })()`
    );
    if (actionBtn) {
      await page.evaluate(
        `(() => {
          const btns = [...document.querySelectorAll('[data-ai-action]')];
          const pick = btns.find(b => /create_order/.test(b.dataset.aiAction)) || btns[0];
          if (pick) pick.click();
        })()`
      );
      await sleep(1800);
      await page.shot('13-ai-action');
      ok('AI 动作按钮可点', actionBtn);
    } else {
      bad('AI 未渲染动作按钮');
    }

    await page.fill('#ai-input', '退款');
    await page.click('#ai-send', '#ai-send');
    const aiRefund = await page.waitFor('/退款|没有|可退/.test(document.body.innerText)', 12000);
    await sleep(600);
    await page.shot('14-ai-refund');
    if (aiRefund) ok('AI 退款意图有回复');
    else bad('AI 退款意图无回复');

    /* ---------- 5. 分销 / 课程 / 客服 ---------- */
    step('二级分销 / 我的课程 / 客服');
    await page.go('/dist');
    await page.waitFor('document.querySelector("#view").innerText.length > 0');
    await page.shot('15-dist');
    const distText = await page.text();
    if (/邀请|佣金|团队|分销/.test(distText)) ok('分销中心渲染');
    else bad('分销中心渲染', distText.slice(0, 100).replace(/\n/g, ' '));

    await page.go('/courses');
    await page.waitFor('document.querySelector("#view").innerText.length > 0');
    await page.shot('16-courses');
    const coursesText = await page.text();
    if (/课程|核销|暂无/.test(coursesText)) ok('我的课程渲染');
    else bad('我的课程渲染', coursesText.slice(0, 100).replace(/\n/g, ' '));

    await page.go('/service');
    await page.waitFor('document.querySelector("#view").innerText.length > 0');
    await page.shot('17-service');
    const svcText = await page.text();
    if (/客服|发送|消息|咨询/.test(svcText)) ok('在线客服渲染');
    else bad('在线客服渲染', svcText.slice(0, 100).replace(/\n/g, ' '));

    /* ---------- 6. 后台 ---------- */
    step('后台管理：登录 → 看板 → 退款 / 提现 / 设置');
    await page.gotourl(`${BASE}/admin`);
    await page.waitFor('document.querySelector("#login-submit") || document.querySelector("#trend-canvas")', 12000);
    await page.shot('18-admin-login');
    if (await page.waitFor('document.querySelector("#login-submit")', 3000)) {
      await page.click('#login-submit', '#login-submit');
      const logged = await page.waitFor('document.querySelector("#trend-canvas") || /看板|GMV/.test(document.body.innerText)', 12000);
      await sleep(900);
      await page.shot('19-admin-dashboard');
      if (logged) ok('后台登录并进入看板');
      else bad('后台登录失败', (await page.text()).slice(0, 120).replace(/\n/g, ' '));
    } else {
      ok('后台已是登录态');
    }

    for (const [hash, key, label] of [
      ['/refunds', '退款', '退款审核页'],
      ['/withdrawals', '提现', '提现审核页'],
      ['/settings', '参数|设置|佣金', '业务参数页'],
      ['/service', '会话|客服', '后台客服页'],
    ]) {
      await page.evaluate(`location.hash = ${JSON.stringify(hash)}`);
      await sleep(1200);
      const t = await page.text();
      if (new RegExp(key).test(t)) ok(label + '渲染');
      else bad(label + '渲染', t.slice(0, 90).replace(/\n/g, ' '));
    }
    await page.shot('20-admin-settings');

    /* ---------- 7. 控制台错误 ---------- */
    step('前端控制台');
    if (page.errors.length === 0) ok('无 JS 异常 / console.error');
    else {
      bad('存在前端报错', `${page.errors.length} 条`);
      page.errors.slice(0, 8).forEach((e) => console.log('      · ' + e));
    }
    const server5xx = page.httpErrors.filter((e) => e.startsWith('5'));
    const client4xx = page.httpErrors.filter((e) => !e.startsWith('5'));
    if (server5xx.length === 0) ok('无 5xx 响应');
    else {
      bad('存在 5xx 响应', `${server5xx.length} 条`);
      server5xx.slice(0, 8).forEach((e) => console.log('      · ' + e));
    }
    if (client4xx.length) {
      console.log(`  · 4xx 提示（未登录态探测属正常）：${client4xx.length} 条`);
      [...new Set(client4xx)].slice(0, 8).forEach((e) => console.log('      · ' + e));
    }
  } catch (err) {
    fatal = err;
  } finally {
    if (!KEEP_OPEN) {
      cdp.close();
      try {
        browser.proc.kill();
      } catch {
        /* ignore */
      }
      await sleep(300);
      try {
        fs.rmSync(browser.userDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  /* ---------------------- 汇总 ---------------------- */
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log(`\n${'─'.repeat(52)}`);
  if (fatal) console.log(`中断：${fatal.message}`);
  console.log(`结果：通过 ${pass} / 失败 ${fail} / 截图 ${shots} 张`);
  console.log(`截图目录：${SHOTS}`);
  if (fail > 0 || fatal) {
    console.log('\n失败项：');
    results.filter((r) => !r.ok).forEach((r) => console.log(`  · ${r.label}${r.extra ? ' — ' + r.extra : ''}`));
    process.exit(1);
  }
  console.log('全部通过 ✅');
  process.exit(0);
}

main().catch((err) => {
  console.error('未捕获错误：', err);
  process.exit(1);
});
