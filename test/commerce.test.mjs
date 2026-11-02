/**
 * be-commerce 交付测试（商品 / 订单 / 支付 / 退款 / 权益）。
 *
 * 覆盖：
 *   1. 商品列表 · 详情 · 首页 · 目标标签
 *   2. 下单成功并锁定库存（products.stock / skus.stock 同步扣减）
 *   3. 超卖拒绝（OUT_OF_STOCK 409）
 *   4. 越权访问他人订单（FORBIDDEN 403）
 *   5. 重复发起支付复用同一 outTradeNo；mock-notify 幂等；权益发放且核销码 8 位
 *   6. 全额退款 → 订单 refunded + 权益失效（revoked）+ 库存/销量回滚
 *   7. 部分退款 → 订单 partial_refunded + 权益保留
 *   8. 会员课大额退款落 pending → 后台 approve → succeeded
 *   9. 超时关单：改 expire_at 后 sweep.tick() → cancelled + 库存回滚
 *
 * 说明：本文件把 MOCK_AUTO_PAY 关掉（'0'），所有支付都由测试显式调 mock-notify，
 *      避免后台 200ms 自动支付与断言竞争。
 */
process.env.MOCK_AUTO_PAY = '0';

const { test } = await import('node:test');
const assert = await import('node:assert/strict');
const helpers = await import('./helpers.mjs');

const { startServer, api, demoLogin, adminLogin, assertOk } = helpers;
const require = helpers.require;

const ctx = await startServer();
const sweep = require(`${helpers.ROOT}/server/sweep.js`);
const { base, db } = ctx;
const A = ctx.app;

test.after(async () => {
  await ctx.close();
});

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */
let tokenA = null;
let tokenB = null;
let tokenAdmin = null;

async function userA() {
  if (!tokenA) tokenA = await demoLogin(base, 'dev_demo_a', '小A');
  return tokenA;
}
async function userB() {
  if (!tokenB) tokenB = await demoLogin(base, 'dev_demo_b', '小B');
  return tokenB;
}
async function adminToken() {
  if (!tokenAdmin) tokenAdmin = await adminLogin(base);
  return tokenAdmin;
}

function onlineProduct() {
  return db.get("SELECT * FROM products WHERE type = 'online' AND status = 'on' ORDER BY price_cents ASC LIMIT 1");
}

function membershipProduct() {
  return db.get("SELECT * FROM products WHERE type = 'membership' AND status = 'on' LIMIT 1");
}

async function createOrder(token, product, quantity = 1) {
  const r = await api(base, 'POST', '/api/orders', { token, body: { productId: product.id, quantity } });
  return assertOk(r, '下单');
}

async function payAndNotify(token, orderNo) {
  const pay = assertOk(await api(base, 'POST', `/api/orders/${orderNo}/pay`, { token, body: {} }), '发起支付');
  const outTradeNo = pay.payment.outTradeNo || pay.payParams.outTradeNo;
  const notify = assertOk(await api(base, 'POST', '/api/pay/mock-notify', { body: { outTradeNo } }), 'mock 支付回调');
  return { pay, outTradeNo, notify };
}

async function freshPaidOrder(token) {
  const product = onlineProduct();
  const order = await createOrder(token, product);
  await payAndNotify(token, order.orderNo);
  return { order, product };
}

/* ------------------------------------------------------------------ *
 * 1. 商品
 * ------------------------------------------------------------------ */
