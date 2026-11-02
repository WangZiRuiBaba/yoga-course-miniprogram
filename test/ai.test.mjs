/**
 * AI 商城 + 在线客服 后端验收测试（docs/API.md §9 / §10）。
 *
 * 覆盖：AI 会话创建/复用、11 类意图的关键分支、动作按钮、支付与退款、订单/权益卡片、
 *       客服会话唯一 open、未读计数、后台回复、ai_messages / ai_actions 落库、限流与参数校验。
 *
 * commerce / refund / entitlement 由他人并行开发：这里按 startServer().loaded 动态分支，
 * 模块未就绪时断言「友好降级」而不是失败，模块就绪后自动走真实链路。
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startServer, api, demoLogin, adminLogin, assertOk, sleep, require as cjsRequire, ROOT } from './helpers.mjs';

let env = null;
let base = '';
let db = null;
let loaded = [];

before(async () => {
  env = await startServer();
  base = env.base;
  db = env.db;
  loaded = env.loaded;
});

after(async () => {
  if (env) await env.close();
});

const has = (name) => loaded.includes(name);
const money = (text) => assert.match(String(text), /^\d+\.\d{2}$/, `金额文案格式应为 12.34，实际 ${text}`);

/** 登录一个独立用户，避免用例之间互相影响 */
async function login(openid, nickname) {
  return demoLogin(base, openid, nickname || openid);
}

async function chat(token, sessionId, text) {
  const res = await api(base, 'POST', '/api/ai/chat', { token, body: { sessionId, text } });
  return assertOk(res, `chat「${text}」`);
}

async function openSession(token) {
  return assertOk(await api(base, 'POST', '/api/ai/session', { token, body: {} }), 'ai/session');
}

/* ------------------------------------------------------------------ *
 * 1. 会话
 * ------------------------------------------------------------------ */
test('AI 会话：创建后可复用，历史消息可回读，未登录被拒', async () => {
  const token = await login('dev_ai_s1', '会话用户');

  const first = await openSession(token);
  assert.ok(first.sessionId, 'sessionId 不能为空');
  assert.equal(first.state.stage, 'idle');
  assert.equal(first.provider, 'rule', '默认 provider 应为 rule');
  assert.deepEqual(first.messages, []);

  const second = await openSession(token);
  assert.equal(second.sessionId, first.sessionId, '同一用户应复用活跃会话');

  await chat(token, first.sessionId, '你好');
  const detail = assertOk(await api(base, 'GET', `/api/ai/session/${first.sessionId}`, { token }), 'session 详情');
  assert.ok(detail.messages.length >= 2);
  assert.equal(detail.messages[0].role, 'user');
  assert.equal(detail.messages[1].role, 'assistant');
  assert.ok(detail.state.intent, 'state.intent 应被记录');

  const anon = await api(base, 'POST', '/api/ai/session', { body: {} });
  assert.equal(anon.status, 401);
  assert.equal(anon.code, 'UNAUTHORIZED');

  const other = await api(base, 'GET', `/api/ai/session/${first.sessionId}`, { token: await login('dev_ai_s1_b') });
  assert.equal(other.status, 404, '别人的会话不能被读到');
});

/* ------------------------------------------------------------------ *
 * 2. recommend
 * ------------------------------------------------------------------ */
