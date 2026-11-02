'use strict';
/**
 * AI 动作执行器（docs/API.md §10）。
 *
 * 把对话里的动作按钮落成真实业务操作：
 *   create_order → order/service.js#createOrder → payment/service.js#payOrder
 *   pay_order    → payment/service.js#payOrder
 *   mock_pay     → payment/service.js#markPaid
 *   refund_order → refund/service.js#createRefund
 *   bind_invite  → distribution/service.js#bindInvite
 *   open_*       → 纯导航结果，前端按 result.route 跳页
 *
 * order / payment / refund / distribution 由别人并行开发，因此：
 *   - 一律延迟 require + try/catch，模块缺失或导出缺失时返回「该功能暂未开放」；
 *   - 业务错误（ApiError）转成 { ok:false, code, message }，绝不抛 500。
 */
const config = require('../../config');
const cards = require('./cards');
const serviceSvc = require('../service/service');
const { centsToYuanString } = require('../../utils/money');

const UNAVAILABLE = '该功能暂未开放';

function tryRequire(relPath) {
  try {
    return require(relPath);
  } catch {
    return null;
  }
}

const orderSvc = () => tryRequire('../order/service.js');
const paymentSvc = () => tryRequire('../payment/service.js');
const refundSvc = () => tryRequire('../refund/service.js');
const distSvc = () => tryRequire('../distribution/service.js');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firstValue(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function toCents(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function tool(toolName, args, result, status) {
  return { tool: toolName, args: args || {}, result: result === undefined ? null : result, status: status || 'ok' };
}

function errorTool(toolName, args, err, status = 'fail') {
  return tool(toolName, args, { code: (err && err.code) || null, message: (err && err.message) || String(err) }, status);
}

/* --------------------------- 返回值归一化 --------------------------- */

function normalizeOrder(res) {
  const root = res && typeof res === 'object' ? res : {};
  const source = root.order && typeof root.order === 'object' ? root.order : root;
  const orderNo = firstValue(root, ['orderNo', 'order_no']) || firstValue(source, ['orderNo', 'order_no']) || null;
  const orderId = firstValue(root, ['orderId', 'order_id']) || firstValue(source, ['id', 'orderId', 'order_id']) || null;
  const status = firstValue(source, ['status']) || 'pending';
  const totalCents = toCents(firstValue(source, ['totalCents', 'total_cents', 'total', 'paidCents']));
  const expireAt = firstValue(source, ['expireAt', 'expire_at']) || null;
  return { orderNo, orderId, status, totalCents, totalText: centsToYuanString(totalCents), expireAt };
}

function normalizePay(res) {
  const root = res && typeof res === 'object' ? res : {};
  const payment = root.payment && typeof root.payment === 'object' ? root.payment : root;

  let payParams = firstValue(root, ['payParams', 'pay_params']) || firstValue(payment, ['payParams', 'pay_params']) || null;
  if (typeof payParams === 'string') {
    try {
      payParams = JSON.parse(payParams);
    } catch {
      payParams = null;
    }
  }

  const outTradeNo =
    firstValue(root, ['outTradeNo', 'out_trade_no']) ||
    firstValue(payment, ['outTradeNo', 'out_trade_no']) ||
    (payParams && firstValue(payParams, ['outTradeNo', 'out_trade_no'])) ||
    null;
  const provider = firstValue(root, ['provider']) || firstValue(payment, ['provider']) || config.pay.provider;
  const mock = root.mock !== undefined ? !!root.mock : provider === 'mock';
  const amountCents = toCents(
    firstValue(payment, ['amountCents', 'amount_cents']) || firstValue(root, ['amountCents', 'amount_cents'])
  );

  return { outTradeNo, provider, mock, payParams, amountCents, amountText: centsToYuanString(amountCents) };
}

function normalizeRefund(res) {
  const root = res && typeof res === 'object' ? res : {};
  const source = root.refund && typeof root.refund === 'object' ? root.refund : root;
  const refundNo = firstValue(source, ['refundNo', 'refund_no']) || null;
  const status = firstValue(source, ['status']) || 'pending';
  const amountCents = toCents(firstValue(source, ['amountCents', 'amount_cents']));
  return {
    refundNo,
    orderNo: firstValue(source, ['orderNo', 'order_no']) || null,
    status,
    amountCents,
    amountText: centsToYuanString(amountCents),
    autoApproved: !!(source && source.autoApproved),
    message: (source && source.message) || '',
    nextAction: (source && source.nextAction) || (status === 'succeeded' ? 'none' : 'wait_review'),
    createdAt: (source && (source.createdAt || source.created_at)) || null,
  };
}

/* ----------------------------- 业务读写 ----------------------------- */

function latestOutTradeNo(db, orderId) {
  if (!orderId) return null;
  const value = db.pluck(
    'SELECT out_trade_no FROM payments WHERE order_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    orderId
  );
  return value || null;
}

/**
 * 等待权益落库：order.paid 的订阅方是异步的，支付成功后可能晚一两帧。
 * 只在查不到权益时短暂等待，最多 ~320ms。
 */
async function waitEntitlements(db, orderId, tries = 8, delayMs = 40) {
  const sql = `SELECT e.*, p.title AS title, p.type AS product_type, p.cover AS cover, o.order_no AS order_no
                 FROM entitlements e
                 LEFT JOIN products p ON p.id = e.product_id
                 LEFT JOIN orders o ON o.id = e.order_id
                WHERE e.order_id = ?
                ORDER BY e.created_at ASC, e.rowid ASC`;
  let rows = db.all(sql, orderId);
  for (let i = 0; rows.length === 0 && i < tries; i += 1) {
    await sleep(delayMs);
    rows = db.all(sql, orderId);
  }
  return rows;
}

function myEntitlements(db, userId, limit = 5) {
  return db.all(
    `SELECT e.*, p.title AS title, p.type AS product_type, p.cover AS cover, o.order_no AS order_no
       FROM entitlements e
       LEFT JOIN products p ON p.id = e.product_id
       LEFT JOIN orders o ON o.id = e.order_id
      WHERE e.user_id = ? AND e.status = 'active'
      ORDER BY e.created_at DESC, e.rowid DESC LIMIT ?`,
    userId,
    Math.max(1, Number(limit) || 5)
  );
}

/** 下单（并尽量把收银台一起打开） */
async function createOrderAndPay(db, user, { productId, quantity = 1, confirm = false }) {
  const tools = [];
  const args = { productId, quantity };

  const pending = db.get(
    "SELECT * FROM orders WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
    user.id
  );
  if (pending && !confirm) {
    tools.push(tool('create_order', args, { pendingOrderNo: pending.order_no }, 'skipped'));
    return {
      ok: false,
      code: 'DUPLICATE_ORDER',
      needConfirm: true,
      orderNo: pending.order_no,
      message: `你还有一笔未支付的订单（${pending.order_no}），要直接去支付吗？`,
      tools,
    };
  }

  const mod = orderSvc();
  if (!mod || typeof mod.createOrder !== 'function') {
    tools.push(tool('create_order', args, { reason: 'order/service.js 未就绪（createOrder 缺失）' }, 'skipped'));
    return {
      ok: false,
      code: 'SERVICE_UNAVAILABLE',
      message: `${UNAVAILABLE}，下单可以稍后再试，也可以联系客服帮你留位。`,
      tools,
    };
  }

  let created;
  try {
    created = await mod.createOrder(db, {
      userId: user.id,
      productId,
      quantity,
      source: 'ai',
      remark: 'AI 商城对话下单',
    });
  } catch (err) {
    tools.push(errorTool('create_order', args, err));
    return {
      ok: false,
      code: (err && err.code) || 'ORDER_FAILED',
      message: (err && err.message) || '下单失败，请稍后再试',
      tools,
    };
  }

  const order = normalizeOrder(created);
  if (!order.orderNo) {
    tools.push(tool('create_order', args, { reason: 'createOrder 未返回 orderNo' }, 'fail'));
    return { ok: false, code: 'ORDER_FAILED', message: '下单没有成功，请稍后再试', tools };
  }
  tools.push(
    tool('create_order', args, { orderNo: order.orderNo, status: order.status, totalCents: order.totalCents }, 'ok')
  );

  const payRes = await payOrderFor(db, user, { orderNo: order.orderNo });
  tools.push(...payRes.tools);

  return {
    ok: true,
    orderNo: order.orderNo,
    orderId: order.orderId,
    order,
    pay: payRes.ok ? payRes.pay : null,
    message: payRes.ok
      ? `订单 ${order.orderNo} 已生成（¥${order.totalText}），点「我已支付」就能开通课程。`
      : `订单 ${order.orderNo} 已生成（¥${order.totalText}），支付通道暂时没打开，稍后再试。`,
    tools,
  };
}

/** 发起支付 → 收银台 */
async function payOrderFor(db, user, { orderNo }) {
  const tools = [];
  const args = { orderNo };
  const mod = paymentSvc();
  if (!mod || typeof mod.payOrder !== 'function') {
    tools.push(tool('pay_order', args, { reason: 'payment/service.js 未就绪（payOrder 缺失）' }, 'skipped'));
    return { ok: false, code: 'SERVICE_UNAVAILABLE', message: `${UNAVAILABLE}，支付可以稍后再试。`, tools };
  }
  try {
    const res = await mod.payOrder(db, { orderNo, userId: user.id });
    const pay = normalizePay(res);
    tools.push(
      tool(
        'pay_order',
        args,
        { outTradeNo: pay.outTradeNo, provider: pay.provider, mock: pay.mock },
        pay.outTradeNo ? 'ok' : 'fail'
      )
    );
    if (!pay.outTradeNo) {
      return { ok: false, code: 'PAY_FAILED', message: '没有拿到支付参数，请稍后再试', tools };
    }
    return { ok: true, orderNo, pay, tools };
  } catch (err) {
    tools.push(errorTool('pay_order', args, err));
    return {
      ok: false,
      code: (err && err.code) || 'PAY_FAILED',
      message: (err && err.message) || '发起支付失败，请稍后再试',
      tools,
    };
  }
}

/** 「我付好了」→ 走统一支付成功入口 markPaid */
async function mockPayFor(db, user, { orderNo = null, outTradeNo = null }) {
  const tools = [];
  let order = null;
  if (orderNo) {
    order = db.get('SELECT * FROM orders WHERE order_no = ? AND user_id = ?', orderNo, user.id) || null;
  }
  if (!order) {
    order = db.get(
      "SELECT * FROM orders WHERE user_id = ? AND status IN ('pending','created') ORDER BY created_at DESC LIMIT 1",
      user.id
    ) || null;
  }
  if (!order) {
    return {
      ok: false,
      code: 'NO_PENDING_ORDER',
      message: '没有待支付的订单。告诉我想练什么，我先帮你挑课下单～',
      tools,
    };
  }

  const tradeNo = outTradeNo || latestOutTradeNo(db, order.id);
  if (!tradeNo) {
    return {
      ok: false,
      code: 'NO_PAYMENT',
      message: '这笔订单还没有发起支付，点「去支付」打开收银台，再回来告诉我已付款。',
      orderNo: order.order_no,
      tools,
    };
  }

  const mod = paymentSvc();
  if (!mod || typeof mod.markPaid !== 'function') {
    tools.push(tool('mock_pay', { outTradeNo: tradeNo, orderNo: order.order_no }, { reason: 'payment/service.js 未就绪（markPaid 缺失）' }, 'skipped'));
    return { ok: false, code: 'SERVICE_UNAVAILABLE', message: `${UNAVAILABLE}，支付状态稍后再确认。`, tools };
  }

  try {
    await mod.markPaid({
      outTradeNo: tradeNo,
      transactionId: `ai_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      raw: { source: 'ai', orderNo: order.order_no, userId: user.id },
    });
  } catch (err) {
    tools.push(errorTool('mock_pay', { outTradeNo: tradeNo }, err));
    return {
      ok: false,
      code: (err && err.code) || 'PAY_FAILED',
      message: (err && err.message) || '支付状态更新失败，请稍后再试',
      tools,
    };
  }

  tools.push(tool('mock_pay', { outTradeNo: tradeNo, orderNo: order.order_no }, { paid: true }, 'ok'));
  const entitlements = await waitEntitlements(db, order.id);
  return { ok: true, orderNo: order.order_no, outTradeNo: tradeNo, entitlements, message: '支付成功', tools };
}

/** 申请退款 */
async function createRefundFor(db, user, { orderNo, reason, amountCents = undefined, reasonType = 'ai' }) {
  const tools = [];
  const args = { orderNo, amountCents: amountCents === undefined ? null : amountCents };
  const mod = refundSvc();
  if (!mod || typeof mod.createRefund !== 'function') {
    tools.push(tool('create_refund', args, { reason: 'refund/service.js 未就绪（createRefund 缺失）' }, 'skipped'));
    return { ok: false, code: 'SERVICE_UNAVAILABLE', message: `${UNAVAILABLE}，退款可以稍后在订单里申请，也可以转人工客服。`, tools };
  }
  try {
    const res = await mod.createRefund(db, {
      orderNo,
      userId: user.id,
      amountCents,
      reason: reason || '不想要了（AI 对话申请）',
      reasonType,
    });
    const refund = normalizeRefund(res);
    tools.push(
      tool(
        'create_refund',
        args,
        { refundNo: refund.refundNo, status: refund.status, amountCents: refund.amountCents, autoApproved: refund.autoApproved },
        refund.refundNo ? 'ok' : 'fail'
      )
    );
    if (!refund.refundNo) {
      return { ok: false, code: 'REFUND_FAILED', message: '退款申请没有提交成功，请稍后再试', tools };
    }
    return {
      ok: true,
      refund,
      message:
        refund.message ||
        (refund.status === 'succeeded'
          ? '退款已原路退回，1-3 个工作日到账。'
          : '退款申请已提交，等客服审核，进度可以在「我的订单」查看。'),
      tools,
    };
  } catch (err) {
    tools.push(errorTool('create_refund', args, err));
    return {
      ok: false,
      code: (err && err.code) || 'REFUND_FAILED',
      message: (err && err.message) || '退款失败，请稍后再试',
      tools,
    };
  }
}

/** 绑定上级邀请码 */
async function bindInviteFor(db, user, inviteCode) {
  const tools = [];
  const code = String(inviteCode || '').trim().toUpperCase();
  const args = { inviteCode: code };
  if (!code) return { ok: false, code: 'BAD_INVITE_CODE', message: '把邀请码发我一下，6 位字母数字～', tools };

  const mod = distSvc();
  const fn =
    mod && (mod.bindInviter || mod.bindInvite || mod.bind || mod.bindParent || mod.bindByInviteCode);
  if (typeof fn !== 'function') {
    tools.push(tool('bind_invite', args, { reason: 'distribution/service.js 未就绪' }, 'skipped'));
    return { ok: false, code: 'SERVICE_UNAVAILABLE', message: `${UNAVAILABLE}，邀请码稍后再绑定。`, tools };
  }
  try {
    const res = await fn(db, { userId: user.id, inviteCode: code, code });
    tools.push(tool('bind_invite', args, { inviteCode: code }, 'ok'));
    return {
      ok: true,
      result: res || { inviteCode: code },
      message: '邀请码绑定成功，今后好友下单你就有佣金啦～',
      tools,
    };
  } catch (err) {
    tools.push(errorTool('bind_invite', args, err));
    return {
      ok: false,
      code: (err && err.code) || 'BIND_FAILED',
      message: (err && err.message) || '绑定失败，请核对邀请码',
      tools,
    };
  }
}

/* ------------------------------ 动作分发 ------------------------------ */

const ACTIONS = [
  'create_order',
  'pay_order',
  'mock_pay',
  'refund_order',
  'open_product',
  'open_orders',
  'open_service',
  'bind_invite',
  'open_dist',
];

/**
 * 执行一个动作按钮。
 * @returns {Promise<{ok:boolean, action:string, code?:string, result:any, message:string,
 *                    cardList:Array, actionList:Array, state:object, tools:Array, needConfirm?:boolean}>}
 */
async function run(db, user, { action, payload = {}, state = {} }) {
  const next = Object.assign({}, state);
  const body = payload && typeof payload === 'object' ? payload : {};
  const tools = [];
  const fail = (code, message, extra = {}) => ({
    ok: false,
    action,
    code,
    result: extra.result || null,
    message,
    cardList: extra.cardList || [],
    actionList: extra.actionList || [],
    state: next,
    tools,
    ...(extra.needConfirm ? { needConfirm: true } : {}),
  });

  switch (action) {
    case 'create_order': {
      const productId = String(body.productId || next.lastProductId || '').trim();
      if (!productId) {
        return fail('NO_PRODUCT', '还没选中课程～告诉我你想练什么（减脂 / 塑形 / 肩颈），我马上挑给你。');
      }
      const res = await createOrderAndPay(db, user, { productId, confirm: !!body.confirm });
      tools.push(...res.tools);
      if (!res.ok) {
        if (res.code === 'DUPLICATE_ORDER') {
          next.lastOrderNo = res.orderNo;
          next.stage = 'ordering';
          next.pendingConfirm = { action: 'pay_order', orderNo: res.orderNo };
          return fail('DUPLICATE_ORDER', res.message, {
            needConfirm: true,
            result: { orderNo: res.orderNo },
            actionList: [cards.btnPayOrder(res.orderNo), cards.btnOpenOrders()],
          });
        }
        return fail(res.code || 'ORDER_FAILED', res.message, { actionList: [cards.btnOpenService()] });
      }

      next.lastProductId = productId;
      next.lastOrderNo = res.orderNo;
      next.lastOutTradeNo = res.pay ? res.pay.outTradeNo : null;
      next.stage = res.pay ? 'paying' : 'ordering';
      next.pendingConfirm = null;

      const cardList = res.pay
        ? [
            cards.payCard({
              orderNo: res.orderNo,
              outTradeNo: res.pay.outTradeNo,
              provider: res.pay.provider,
              mock: res.pay.mock,
              payParams: res.pay.payParams,
              amountCents: res.pay.amountCents || res.order.totalCents,
            }),
          ]
        : [cards.orderCard({ order_no: res.orderNo, id: res.orderId, status: res.order.status, total_cents: res.order.totalCents, expire_at: res.order.expireAt })];
      const actionList = res.pay
        ? [cards.btnMockPay({ orderNo: res.orderNo, outTradeNo: res.pay.outTradeNo }), cards.btnOpenOrders()]
        : [cards.btnPayOrder(res.orderNo), cards.btnOpenOrders()];

      return {
        ok: true,
        action,
        result: { orderNo: res.orderNo, orderId: res.orderId, outTradeNo: res.pay ? res.pay.outTradeNo : null, payParams: res.pay ? res.pay.payParams : null },
        message: res.message,
        cardList,
        actionList,
        state: next,
        tools,
      };
    }

    case 'pay_order': {
      const orderNo = String(body.orderNo || next.lastOrderNo || '').trim();
      if (!orderNo) {
        return fail('NO_ORDER', '还没有待支付的订单，先选一门课吧～', {
          actionList: [cards.btnOpenOrders()],
        });
      }
      const res = await payOrderFor(db, user, { orderNo });
      tools.push(...res.tools);
      if (!res.ok) return fail(res.code || 'PAY_FAILED', res.message, { actionList: [cards.btnOpenOrders()] });

      next.lastOrderNo = orderNo;
      next.lastOutTradeNo = res.pay.outTradeNo;
      next.stage = 'paying';
      next.pendingConfirm = null;
      return {
        ok: true,
        action,
        result: { orderNo, outTradeNo: res.pay.outTradeNo, provider: res.pay.provider, mock: res.pay.mock, payParams: res.pay.payParams },
        message: '收银台已打开，付好后回来点「我已支付」就行。',
        cardList: [
          cards.payCard({
            orderNo,
            outTradeNo: res.pay.outTradeNo,
            provider: res.pay.provider,
            mock: res.pay.mock,
            payParams: res.pay.payParams,
            amountCents: res.pay.amountCents,
          }),
        ],
        actionList: [cards.btnMockPay({ orderNo, outTradeNo: res.pay.outTradeNo }), cards.btnOpenOrders()],
        state: next,
        tools,
      };
    }

    case 'mock_pay': {
      const res = await mockPayFor(db, user, {
        orderNo: String(body.orderNo || next.lastOrderNo || '').trim() || null,
        outTradeNo: String(body.outTradeNo || next.lastOutTradeNo || '').trim() || null,
      });
      tools.push(...res.tools);
      if (!res.ok) return fail(res.code || 'PAY_FAILED', res.message, { actionList: [cards.btnOpenOrders()] });

      next.lastOrderNo = res.orderNo;
      next.lastOutTradeNo = res.outTradeNo;
      next.stage = 'paid';
      next.pendingConfirm = null;

      const entRows = res.entitlements || [];
      const cardList = entRows.length
        ? entRows.map(cards.entitlementCard)
        : [cards.textCard('支付成功，课程正在开通，几秒后在「我的课程」里就能看到核销码。')];
      const titleText = entRows.length ? `《${entRows[0].title || '课程'}》` : '你的课程';
      return {
        ok: true,
        action,
        result: { orderNo: res.orderNo, outTradeNo: res.outTradeNo, entitlements: entRows.length },
        message: `支付成功，${titleText}已开通${entRows.length && entRows[0].verify_code ? `，核销码 ${entRows[0].verify_code}` : ''}。`,
        cardList,
        actionList: [cards.btnOpenOrders()],
        state: next,
        tools,
      };
    }

    case 'refund_order': {
      let orderNo = String(body.orderNo || next.lastOrderNo || '').trim();
      if (!orderNo) {
        const row = db.get(
          `SELECT order_no FROM orders
            WHERE user_id = ? AND status IN ('paid','completed','partial_refunded')
            ORDER BY created_at DESC LIMIT 1`,
          user.id
        );
        orderNo = row ? row.order_no : '';
      }
      if (!orderNo) {
        return fail('NO_REFUNDABLE_ORDER', '没查到可退款的订单。如果是支付异常，我可以帮你转人工客服。', {
          actionList: [cards.btnOpenOrders(), cards.btnOpenService()],
        });
      }
      const res = await createRefundFor(db, user, { orderNo, reason: body.reason });
      tools.push(...res.tools);
      if (!res.ok) return fail(res.code || 'REFUND_FAILED', res.message, { actionList: [cards.btnOpenService()] });

      next.lastOrderNo = orderNo;
      next.lastRefundNo = res.refund.refundNo;
      next.stage = res.refund.status === 'succeeded' ? 'refunded' : 'refunding';
      return {
        ok: true,
        action,
        result: { refundNo: res.refund.refundNo, status: res.refund.status, amountCents: res.refund.amountCents, autoApproved: res.refund.autoApproved },
        message: res.message,
        cardList: [cards.refundCard({ ...res.refund, orderNo: res.refund.orderNo || orderNo })],
        actionList: [cards.btnOpenOrders()],
        state: next,
        tools,
      };
    }

    case 'open_product': {
      const productId = String(body.productId || next.lastProductId || '').trim();
      if (!productId) return fail('NO_PRODUCT', '想看哪门课？告诉我目标，我先把课程卡片发你。');
      const row = db.get("SELECT * FROM products WHERE id = ?", productId);
      if (!row) return fail('NOT_FOUND', '这门课找不到了，可能已经下架。');
      if (row.status !== 'on') return fail('NOT_FOUND', '这门课已经下架了，我另外推一门给你？');
      next.lastProductId = productId;
      return {
        ok: true,
        action,
        result: { route: `/product/${productId}`, productId, title: row.title },
        message: `已打开《${row.title}》详情。`,
        cardList: [cards.productCard(row)],
        actionList: [cards.btnCreateOrder(productId), cards.btnOpenService()],
        state: next,
        tools,
      };
    }

    case 'open_orders': {
      return {
        ok: true,
        action,
        result: { route: '/orders', status: body.status || '' },
        message: '已跳到「我的订单」。',
        cardList: [],
        actionList: [],
        state: next,
        tools,
      };
    }

    case 'open_service': {
      const conv = serviceSvc.ensureConversation(db, user.id);
      return {
        ok: true,
        action,
        result: { route: '/service', conversationId: conv.id },
        message: '已为你打开客服会话，人工客服 9:00-21:00 在线。',
        cardList: [],
        actionList: [],
        state: next,
        tools,
      };
    }

    case 'open_dist': {
      return {
        ok: true,
        action,
        result: { route: '/dist', inviteCode: user.invite_code || '' },
        message: '已打开分销中心，邀请码和团队数据都在里面。',
        cardList: [],
        actionList: [cards.btnBindInvite('')].slice(0, 0),
        state: next,
        tools,
      };
    }

    case 'bind_invite': {
      const res = await bindInviteFor(db, user, body.inviteCode);
      tools.push(...res.tools);
      if (!res.ok) return fail(res.code || 'BIND_FAILED', res.message, { actionList: [cards.btnOpenDist()] });
      return {
        ok: true,
        action,
        result: res.result,
        message: res.message,
        cardList: [],
        actionList: [cards.btnOpenDist()],
        state: next,
        tools,
      };
    }

    default:
      return fail('UNKNOWN_ACTION', '这个按钮我还不认识，你可以直接说需求，比如「我想减脂」。');
  }
}

module.exports = {
  ACTIONS,
  UNAVAILABLE,
  run,
  createOrderAndPay,
  payOrderFor,
  mockPayFor,
  createRefundFor,
  bindInviteFor,
  waitEntitlements,
  myEntitlements,
  latestOutTradeNo,
};