test('商品：列表 / 详情 / 首页 / 目标标签 均为契约结构，金额文本为纯数字', async () => {
  const list = assertOk(await api(base, 'GET', '/api/products?page=1&size=5'), '商品列表');
  assert.ok(Array.isArray(list.list) && list.list.length > 0, '商品列表不应为空');
  assert.equal(list.page, 1);
  assert.equal(list.size, 5);
  assert.ok(list.total >= 6, '种子商品应至少 6 个');
  const card = list.list[0];
  for (const key of ['id', 'title', 'cover', 'type', 'priceCents', 'stock', 'sales']) {
    assert.ok(card[key] !== undefined, `商品卡缺少字段 ${key}`);
  }
  assert.match(card.priceText, /^\d+\.\d{2}$/, 'priceText 必须是纯数字两位小数（前端自己拼 ¥）');
  assert.match(card.originalPriceText, /^\d+\.\d{2}$/, 'originalPriceText 必须是纯数字');
  assert.match(card.priceLabel, /^¥\d+\.\d{2}$/, 'priceLabel 才带货币符号');

  /* 关键词 / 类型 / 排序筛选 */
  const byKeyword = assertOk(await api(base, 'GET', '/api/products?keyword=入门'), '关键词搜索');
  assert.ok(byKeyword.list.length >= 1);
  const byType = assertOk(await api(base, 'GET', '/api/products?type=membership'), '类型筛选');
  assert.ok(byType.list.every((p) => p.type === 'membership'), 'type 筛选应只返回会员课');
  const sorted = assertOk(await api(base, 'GET', '/api/products?sort=price_asc&size=20'), '价格升序');
  const prices = sorted.list.map((p) => p.priceCents);
  assert.deepEqual(prices, [...prices].sort((x, y) => x - y), 'sort=price_asc 应按价格升序');

  /* 详情 */
  const detail = assertOk(await api(base, 'GET', `/api/products/${card.id}`), '商品详情');
  assert.equal(detail.product.id, card.id);
  assert.ok('detailHtml' in detail.product, '详情应含 detailHtml');
  assert.ok(Array.isArray(detail.skus), '详情应含 skus 数组');
  assert.ok(Array.isArray(detail.faq));
  assert.ok(Array.isArray(detail.related));

  /* 首页 */
  const home = assertOk(await api(base, 'GET', '/api/home'), '首页');
  assert.ok(Array.isArray(home.banners));
  assert.ok(Array.isArray(home.sections) && home.sections.length >= 1);
  assert.ok(home.sections.every((s) => Array.isArray(s.products)));

  /* 目标标签 */
  const goals = assertOk(await api(base, 'GET', '/api/goals'), '目标标签');
  assert.ok(Array.isArray(goals) && goals.length >= 6);
  assert.ok(goals.every((g) => g.key && g.label && typeof g.count === 'number'));

  /* 下架商品不出现 */
  const off = db.get("SELECT * FROM products WHERE status = 'off' LIMIT 1");
  if (!off) {
    const victim = onlineProduct();
    db.run("UPDATE products SET status = 'off' WHERE id = ?", victim.id);
    const hidden = assertOk(await api(base, 'GET', '/api/products?size=50'), '下架后列表');
    assert.ok(!hidden.list.some((p) => p.id === victim.id), '下架商品不应出现在列表');
    const detailOff = await api(base, 'GET', `/api/products/${victim.id}`);
    assert.equal(detailOff.status, 404, '下架商品详情应 404');
    db.run("UPDATE products SET status = 'on' WHERE id = ?", victim.id);
  }
});

/* ------------------------------------------------------------------ *
 * 2. 下单锁库存
 * ------------------------------------------------------------------ */