test('意图 recommend：我想减脂 → product 卡片 + 下单按钮', async () => {
  const token = await login('dev_ai_recommend', '想减脂');
  const session = await openSession(token);
  const data = await chat(token, session.sessionId, '我想减脂');

  assert.equal(data.state.intent, 'recommend');
  assert.ok(data.reply.content.length > 0, '要有中文回复');
  assert.ok(data.reply.cards.length >= 1, '至少一张卡片');

  const card = data.reply.cards[0];
  assert.equal(card.type, 'product');
  assert.ok(card.productId);
  assert.ok(card.title);
  assert.equal(typeof card.priceCents, 'number');
  money(card.priceText);
  assert.ok(Array.isArray(card.tags) && card.tags.includes('减脂'), '减脂课程应带减脂标签');

  const actions = data.reply.actions.map((a) => a.action);
  assert.ok(actions.includes('create_order'), '要有「立即下单」按钮');
  assert.ok(actions.includes('open_product'), '要有「看看详情」按钮');
  assert.equal(data.state.lastProductId, card.productId, 'state.lastProductId 应记住选中课程');

  // 落库：user + assistant 两条
  const rows = db.all('SELECT role, content FROM ai_messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC', session.sessionId);
  assert.ok(rows.length >= 2);
  assert.deepEqual(rows.slice(-2).map((r) => r.role), ['user', 'assistant']);
});

test('意图 price：多少钱 → 报价 + 下单按钮', async () => {
  const token = await login('dev_ai_price', '问价');
  const session = await openSession(token);
  const data = await chat(token, session.sessionId, '多少钱，有优惠吗');
  assert.equal(data.state.intent, 'price');
  assert.match(data.reply.content, /¥\d/);
  assert.ok(data.reply.cards.some((c) => c.type === 'product'));
  assert.ok(data.reply.actions.some((a) => a.action === 'create_order'));
});

/* ------------------------------------------------------------------ *
 * 3. create_order / pay
 * ------------------------------------------------------------------ */
test('意图 create_order：买这个 → 收银台（commerce 未就绪时友好降级）', async () => {
  const token = await login('dev_ai_order', '下单');
  const session = await openSession(token);
  const rec = await chat(token, session.sessionId, '我想减脂');
  const productId = rec.state.lastProductId;
  assert.ok(productId);

  const data = await chat(token, session.sessionId, '买这个');
  assert.equal(data.state.intent, 'create_order');

  if (has('order')) {
    assert.ok(data.reply.cards.some((c) => c.type === 'pay' || c.type === 'order'), '应给出收银台或订单卡片');
    assert.ok(data.state.lastOrderNo, 'state.lastOrderNo 应记录订单号');
    assert.match(data.state.lastOrderNo, /^[A-Z]{2}\d+/, '订单号格式');

    const order = db.get('SELECT * FROM orders WHERE order_no = ?', data.state.lastOrderNo);
    assert.ok(order, '订单应真正落库');
    assert.equal(order.source, 'ai', '来源标记 ai');
    assert.ok(order.total_cents > 0);

    if (has('payment')) {
      const payCard = data.reply.cards.find((c) => c.type === 'pay');
      assert.ok(payCard, '支付模块就绪时应返回 pay 卡片');
      assert.ok(payCard.outTradeNo, 'pay 卡片要带 outTradeNo');
      money(payCard.amountText);
      assert.ok(data.reply.actions.some((a) => a.action === 'mock_pay'), '要有「我已支付」按钮');
    }
  } else {
    assert.match(data.reply.content, /暂未开放|稍后再试/, '缺模块要友好降级');
  }
});

test('意图 mock_pay：我已支付 → 已支付并给权益/提示', async () => {
  const token = await login('dev_ai_pay', '支付');
  const session = await openSession(token);
  await chat(token, session.sessionId, '我想减脂');
  const created = await chat(token, session.sessionId, '买这个');

  if (!has('payment') || !created.state.lastOrderNo) {
    const data = await chat(token, session.sessionId, '我已支付');
    assert.match(data.reply.content, /暂未开放|稍后再试|没有待支付/, '缺支付模块要友好降级');
    return;
  }

  const data = await chat(token, session.sessionId, '我已支付');
  assert.equal(data.state.intent, 'mock_pay');
  assert.match(data.reply.content, /支付成功|已开通/);

  // 订单必须已支付（MOCK_AUTO_PAY=1 时可能已经自动支付，这里只校验终态）
  let order = db.get('SELECT * FROM orders WHERE order_no = ?', data.state.lastOrderNo || created.state.lastOrderNo);
  for (let i = 0; i < 20 && order && order.status === 'pending'; i += 1) {
    await sleep(50);
    order = db.get('SELECT * FROM orders WHERE order_no = ?', order.order_no);
  }
  assert.ok(['paid', 'completed'].includes(order.status), `订单应为已支付，实际 ${order.status}`);
  assert.ok(Number(order.paid_cents) > 0);

  const cards = data.reply.cards;
  if (has('entitlement')) {
    assert.ok(cards.some((c) => c.type === 'entitlement'), '支付成功后应给权益卡片');
    const ent = cards.find((c) => c.type === 'entitlement');
    assert.match(String(ent.verifyCode), /^\d{8}$/, '核销码应为 8 位数字');
  } else {
    assert.ok(cards.length >= 1, '权益未就绪时至少给一条提示卡片');
  }
});