test('订单：下单成功并按数量锁定库存', async () => {
  const token = await userA();
  const product = onlineProduct();
  const sku = db.get("SELECT * FROM skus WHERE product_id = ? AND status = 'on' LIMIT 1", product.id);
  const stockBefore = Number(db.get('SELECT stock FROM products WHERE id = ?', product.id).stock);
  const skuBefore = sku ? Number(db.get('SELECT stock FROM skus WHERE id = ?', sku.id).stock) : null;

  const r = await api(base, 'POST', '/api/orders', {
    token,
    body: { productId: product.id, skuId: sku ? sku.id : undefined, quantity: 2, remark: '晚上七点的课' },
  });
  const data = assertOk(r, '下单');
  assert.ok(data.orderNo.startsWith('YO'), '订单号应以 YO 开头');
  assert.equal(data.status, 'pending');
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].quantity, 2);
  assert.match(data.totalText, /^\d+\.\d{2}$/);
  assert.equal(data.totalCents, data.items[0].priceCents * 2);
  assert.ok(data.expireAt, '下单应返回支付截止时间');
  assert.ok(new Date(data.expireAt).getTime() > Date.now(), 'expireAt 应是将来的时间');

  const stockAfter = Number(db.get('SELECT stock FROM products WHERE id = ?', product.id).stock);
  assert.equal(stockAfter, stockBefore - 2, '下单应锁库存');
  if (sku) {
    const skuAfter = Number(db.get('SELECT stock FROM skus WHERE id = ?', sku.id).stock);
    assert.equal(skuAfter, skuBefore - 2, 'sku 库存应同步扣减');
  }

  /* 取消订单 → 库存回滚 */
  const cancelled = assertOk(await api(base, 'POST', `/api/orders/${data.orderNo}/cancel`, { token, body: {} }), '取消订单');
  assert.equal(cancelled.order.status, 'cancelled');
  const stockRestored = Number(db.get('SELECT stock FROM products WHERE id = ?', product.id).stock);
  assert.equal(stockRestored, stockBefore, '取消后库存应回滚');
  if (sku) {
    assert.equal(Number(db.get('SELECT stock FROM skus WHERE id = ?', sku.id).stock), skuBefore);
  }

  /* 已取消订单不能再次取消 */
  const again = await api(base, 'POST', `/api/orders/${data.orderNo}/cancel`, { token, body: {} });
  assert.equal(again.status, 409);
  assert.equal(again.code, 'INVALID_STATE');

  /* 我的订单列表 */
  const list = assertOk(await api(base, 'GET', '/api/orders?page=1&size=10', { token }), '订单列表');
  assert.ok(list.list.some((o) => o.orderNo === data.orderNo));
  const filtered = assertOk(await api(base, 'GET', '/api/orders?status=cancelled', { token }), '按状态筛选');
  assert.ok(filtered.list.every((o) => o.status === 'cancelled'));
});

/* ------------------------------------------------------------------ *
 * 3. 超卖
 * ------------------------------------------------------------------ */
test('订单：库存不足拒绝下单（OUT_OF_STOCK 409）', async () => {
  const token = await userA();
  const product = onlineProduct();
  const original = Number(db.get('SELECT stock FROM products WHERE id = ?', product.id).stock);
  db.run('UPDATE products SET stock = 1 WHERE id = ?', product.id);
  try {
    const r = await api(base, 'POST', '/api/orders', { token, body: { productId: product.id, quantity: 2 } });
    assert.equal(r.status, 409, `期望 409，实际 ${r.status}`);
    assert.equal(r.code, 'OUT_OF_STOCK');

    const ok = await api(base, 'POST', '/api/orders', { token, body: { productId: product.id, quantity: 1 } });
    assertOk(ok, '库存刚好够时下单');
    assert.equal(Number(db.get('SELECT stock FROM products WHERE id = ?', product.id).stock), 0);
    await api(base, 'POST', `/api/orders/${ok.data.orderNo}/cancel`, { token, body: {} });

    /* 数量越界 */
    const bad = await api(base, 'POST', '/api/orders', { token, body: { productId: product.id, quantity: 100 } });
    assert.equal(bad.status, 422);
    assert.equal(bad.code, 'VALIDATION_ERROR');
  } finally {
    db.run('UPDATE products SET stock = ? WHERE id = ?', original, product.id);
  }
});

/* ------------------------------------------------------------------ *
 * 4. 越权
 * ------------------------------------------------------------------ */