test('动作接口：create_order / mock_pay 按钮走 /api/ai/action', async () => {
  const token = await login('dev_ai_action', '按钮');
  const session = await openSession(token);
  const rec = await chat(token, session.sessionId, '我想减脂');
  const productId = rec.state.lastProductId;

  const created = await api(base, 'POST', '/api/ai/action', {
    token,
    body: { sessionId: session.sessionId, action: 'create_order', payload: { productId } },
  });
  assert.equal(created.status, 200, '动作失败也要 HTTP 200');

  if (!has('order')) {
    assert.equal(created.data.ok, false);
    assert.match(created.data.message, /暂未开放/);
    return;
  }

  assertOk(created, 'action create_order');
  assert.equal(created.data.ok, true);
  assert.equal(created.data.action, 'create_order');
  assert.ok(created.data.cards.length >= 1);
  assert.ok(created.data.state.lastOrderNo);

  const payCard = created.data.cards.find((c) => c.type === 'pay');
  if (payCard) {
    const paid = await api(base, 'POST', '/api/ai/action', {
      token,
      body: { sessionId: session.sessionId, action: 'mock_pay', payload: { orderNo: payCard.orderNo, outTradeNo: payCard.outTradeNo } },
    });
    assertOk(paid, 'action mock_pay');
    assert.equal(paid.data.ok, true);
  }

  // 未知动作：参数校验拒绝
  const bad = await api(base, 'POST', '/api/ai/action', {
    token,
    body: { sessionId: session.sessionId, action: 'drop_database', payload: {} },
  });
  assert.equal(bad.status, 422);
  assert.equal(bad.code, 'VALIDATION_ERROR');

  // 落库：ai_actions 有记录
  const acts = db.all('SELECT tool, status FROM ai_actions WHERE user_id = (SELECT id FROM users WHERE openid = ?)', 'dev_ai_action');
  assert.ok(acts.length >= 1, '动作要写 ai_actions');
  assert.ok(acts.some((a) => a.tool === 'create_order'));
});

/* ------------------------------------------------------------------ *
 * 4. refund
 * ------------------------------------------------------------------ */
test('意图 refund：有可退订单 → 退款卡片（退款模块未就绪时友好降级）', async () => {
  const token = await login('dev_ai_refund', '退款');
  const session = await openSession(token);
  await chat(token, session.sessionId, '我想减脂');
  const created = await chat(token, session.sessionId, '买这个');

  if (!has('payment') || !created.state.lastOrderNo) {
    const data = await chat(token, session.sessionId, '退款');
    assert.match(data.reply.content, /暂未开放|稍后再试|还没有可退款/);
    return;
  }

  await chat(token, session.sessionId, '我已支付');
  await sleep(60);
  const data = await chat(token, session.sessionId, '我不想要了，退款');
  assert.equal(data.state.intent, 'refund');
  assert.match(data.reply.content, /退款/);

  if (has('refund')) {
    const card = data.reply.cards.find((c) => c.type === 'refund');
    assert.ok(card, '应给出退款卡片');
    assert.ok(card.refundNo, '退款单号');
    money(card.amountText);
    assert.ok(card.statusText);

    const row = db.get('SELECT * FROM refunds WHERE refund_no = ?', card.refundNo);
    assert.ok(row, '退款单要落库');
    assert.equal(row.user_id, db.get('SELECT user_id FROM orders WHERE order_no = ?', created.state.lastOrderNo).user_id);
  }
});

/* ------------------------------------------------------------------ *
 * 5. orders / entitlements
 * ------------------------------------------------------------------ */
test('意图 orders / entitlements：订单卡片与核销码', async () => {
  const openid = 'dev_ai_orders';
  const token = await login(openid, '订单用户');
  const session = await openSession(token);
  await chat(token, session.sessionId, '我想减脂');
  const created = await chat(token, session.sessionId, '买这个');

  const orders = await chat(token, session.sessionId, '我的订单');
  assert.equal(orders.state.intent, 'orders');
  assert.ok(orders.reply.content.length > 0);

  if (has('order') && created.state.lastOrderNo) {
    const card = orders.reply.cards.find((c) => c.type === 'order');
    assert.ok(card, '应返回订单卡片');
    assert.ok(card.orderNo);
    assert.ok(card.statusText);
    money(card.totalText);
    assert.equal(card.orderNo, created.state.lastOrderNo);
  } else {
    assert.match(orders.reply.content, /还没有|暂未开放/);
  }

  const courses = await chat(token, session.sessionId, '我的课');
  assert.equal(courses.state.intent, 'entitlements');

  // 权益模块可能未就绪：直接用 db 造一条权益，验证意图分支能出核销码
  const user = db.get('SELECT id FROM users WHERE openid = ?', openid);
  const order = created.state.lastOrderNo ? db.get('SELECT * FROM orders WHERE order_no = ?', created.state.lastOrderNo) : null;
  if (order) {
    const item = db.get('SELECT product_id FROM order_items WHERE order_id = ? LIMIT 1', order.id);
    const existing = db.get('SELECT * FROM entitlements WHERE order_id = ? LIMIT 1', order.id);
    if (!existing) {
      db.run(
        `INSERT INTO entitlements (id, user_id, product_id, order_id, status, verify_code, starts_at, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', '12345678', ?, NULL, ?, ?)`,
        'ent_test_ai_1',
        user.id,
        (item && item.product_id) || order.product_id || 'p_unknown',
        order.id,
        new Date().toISOString(),
        new Date().toISOString(),
        new Date().toISOString()
      );
    }
    const again = await chat(token, session.sessionId, '我的课怎么上');
    assert.equal(again.state.intent, 'entitlements');
    const ent = again.reply.cards.find((c) => c.type === 'entitlement');
    assert.ok(ent, '有权益时应返回 entitlement 卡片');
    assert.match(String(ent.verifyCode), /^\d{8}$/);
  } else {
    assert.ok(courses.reply.content.length > 0);
  }
});

/* ------------------------------------------------------------------ *
 * 6. service / dist / fallback
 * ------------------------------------------------------------------ */
test('意图 service / dist / fallback：跳转客服、分销说明、兜底引导', async () => {
  const token = await login('dev_ai_intent', '意图');
  const session = await openSession(token);

  const svc = await chat(token, session.sessionId, '我要人工客服');
  assert.equal(svc.state.intent, 'service');
  assert.ok(svc.reply.actions.some((a) => a.action === 'open_service'), '要有跳转客服动作');

  const dist = await chat(token, session.sessionId, '我想赚钱');
  assert.equal(dist.state.intent, 'dist');
  assert.match(dist.reply.content, /佣金|分销/);
  assert.ok(dist.reply.actions.some((a) => a.action === 'open_dist'));

  const fb = await chat(token, session.sessionId, '今天天气不错呀');
  assert.equal(fb.state.intent, 'fallback');
  assert.match(fb.reply.content, /减脂|订单|退款/);
  assert.ok(fb.reply.cards.length >= 1, '兜底也要给引导卡片');
  assert.ok(fb.reply.actions.some((a) => a.action === 'open_service'));
});