test('订单：他人订单不可读、不可取消、不可退款（403）', async () => {
  const a = await userA();
  const b = await userB();
  const order = await createOrder(a, onlineProduct());

  const read = await api(base, 'GET', `/api/orders/${order.orderNo}`, { token: b });
  assert.equal(read.status, 403);
  assert.equal(read.code, 'FORBIDDEN');

  const cancel = await api(base, 'POST', `/api/orders/${order.orderNo}/cancel`, { token: b, body: {} });
  assert.equal(cancel.status, 403);

  const refund = await api(base, 'POST', `/api/orders/${order.orderNo}/refund`, { token: b, body: { reason: '不是我的' } });
  assert.equal(refund.status, 403);

  const unauth = await api(base, 'GET', `/api/orders/${order.orderNo}`);
  assert.equal(unauth.status, 401);

  /* 本人可以读，且能拿到 canPay/canCancel/timeline */
  const mine = assertOk(await api(base, 'GET', `/api/orders/${order.orderNo}`, { token: a }), '本人查看订单');
  assert.equal(mine.order.orderNo, order.orderNo);
  assert.equal(mine.canPay, true);
  assert.equal(mine.canCancel, true);
  assert.equal(mine.canRefund, false);
  assert.ok(Array.isArray(mine.timeline) && mine.timeline.length >= 1, '应返回时间线');
  assert.ok(Array.isArray(mine.items) && mine.items.length === 1);

  await api(base, 'POST', `/api/orders/${order.orderNo}/cancel`, { token: a, body: {} });
});

/* ------------------------------------------------------------------ *
 * 5. 支付幂等 + 权益
 * ------------------------------------------------------------------ */
test('支付：重复发起复用同一 outTradeNo，mock-notify 幂等，支付后发权益且核销码 8 位', async () => {
  const token = await userA();
  const product = onlineProduct();
  const order = await createOrder(token, product);

  const pay1 = assertOk(await api(base, 'POST', `/api/orders/${order.orderNo}/pay`, { token, body: {} }), '首次发起支付');
  const pay2 = assertOk(await api(base, 'POST', `/api/orders/${order.orderNo}/pay`, { token, body: {} }), '再次发起支付');
  const tradeNo = pay1.payment.outTradeNo;
  assert.equal(pay2.payment.outTradeNo, tradeNo, '未支付的订单应复用同一支付单');
  assert.equal(pay2.payment.id, pay1.payment.id, '不应重复创建 payments 记录');
  assert.equal(pay1.provider, 'mock');
  assert.equal(pay1.mock, true);
  assert.match(pay1.payParams.message || '', /模拟支付/, 'mock 模式应给出「我已支付」提示');

  const n1 = assertOk(await api(base, 'POST', '/api/pay/mock-notify', { body: { outTradeNo: tradeNo } }), '支付回调 #1');
  assert.equal(n1.status, 'succeeded');
  assert.equal(n1.orderStatus, 'paid');
  assert.equal(n1.idempotent, false);

  const n2 = assertOk(await api(base, 'POST', '/api/pay/mock-notify', { body: { outTradeNo: tradeNo } }), '支付回调 #2');
  assert.equal(n2.idempotent, true, '重复回调必须幂等');
  assert.equal(n2.paidCents, n1.paidCents);

  const orderRow = db.get('SELECT * FROM orders WHERE order_no = ?', order.orderNo);
  assert.equal(orderRow.status, 'paid');
  assert.equal(Number(orderRow.paid_cents), Number(orderRow.total_cents));
  assert.ok(orderRow.paid_at);

  const paymentRows = db.all("SELECT * FROM payments WHERE order_id = ? AND status = 'succeeded'", orderRow.id);
  assert.equal(paymentRows.length, 1, '一单只允许一条成功支付');

  /* 权益 */
  const entitlements = assertOk(await api(base, 'GET', '/api/my/entitlements', { token }), '我的课程');
  assert.ok(Array.isArray(entitlements));
  const ent = entitlements.find((e) => e.orderId === orderRow.id);
  assert.ok(ent, '支付成功后应自动发放权益');
  assert.match(ent.verifyCode, /^\d{8}$/, '核销码必须是 8 位数字');
  assert.equal(ent.status, 'active');
  assert.equal(ent.productId, product.id);
  assert.equal(ent.orderNo, order.orderNo);
  assert.equal(ent.expiresAt, null, 'online 课程长期有效');
  assert.ok(ent.title && ent.cover);

  const entDetail = assertOk(await api(base, 'GET', `/api/my/entitlements/${ent.id}`, { token }), '权益详情');
  assert.equal(entDetail.entitlement.id, ent.id);
  assert.ok(entDetail.notice, '详情应含上课须知');

  /* 订单详情带权益 + 不能再次支付 */
  const detail = assertOk(await api(base, 'GET', `/api/orders/${order.orderNo}`, { token }), '已支付订单详情');
  assert.equal(detail.canPay, false);
  assert.equal(detail.canCancel, false);
  assert.equal(detail.canRefund, true);
  assert.ok(detail.payment && detail.payment.outTradeNo === tradeNo);
  assert.equal(detail.entitlements.length, 1);
  const repay = await api(base, 'POST', `/api/orders/${order.orderNo}/pay`, { token, body: {} });
  assert.equal(repay.status, 409);
  assert.equal(repay.code, 'INVALID_STATE');
});