test('GET /api/ai/suggestions 返回 4 条推荐问题', async () => {
  const token = await login('dev_ai_sug', '推荐');
  const data = assertOk(await api(base, 'GET', '/api/ai/suggestions', { token }), 'suggestions');
  assert.deepEqual(data.suggestions, ['我想减脂，推荐课程', '我的订单在哪', '怎么退款', '怎么赚佣金']);
});

/* ------------------------------------------------------------------ *
 * 7. 客服会话
 * ------------------------------------------------------------------ */
test('客服会话：连续两次 GET 只生成一条 open 会话', async () => {
  const openid = 'dev_ai_cs1';
  const token = await login(openid, '客服用户');

  const first = assertOk(await api(base, 'GET', '/api/service/conversation', { token }), 'service conversation');
  const second = assertOk(await api(base, 'GET', '/api/service/conversation', { token }), 'service conversation 2');

  assert.equal(first.conversation.id, second.conversation.id, '同一用户只能有一条 open 会话');
  assert.equal(first.conversation.status, 'open');
  assert.ok(first.quickReplies.length >= 6, '应有快捷话术');
  assert.ok(first.welcome.length > 0, '应有欢迎语');

  const user = db.get('SELECT id FROM users WHERE openid = ?', openid);
  const count = db.pluck("SELECT COUNT(*) FROM conversations WHERE user_id = ? AND status = 'open'", user.id);
  assert.equal(Number(count), 1, 'open 会话必须唯一');
});

test('客服发消息：未读数递增、AI 自动回复落库、用户能轮询到', async () => {
  const token = await login('dev_ai_cs2', '发消息');
  const conv = assertOk(await api(base, 'GET', '/api/service/conversation', { token }), 'conversation');

  const before = Date.now();
  const sent1 = assertOk(
    await api(base, 'POST', '/api/service/messages', { token, body: { content: '课程怎么选？' } }),
    'send 1'
  );
  assert.equal(sent1.message.senderType, 'user');
  assert.equal(sent1.message.conversationId, conv.conversation.id);
  assert.equal(sent1.conversation.unreadAdmin, 1, '用户发消息后管理员未读 +1');
  assert.ok(sent1.conversation.lastMsgPreview.length > 0, '要更新 last_msg_preview');
  assert.ok(sent1.autoReply, 'AI 开关打开时应有自动回复');
  assert.equal(sent1.autoReply.senderType, 'ai');

  const sent2 = assertOk(
    await api(base, 'POST', '/api/service/messages', { token, body: { content: '我想退款' } }),
    'send 2'
  );
  assert.equal(sent2.conversation.unreadAdmin, 2, '未读数继续累加');

  const poll = assertOk(await api(base, 'GET', '/api/service/messages', { token }), 'poll');
  assert.ok(poll.messages.length >= 4, '用户至少看到 2 user + 2 ai');
  assert.equal(poll.conversation.unreadUser, 0, '用户拉取后自己的未读清零');

  const after = new Date(before).toISOString();
  const incr = assertOk(await api(base, 'GET', `/api/service/messages?after=${encodeURIComponent(after)}`, { token }), 'poll after');
  assert.ok(incr.messages.length >= 2, '增量接口只返回新消息');
  for (const m of incr.messages) assert.ok(m.createdAt >= after);

  // 空内容校验
  const empty = await api(base, 'POST', '/api/service/messages', { token, body: { content: '' } });
  assert.equal(empty.status, 422);
});