/* ------------------------------------------------------------------ *
 * 6. 全额退款
 * ------------------------------------------------------------------ */
test('退款：小额自动通过 → 订单 refunded + 权益失效', async () => {
  const token = await userA();
  const { order, product } = await freshPaidOrder(token);
  const orderRow = db.get('SELECT * FROM orders WHERE order_no = ?', order.orderNo);
  const stockBefore = Number(db.get('SELECT stock FROM products WHERE id = ?', product.id).stock);
  const salesBefore = Number(db.get('SELECT sales FROM products WHERE id = ?', product.id).sales);

  /* 不传金额 = 全额；金额 <= auto_refund_max_cents(20000) 且未核销 → 自动通过 */
  const refund = assertOk(
    await api(base, 'POST', `/api/orders/${order.orderNo}/refund`, {
      token,
      body: { reason: '时间冲突，先退了', reasonType: 'schedule_conflict' },
    }),
    '申请退款'
  );
  assert.ok(refund.refundNo.startsWith('RF'));
  assert.equal(refund.amountCents, Number(orderRow.paid_cents));
  assert.match(refund.amountText, /^\d+\.\d{2}$/);
  assert.equal(refund.autoApproved, true, '小额退款应自动通过');
  assert.equal(refund.status, 'succeeded');
  assert.equal(refund.nextAction, 'none');
  assert.equal(refund.fullRefund, true);

  const after = assertOk(await api(base, 'GET', `/api/orders/${order.orderNo}`, { token }), '退款后订单详情');
  assert.equal(after.order.status, 'refunded');
  assert.equal(after.order.refundedCents, Number(orderRow.paid_cents));
  assert.equal(after.canRefund, false);
  assert.equal(after.entitlements[0].status, 'revoked', '全额退款后权益应失效');

  /* 库存 / 销量回滚 */
  assert.equal(Number(db.get('SELECT stock FROM products WHERE id = ?', product.id).stock), stockBefore + 1);
  assert.equal(Number(db.get('SELECT sales FROM products WHERE id = ?', product.id).sales), salesBefore - 1);

  /* 已全额退款后订单已终态 → 再次申请是业务冲突（409 INVALID_STATE） */
  const again = await api(base, 'POST', `/api/orders/${order.orderNo}/refund`, { token, body: { reason: '再退一次' } });
  assert.equal(again.status, 409);
  assert.equal(again.code, 'INVALID_STATE');

  /* 退款单查询 */
  const detail = assertOk(await api(base, 'GET', `/api/refunds/${refund.refundNo}`, { token }), '退款单详情');
  assert.equal(detail.refund.refundNo, refund.refundNo);
  assert.equal(detail.refund.status, 'succeeded');
  assert.ok(Array.isArray(detail.progress.steps) && detail.progress.steps.length >= 2);
  const list = assertOk(await api(base, 'GET', '/api/refunds', { token }), '我的退款列表');
  assert.ok(list.list.some((r) => r.refundNo === refund.refundNo));
});

/* ------------------------------------------------------------------ *
 * 7. 部分退款
 * ------------------------------------------------------------------ */
test('退款：部分退款 → 订单 partial_refunded 且权益保留', async () => {
  const token = await userA();
  const { order } = await freshPaidOrder(token);
  const orderRow = db.get('SELECT * FROM orders WHERE order_no = ?', order.orderNo);
  const paid = Number(orderRow.paid_cents);

  const refund = assertOk(
    await api(base, 'POST', `/api/orders/${order.orderNo}/refund`, {
      token,
      body: { amountCents: 5000, reason: '只退一部分', reasonType: 'other' },
    }),
    '部分退款'
  );
  assert.equal(refund.amountCents, 5000);
  assert.equal(refund.fullRefund, false);
  assert.equal(refund.status, 'succeeded');

  const detail = assertOk(await api(base, 'GET', `/api/orders/${order.orderNo}`, { token }), '部分退款后订单');
  assert.equal(detail.order.status, 'partial_refunded');
  assert.equal(detail.order.refundedCents, 5000);
  assert.equal(detail.entitlements[0].status, 'active', '部分退款权益保留');
  assert.equal(detail.canRefund, true, '还有余额可继续退');

  /* 超额退款被拒 */
  const tooMuch = await api(base, 'POST', `/api/orders/${order.orderNo}/refund`, {
    token,
    body: { amountCents: paid, reason: '想多退' },
  });
  assert.equal(tooMuch.status, 422);
  assert.match(tooMuch.message, /可退/);

  /* 退回剩余金额 → 全额 → refunded + 权益失效 */
  const rest = assertOk(
    await api(base, 'POST', `/api/orders/${order.orderNo}/refund`, { token, body: { reason: '剩下的也退了' } }),
    '退剩余金额'
  );
  assert.equal(rest.amountCents, paid - 5000);
  assert.equal(rest.fullRefund, true);
  const final = assertOk(await api(base, 'GET', `/api/orders/${order.orderNo}`, { token }), '全额退完后订单');
  assert.equal(final.order.status, 'refunded');
  assert.equal(final.entitlements[0].status, 'revoked');
});

/* ------------------------------------------------------------------ *
 * 8. 大额人工审核
 * ------------------------------------------------------------------ */
test('退款：超过自动审核额度 → pending，后台 approve 后成功出款', async () => {
  const token = await userA();
  const admin = await adminToken();
  const member = membershipProduct();
  assert.ok(member, '种子数据应包含会员课');

  const order = await createOrder(token, member);
  const paid = await payAndNotify(token, order.orderNo);
  assert.equal(paid.notify.orderStatus, 'paid');

  const membershipEnt = assertOk(await api(base, 'GET', '/api/my/entitlements', { token }), '会员权益');
  const ent = membershipEnt.find((e) => e.orderId === db.pluck('SELECT id FROM orders WHERE order_no = ?', order.orderNo));
  assert.ok(ent, '会员课支付后应有权益');
  assert.ok(ent.expiresAt, 'membership 应有到期时间');
  assert.match(ent.verifyCode, /^\d{8}$/);

  const refund = assertOk(
    await api(base, 'POST', `/api/orders/${order.orderNo}/refund`, {
      token,
      body: { reason: '买错了会员卡', reasonType: 'wrong_purchase' },
    }),
    '会员课退款申请'
  );
  assert.equal(refund.autoApproved, false, '超过 auto_refund_max_cents 应人工审核');
  assert.equal(refund.status, 'pending');
  assert.equal(refund.nextAction, 'wait_review');

  /* 审核前订单仍是 paid */
  assert.equal(db.pluck('SELECT status FROM orders WHERE order_no = ?', order.orderNo), 'paid');

  const pending = assertOk(await api(base, 'GET', '/api/admin/refunds?status=pending&keyword=' + refund.refundNo, {
    adminToken: admin,
  }), '后台退款列表');
  assert.ok(pending.list.some((r) => r.refundNo === refund.refundNo));
  assert.ok(pending.counts, '后台列表应带状态计数');
  assert.match(pending.list[0].amountText, /^\d+\.\d{2}$/);

  /* 非 admin 访问后台接口 → 401 */
  assert.equal((await api(base, 'GET', '/api/admin/refunds', { token })).status, 401);

  const approved = assertOk(await api(base, 'POST', `/api/admin/refunds/${refund.refundNo}/approve`, {
    adminToken: admin,
    body: { note: '客服已核实' },
  }), '后台通过退款');
  assert.equal(approved.refund.status, 'succeeded');
  assert.equal(approved.refund.reviewNote, '客服已核实');
  assert.ok(approved.refund.refundedAt);

  const orderAfter = assertOk(await api(base, 'GET', `/api/orders/${order.orderNo}`, { token }), '审核后订单');
  assert.equal(orderAfter.order.status, 'refunded');
  assert.equal(orderAfter.entitlements[0].status, 'revoked');

  /* 后台订单列表 / 详情 */
  const orders = assertOk(await api(base, 'GET', `/api/admin/orders?keyword=${order.orderNo}`, { adminToken: admin }), '后台订单列表');
  assert.equal(orders.list.length, 1);
  assert.match(orders.list[0].totalText, /^\d+\.\d{2}$/);
  const adminDetail = assertOk(await api(base, 'GET', `/api/admin/orders/${order.orderNo}`, { adminToken: admin }), '后台订单详情');
  assert.equal(adminDetail.order.orderNo, order.orderNo);

  /* 已成功的退款单不能再驳回 */
  const reject = await api(base, 'POST', `/api/admin/refunds/${refund.refundNo}/reject`, {
    adminToken: admin,
    body: { reason: '不通过' },
  });
  assert.equal(reject.status, 409);
});