test('后台客服：会话列表 → 清未读 → 回复 → 用户能拉到', async () => {
  const openid = 'dev_ai_cs3';
  const token = await login(openid, '等客服');
  const conv = assertOk(await api(base, 'GET', '/api/service/conversation', { token }), 'conversation');
  await api(base, 'POST', '/api/service/messages', { token, body: { content: '付了钱没看到课' } });
  await api(base, 'POST', '/api/service/messages', { token, body: { content: '在吗' } });

  const adminToken = await adminLogin(base);

  const list = assertOk(await api(base, 'GET', '/api/admin/conversations?status=open&size=100', { adminToken }), 'admin conversations');
  assert.ok(Array.isArray(list.list));
  const mine = list.list.find((c) => c.id === conv.conversation.id);
  assert.ok(mine, '新会话应出现在后台列表里');
  assert.equal(mine.unreadAdmin, 2);

  const detail = assertOk(
    await api(base, 'GET', `/api/admin/conversations/${mine.id}/messages`, { adminToken }),
    'admin messages'
  );
  assert.ok(detail.messages.length >= 2);
  assert.equal(detail.conversation.unreadAdmin, 0, '进入会话即清未读');

  const reply = assertOk(
    await api(base, 'POST', `/api/admin/conversations/${mine.id}/messages`, {
      adminToken,
      body: { content: '已帮你查了，权益正在开通，稍等 1 分钟～' },
    }),
    'admin reply'
  );
  assert.equal(reply.message.senderType, 'admin');
  assert.ok(reply.conversation.unreadUser >= 1, '管理员回复后用户未读 +1');

  const poll = assertOk(await api(base, 'GET', '/api/service/messages', { token }), 'user poll');
  const last = poll.messages[poll.messages.length - 1];
  assert.equal(last.senderType, 'admin');
  assert.match(last.content, /权益正在开通/);
  assert.ok(poll.messages.some((m) => m.senderType === 'ai'), '自动回复也要在历史里');

  // 关闭后用户再进来会开新会话
  const closed = assertOk(
    await api(base, 'POST', `/api/admin/conversations/${mine.id}/close`, { adminToken }),
    'admin close'
  );
  assert.equal(closed.conversation.status, 'closed');
  const reopen = assertOk(await api(base, 'GET', '/api/service/conversation', { token }), 'reopen');
  assert.notEqual(reopen.conversation.id, mine.id, '关闭后应能开新会话');
});

/* ------------------------------------------------------------------ *
 * 8. 后台 AI 审计
 * ------------------------------------------------------------------ */
test('后台 AI 日志：ai_actions 落库并可通过 /api/admin/ai/logs 查询', async () => {
  const adminToken = await adminLogin(base);
  const page = assertOk(await api(base, 'GET', '/api/admin/ai/logs?page=1&size=10', { adminToken }), 'ai logs');
  assert.ok(page.list.length >= 1, '动作日志应有记录');
  assert.equal(typeof page.total, 'number');
  assert.ok(page.list[0].tool);
  assert.ok(page.list[0].status);
  assert.ok(page.list[0].createdAt);

  const total = Number(db.pluck('SELECT COUNT(*) FROM ai_actions'));
  assert.ok(total >= 1, 'ai_actions 表要有数据');
});

test('限流：/api/ai/chat 超过 30 次/分钟返回 TOO_MANY_REQUESTS', async () => {
  const token = await login('dev_ai_limit', '限流');
  const session = await openSession(token);
  let limited = null;
  for (let i = 0; i < 32; i += 1) {
    const res = await api(base, 'POST', '/api/ai/chat', { token, body: { sessionId: session.sessionId, text: '我的订单' } });
    if (res.status === 429) {
      limited = res;
      break;
    }
    assert.ok(res.ok, `第 ${i + 1} 次应成功`);
  }
  assert.ok(limited, '超过 30 次/分钟应被限流');
  assert.equal(limited.code, 'TOO_MANY_REQUESTS');
  assert.ok(limited.raw.details && limited.raw.details.retryAfter > 0, '要带 retryAfter');
});