test('退款：后台驳回后订单回到 paid，且不能再审核', async () => {
  const token = await userA();
  const admin = await adminToken();
  const member = membershipProduct();
  const order = await createOrder(token, member);
  await payAndNotify(token, order.orderNo);

  const refund = assertOk(
    await api(base, 'POST', `/api/orders/${order.orderNo}/refund`, { token, body: { reason: '先试试' } }),
    '申请退款'
  );
  assert.equal(refund.status, 'pending');

  const rejected = assertOk(await api(base, 'POST', `/api/admin/refunds/${refund.refundNo}/reject`, {
    adminToken: admin,
    body: { reason: '课程已开课，不支持退款' },
  }), '驳回退款');
  assert.equal(rejected.refund.status, 'rejected');

  assert.equal(db.pluck('SELECT status FROM orders WHERE order_no = ?', order.orderNo), 'paid');
  const approve = await api(base, 'POST', `/api/admin/refunds/${refund.refundNo}/approve`, { adminToken: admin, body: {} });
  assert.equal(approve.status, 409);
});

/* ------------------------------------------------------------------ *
 * 9. 超时关单
 * ------------------------------------------------------------------ */
test('订单：超时未支付由 sweeper 关单并回滚库存', async () => {
  const token = await userA();
  const product = onlineProduct();
  const stockBefore = Number(db.get('SELECT stock FROM products WHERE id = ?', product.id).stock);
  const order = await createOrder(token, product);
  assert.equal(Number(db.get('SELECT stock FROM products WHERE id = ?', product.id).stock), stockBefore - 1);

  const past = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  db.run('UPDATE orders SET expire_at = ? WHERE order_no = ?', past, order.orderNo);

  const results = sweep.tick();
  assert.ok(Array.isArray(results), 'tick() 应返回执行结果');
  const expireJob = results.find((r) => r.name === 'order:expire');
  assert.ok(expireJob && expireJob.ok, 'order:expire 任务应执行成功');

  const row = db.get('SELECT * FROM orders WHERE order_no = ?', order.orderNo);
  assert.equal(row.status, 'cancelled');
  assert.equal(row.cancel_reason, '超时未支付');
  assert.ok(row.closed_at);
  assert.equal(Number(db.get('SELECT stock FROM products WHERE id = ?', product.id).stock), stockBefore, '关单应回滚库存');

  /* 超时订单不能再支付 */
  const pay = await api(base, 'POST', `/api/orders/${order.orderNo}/pay`, { token, body: {} });
  assert.equal(pay.status, 409);
  assert.equal(pay.code, 'INVALID_STATE');
});