test('参数校验：空文本 422、超长文本 422', async () => {
  const token = await login('dev_ai_valid', '校验');
  const session = await openSession(token);

  const empty = await api(base, 'POST', '/api/ai/chat', { token, body: { sessionId: session.sessionId, text: '   ' } });
  assert.equal(empty.status, 422);
  assert.equal(empty.code, 'VALIDATION_ERROR');

  const long = await api(base, 'POST', '/api/ai/chat', { token, body: { sessionId: session.sessionId, text: '减'.repeat(600) } });
  assert.equal(long.status, 422);
});

/* ------------------------------------------------------------------ *
 * 9. rule 引擎离线覆盖 11 类意图（不依赖网络）
 * ------------------------------------------------------------------ */
test('rule 引擎：契约表里 11 类意图全部能离线命中', () => {
  const engine = cjsRequire(path.join(ROOT, 'server', 'modules', 'ai', 'engine.js'));

  const cases = [
    ['我想减脂', 'recommend', '减脂'],
    ['我想塑形', 'recommend', '塑形'],
    ['肩颈不舒服', 'recommend', '舒缓'],
    ['产后修复', 'recommend', '孕产'],
    ['多少钱', 'price', null],
    ['有优惠吗', 'price', null],
    ['买这个', 'create_order', null],
    ['就这个', 'create_order', null],
    ['怎么付', 'pay', null],
    ['我付好了', 'mock_pay', null],
    ['退款', 'refund', null],
    ['不想要了', 'refund', null],
    ['我的订单', 'orders', null],
    ['我的课', 'entitlements', null],
    ['怎么上课', 'entitlements', null],
    ['人工客服', 'service', null],
    ['赚钱', 'dist', null],
    ['邀请好友', 'dist', null],
    ['今天天气不错', 'fallback', null],
  ];

  assert.equal(engine.INTENTS.length, 11, '意图清单必须是 11 类');
  for (const [text, intent, goal] of cases) {
    const out = engine.classify(text);
    assert.equal(out.intent, intent, `「${text}」应判定为 ${intent}，实际 ${out.intent}`);
    if (goal) assert.equal(out.goal, goal, `「${text}」目标应为 ${goal}`);
  }
  assert.deepEqual(engine.SUGGESTIONS, ['我想减脂，推荐课程', '我的订单在哪', '怎么退款', '怎么赚佣金']);

  // 资金类意图不允许被 LLM 覆盖
  const aiSvc = cjsRequire(path.join(ROOT, 'server', 'modules', 'ai', 'service.js'));
  assert.equal(aiSvc.pickIntent('refund', 'recommend'), 'refund', '退款意图以本地规则为准');
  assert.equal(aiSvc.pickIntent('create_order', 'orders'), 'create_order');
  assert.equal(aiSvc.pickIntent('recommend', 'price'), 'price', '只读意图可采用 LLM 判定');
  assert.equal(aiSvc.pickIntent('fallback', 'bogus'), 'fallback', '非法意图要忽略');
});

test('llm provider：无 key 时不可用，JSON 解析失败能安全降级', () => {
  const llm = cjsRequire(path.join(ROOT, 'server', 'modules', 'ai', 'llm.js'));

  // 测试环境没有 AI_API_KEY → 必须走 rule，不允许发网络请求
  assert.equal(llm.available(), false, '没有 apiKey 时 llm 不可用');
  assert.equal(llm.parseJsonReply('好的'), null);

  const fenced = llm.parseJsonReply('```json\n{"reply":"给你推荐两门课","intent":"recommend"}\n```');
  assert.equal(fenced.intent, 'recommend');
  assert.equal(fenced.reply, '给你推荐两门课');

  const noisy = llm.parseJsonReply('先说两句 {"reply":"在的","intent":"orders","actions":[]} 收尾');
  assert.equal(noisy.intent, 'orders');
  assert.equal(llm.normalizeIntent('not-an-intent'), null);
  assert.equal(llm.normalizeIntent('refund'), 'refund');
});