/* ------------------------------------------------------------------ *
 * 10. 后台商品管理 + 权限
 * ------------------------------------------------------------------ */
test('后台：商品上下架 / 全量更新 skus，且后台接口需 admin 令牌', async () => {
  const admin = await adminToken();
  const token = await userA();
  assert.equal((await api(base, 'GET', '/api/admin/products', { token })).status, 401);

  const created = assertOk(await api(base, 'POST', '/api/admin/products', {
    adminToken: admin,
    body: {
      title: '测试流瑜伽小班',
      subtitle: '每班 6 人',
      type: 'offline',
      priceCents: 18800,
      originalPriceCents: 28800,
      stock: 12,
      goalTags: ['塑形'],
      teacher: 'Mia',
      durationMin: 60,
      skus: [{ name: '10 次卡', priceCents: 18800, stock: 12 }],
    },
  }), '新建商品');
  const product = created.product;
  assert.equal(product.title, '测试流瑜伽小班');
  assert.match(product.priceText, /^\d+\.\d{2}$/);
  assert.equal(product.skus.length, 1);

  const detail = assertOk(await api(base, 'GET', `/api/products/${product.id}`), '新商品详情');
  assert.equal(detail.product.id, product.id);

  /* 全量更新：去掉旧 sku → 旧 sku 置 off */
  const updated = assertOk(await api(base, 'PUT', `/api/admin/products/${product.id}`, {
    adminToken: admin,
    body: {
      title: '测试流瑜伽小班（升级）',
      type: 'offline',
      priceCents: 19900,
      stock: 10,
      skus: [{ name: '20 次卡', priceCents: 19900, stock: 10 }],
    },
  }), '更新商品');
  assert.equal(updated.product.title, '测试流瑜伽小班（升级）');
  const skuRows = db.all('SELECT * FROM skus WHERE product_id = ? ORDER BY sort', product.id);
  assert.equal(skuRows.filter((s) => s.status === 'on').length, 1, '只保留一个新的 on sku');
  assert.ok(skuRows.some((s) => s.status === 'off'), '被移除的旧 sku 应置 off');

  /* 上下架 */
  const off = assertOk(await api(base, 'PATCH', `/api/admin/products/${product.id}/status`, {
    adminToken: admin,
    body: { status: 'off' },
  }), '下架');
  assert.equal(off.product.status, 'off');
  assert.equal((await api(base, 'GET', `/api/products/${product.id}`)).status, 404);
  const on = assertOk(await api(base, 'PATCH', `/api/admin/products/${product.id}/status`, {
    adminToken: admin,
    body: { status: 'on' },
  }), '上架');
  assert.equal(on.product.status, 'on');
});

test('后台：支付流水 / 权益查询 可用', async () => {
  const admin = await adminToken();
  const payments = assertOk(await api(base, 'GET', '/api/admin/payments?size=5', { adminToken: admin }), '后台支付流水');
  assert.ok(payments.list.length >= 1);
  assert.match(payments.list[0].amountText, /^\d+\.\d{2}$/);

  const ents = assertOk(await api(base, 'GET', '/api/admin/entitlements?size=5', { adminToken: admin }), '后台权益查询');
  assert.ok(ents.list.length >= 1);
  assert.match(ents.list[0].verifyCode, /^\d{8}$/);
});

/* 让 node:test 知道 app 已就绪（避免未使用变量告警） */
test('app 已挂载全部模块', () => {
  assert.ok(A && A.loaded.includes('order'));
  assert.ok(A.loaded.includes('payment'));
  assert.ok(A.loaded.includes('refund'));
  assert.ok(A.loaded.includes('entitlement'));
});
