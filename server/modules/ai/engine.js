'use strict';
/**
 * AI 意图引擎（rule provider）。
 *
 * 完全离线：不联网、不依赖第三方包，只读 SQLite + 调用 order/payment/refund 的既有能力。
 * 覆盖 docs/API.md §10 的 11 类意图：
 *   recommend / price / create_order / pay / mock_pay / refund /
 *   orders / entitlements / service / dist / fallback
 *
 * respond() 返回 { content, cards, actions, state, tools }：
 *   - cards / actions 给前端渲染，字段见 ./cards.js
 *   - tools 交给 ai/service.js 写 ai_actions 审计
 */
const cards = require('./cards');
const actions = require('./actions');
const serviceSvc = require('../service/service');
const { centsToYuanString } = require('../../utils/money');

const INTENTS = [
  'recommend',
  'price',
  'create_order',
  'pay',
  'mock_pay',
  'refund',
  'orders',
  'entitlements',
  'service',
  'dist',
  'fallback',
];

const SUGGESTIONS = ['我想减脂，推荐课程', '我的订单在哪', '怎么退款', '怎么赚佣金'];

/* ------------------------------ 意图识别 ------------------------------ */

const GOAL_KEYWORDS = [
  { goal: '减脂', words: ['减脂', '减肥', '燃脂', '掉秤', '瘦身', '体重', '脂肪', '瘦'] },
  { goal: '塑形', words: ['塑形', '马甲线', '翘臀', '美腿', '线条', '紧致', '体态', '塑'] },
  { goal: '舒缓', words: ['肩颈', '颈椎', '腰痛', '腰背', '久坐', '落枕', '酸', '疼', '痛', '僵硬', '理疗', '放松', '不舒服'] },
  { goal: '孕产', words: ['孕产', '产后', '孕期', '备孕', '宝妈', '怀孕'] },
  { goal: '入门', words: ['入门', '零基础', '新手', '初学', '没练过', '小白', '刚开始'] },
  { goal: '进阶', words: ['进阶', '提升', '高级', '老手', '突破'] },
];

const INTENT_RULES = [
  {
    intent: 'mock_pay',
    words: ['我付好了', '我已经付', '已支付', '支付好了', '付好了', '付完了', '付过了', '付款成功', '支付成功', '付钱了', '我付款了', '已经付款'],
  },
  { intent: 'pay', words: ['支付', '付款', '怎么付', '去付', '收银台', '结账', '付钱', '买单'] },
  { intent: 'refund', words: ['退款', '退钱', '退课', '退费', '不想要', '退了', '退一下', '申请退', '退我'] },
  { intent: 'orders', words: ['我的订单', '订单呢', '订单在', '查订单', '订单列表', '买了什么', '购买记录', '我的单', '订单号'] },
  { intent: 'entitlements', words: ['我的课', '怎么上课', '上课', '核销', '已开通', '课程在哪', '学习记录', '我的课程', '怎么看课'] },
  { intent: 'service', words: ['客服', '人工', '投诉', '售后', '有人吗', '转人工', '联系你们'] },
  { intent: 'dist', words: ['赚钱', '分销', '邀请', '佣金', '推广', '分享赚', '提现', '代理', '赚佣金', '返现'] },
  { intent: 'price', words: ['多少钱', '价格', '贵', '优惠', '便宜', '打折', '报价', '学费', '几块', '折'] },
  { intent: 'create_order', words: ['买', '下单', '就这个', '要这个', '来一个', '报名', '拍下', '定了', '拿下', '这个课'] },
  { intent: 'recommend', words: ['推荐', '有什么课', '适合我', '课程推荐', '学什么', '怎么选', '练什么', '哪门'] },
];

function normalizeText(text) {
  return String(text === null || text === undefined ? '' : text)
    .toLowerCase()
    .replace(/\s+/g, '');
}

function detectGoal(normalized) {
  for (const item of GOAL_KEYWORDS) {
    if (item.words.some((word) => normalized.includes(word))) return item.goal;
  }
  return null;
}

/** 文本 → { intent, goal }；顺序即优先级 */
function classify(text) {
  const t = normalizeText(text);
  const goal = detectGoal(t);
  for (const rule of INTENT_RULES) {
    if (rule.words.some((word) => t.includes(word))) return { intent: rule.intent, goal };
  }
  if (goal) return { intent: 'recommend', goal };
  return { intent: 'fallback', goal: null };
}

/** 从文本里抠邀请码（形如 DEMOA） */
function detectInviteCode(text) {
  const raw = String(text || '').toUpperCase();
  if (!/邀请码|绑定|上级|上级码/.test(raw)) return null;
  const m = raw.replace(/\s+/g, '').match(/([0-9A-Z]{6,10})/);
  return m ? m[1] : null;
}

/* ------------------------------ 数据查询 ------------------------------ */

function findProductsByGoal(db, goal, limit = 2) {
  if (!goal) return [];
  return db.all(
    "SELECT * FROM products WHERE status = 'on' AND goal_tags LIKE ? ORDER BY price_cents ASC, sort ASC LIMIT ?",
    `%${goal}%`,
    Math.max(1, Number(limit) || 2)
  );
}

function topProducts(db, limit = 2) {
  return db.all(
    "SELECT * FROM products WHERE status = 'on' ORDER BY sales DESC, sort ASC LIMIT ?",
    Math.max(1, Number(limit) || 2)
  );
}

function findProduct(db, productId) {
  if (!productId) return null;
  return db.get('SELECT * FROM products WHERE id = ?', productId) || null;
}

function recentOrders(db, userId, limit = 5) {
  return db.all(
    'SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
    userId,
    Math.max(1, Number(limit) || 5)
  );
}

function refundableOrder(db, userId) {
  return (
    db.get(
      `SELECT * FROM orders
        WHERE user_id = ?
          AND status IN ('paid','completed','partial_refunded')
          AND refunded_cents < paid_cents
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      userId
    ) || null
  );
}

function pendingOrder(db, userId) {
  return (
    db.get(
      "SELECT * FROM orders WHERE user_id = ? AND status IN ('pending','created') ORDER BY created_at DESC, rowid DESC LIMIT 1",
      userId
    ) || null
  );
}

function priceRange(db) {
  const row = db.get("SELECT MIN(price_cents) AS lo, MAX(price_cents) AS hi FROM products WHERE status = 'on'");
  return { lo: Number((row && row.lo) || 0), hi: Number((row && row.hi) || 0) };
}

/* ------------------------------ 各意图回复 ------------------------------ */

function replyRecommend(db, user, state, goal) {
  let rows = goal ? findProductsByGoal(db, goal, 2) : [];
  if (!rows.length) rows = topProducts(db, 2);
  if (!rows.length) {
    return {
      content: '课程正在上架中，我这边暂时没有可推荐的课。要不要先联系客服，让教练帮你排个练习计划？',
      cards: [],
      actions: [cards.btnOpenService()],
    };
  }
  const first = rows[0];
  state.lastProductId = first.id;
  state.stage = 'browsing';
  state.goal = goal || state.goal || null;

  const actionsList = [cards.btnCreateOrder(first.id), cards.btnOpenProduct(first.id)];
  if (rows[1]) actionsList.push(cards.btnOpenProduct(rows[1].id, '看看另一门'));

  const head = goal ? `${goal}方向的话` : '先看这两门';
  const detail = rows
    .map((row) => `《${row.title}》¥${centsToYuanString(row.price_cents)}${row.schedule ? `（${row.schedule}）` : ''}`)
    .join('；');
  return {
    content: `${head}：${detail}。想直接报名就点「立即下单」，我再帮你结算。`,
    cards: rows.map(cards.productCard),
    actions: actionsList,
  };
}

function replyPrice(db, user, state, goal) {
  let row = findProduct(db, state.lastProductId);
  if (!row) {
    const byGoal = goal ? findProductsByGoal(db, goal, 1) : [];
    row = byGoal[0] || topProducts(db, 1)[0] || null;
  }
  if (!row) {
    return {
      content: '价格还在配置中，你可以直接问客服要报价单。',
      cards: [],
      actions: [cards.btnOpenService()],
    };
  }
  state.lastProductId = row.id;

  const discount = cards.discountOf(row.price_cents, row.original_price_cents);
  const origin = Number(row.original_price_cents || 0);
  const priceText = `¥${centsToYuanString(row.price_cents)}`;
  const originPart = origin > Number(row.price_cents) ? `（原价 ¥${centsToYuanString(origin)}，${discount}）` : '';
  const typeText = cards.productTypeText(row.type);
  return {
    content: `《${row.title}》现价 ${priceText}${originPart}。${typeText}${row.schedule ? `，${row.schedule}` : ''}${
      row.teacher ? `，授课老师 ${row.teacher}` : ''
    }。报名后立即在「我的课程」可见，回放永久有效。分两期也可以，直接点「立即下单」我先帮你占位。`,
    cards: [cards.productCard(row)],
    actions: [cards.btnCreateOrder(row.id), cards.btnOpenProduct(row.id), cards.btnOpenService()],
  };
}

async function replyCreateOrder(db, user, state, goal) {
  // 没有选中课程：有目标词就回到推荐，否则引导
  if (!state.lastProductId) {
    if (goal) return replyRecommend(db, user, state, goal);
    return {
      content: '你想报哪门课？告诉我目标（减脂 / 塑形 / 缓解肩颈 / 产后恢复期），我帮你挑一门合适的。',
      cards: topProducts(db, 2).map(cards.productCard),
      actions: SUPPORT_ACTIONS(db),
    };
  }

  // 目标词和已选课程不匹配 → 重新推荐，避免买错课
  const current = findProduct(db, state.lastProductId);
  if (goal && current && !String(current.goal_tags || '').includes(goal)) {
    return replyRecommend(db, user, state, goal);
  }
  if (current && current.status !== 'on') {
    state.lastProductId = null;
    return {
      content: '这门课刚刚下架了，我另外推两门给你。',
      cards: topProducts(db, 2).map(cards.productCard),
      actions: SUPPORT_ACTIONS(db),
    };
  }

  const res = await actions.createOrderAndPay(db, user, { productId: state.lastProductId });
  const tools = res.tools || [];

  if (!res.ok) {
    if (res.code === 'DUPLICATE_ORDER') {
      state.lastOrderNo = res.orderNo;
      state.stage = 'ordering';
      state.pendingConfirm = { action: 'pay_order', orderNo: res.orderNo };
      return {
        content: res.message,
        cards: [],
        actions: [cards.btnPayOrder(res.orderNo), cards.btnOpenOrders()],
        tools,
      };
    }
    return { content: res.message, cards: [], actions: [cards.btnOpenOrders(), cards.btnOpenService()], tools };
  }

  state.lastOrderNo = res.orderNo;
  state.lastOutTradeNo = res.pay ? res.pay.outTradeNo : null;
  state.stage = res.pay ? 'paying' : 'ordering';
  state.pendingConfirm = null;

  if (res.pay) {
    return {
      content: res.message,
      cards: [
        cards.payCard({
          orderNo: res.orderNo,
          outTradeNo: res.pay.outTradeNo,
          provider: res.pay.provider,
          mock: res.pay.mock,
          payParams: res.pay.payParams,
          amountCents: res.pay.amountCents || res.order.totalCents,
        }),
      ],
      actions: [cards.btnMockPay({ orderNo: res.orderNo, outTradeNo: res.pay.outTradeNo }), cards.btnOpenOrders()],
      tools,
    };
  }

  return {
    content: res.message,
    cards: [
      cards.orderCard({
        order_no: res.orderNo,
        id: res.orderId,
        status: res.order.status,
        total_cents: res.order.totalCents,
        expire_at: res.order.expireAt,
      }),
    ],
    actions: [cards.btnPayOrder(res.orderNo), cards.btnOpenOrders()],
    tools,
  };
}

async function replyPay(db, user, state) {
  if (!state.lastOrderNo) {
    // 「怎么付」但没有订单：有选中课程就先下单开收银台
    if (state.lastProductId) return replyCreateOrder(db, user, state, null);
    const pending = pendingOrder(db, user.id);
    if (!pending) {
      return {
        content: '还没有待支付的订单。先告诉我想练什么，我帮你挑课下单，再一起走到付款。',
        cards: topProducts(db, 2).map(cards.productCard),
        actions: SUPPORT_ACTIONS(db),
      };
    }
    state.lastOrderNo = pending.order_no;
  }

  const res = await actions.payOrderFor(db, user, { orderNo: state.lastOrderNo });
  const tools = res.tools || [];
  if (!res.ok) {
    return { content: res.message, cards: [], actions: [cards.btnOpenOrders(), cards.btnOpenService()], tools };
  }
  state.lastOutTradeNo = res.pay.outTradeNo;
  state.stage = 'paying';
  state.pendingConfirm = null;
  return {
    content: `收银台已经打开（订单 ${state.lastOrderNo}，应付 ¥${res.pay.amountText || '--'}）。${
      res.pay.mock ? '这是模拟支付，点「我已支付」就能立刻开通课程。' : '付好后回来告诉我一声，我帮你确认开通。'
    }`,
    cards: [
      cards.payCard({
        orderNo: state.lastOrderNo,
        outTradeNo: res.pay.outTradeNo,
        provider: res.pay.provider,
        mock: res.pay.mock,
        payParams: res.pay.payParams,
        amountCents: res.pay.amountCents,
      }),
    ],
    actions: [cards.btnMockPay({ orderNo: state.lastOrderNo, outTradeNo: res.pay.outTradeNo }), cards.btnOpenOrders()],
    tools,
  };
}

async function replyMockPay(db, user, state) {
  const orderNo = state.lastOrderNo || (pendingOrder(db, user.id) || {}).order_no || null;
  const res = await actions.mockPayFor(db, user, { orderNo, outTradeNo: state.lastOutTradeNo });
  const tools = res.tools || [];
  if (!res.ok) {
    return { content: res.message, cards: [], actions: [cards.btnOpenOrders(), cards.btnOpenService()], tools };
  }

  state.lastOrderNo = res.orderNo;
  state.lastOutTradeNo = res.outTradeNo;
  state.stage = 'paid';

  const rows = res.entitlements || [];
  const cardList = rows.length
    ? rows.map(cards.entitlementCard)
    : [cards.textCard('支付已确认，课程正在开通，几秒后在「我的课程」里就能看到核销码。')];
  const titleText = rows.length ? `《${rows[0].title || '课程'}》` : '你的课程';
  const codeText = rows.length && rows[0].verify_code ? `，到店核销码 ${rows[0].verify_code}` : '';
  return {
    content: `支付成功！${titleText}已开通${codeText}。上课有疑问随时问我，或者点「联系客服」找人工。`,
    cards: cardList,
    actions: [cards.btnOpenOrders(), cards.btnOpenService()],
    tools,
  };
}

async function replyRefund(db, user, state) {
  const order = refundableOrder(db, user.id);
  if (!order) {
    const anyOrder = recentOrders(db, user.id, 1)[0];
    return {
      content: anyOrder
        ? '你当前没有可退款的订单（退款中的订单要等审核完成）。已经退过的订单在「我的订单」里能看到退款记录。'
        : '你还没有可退款的订单。如果已经付过款却没看到课程，把订单号发我，或者直接转人工客服查一下。',
      cards: [],
      actions: [cards.btnOpenOrders(), cards.btnOpenService()],
      tools: [],
    };
  }

  const windowDays = db.getSettingNumber('refund_window_days', 7);
  const autoMax = db.getSettingNumber('auto_refund_max_cents', 20000);
  const autoOn = db.getSetting('auto_refund_enabled', true) !== false;
  const ruleText = `退款规则：付款后 ${windowDays} 天内、且课程未开始学习可申请；${
    autoOn ? `¥${centsToYuanString(autoMax)} 以内自动通过` : '需要人工审核'
  }，款项原路退回，1-3 个工作日到账。`;

  const res = await actions.createRefundFor(db, user, {
    orderNo: order.order_no,
    reason: '不想要了',
    reasonType: 'ai',
  });
  const tools = res.tools || [];
  if (!res.ok) {
    return { content: `${ruleText}\n${res.message}`, cards: [], actions: [cards.btnOpenOrders(), cards.btnOpenService()], tools };
  }

  state.lastOrderNo = order.order_no;
  state.lastRefundNo = res.refund.refundNo;
  state.stage = res.refund.status === 'succeeded' ? 'refunded' : 'refunding';
  const amountText = `¥${centsToYuanString(res.refund.amountCents || order.paid_cents)}`;
  return {
    content: `${ruleText}\n我已经帮你把订单 ${order.order_no}（${amountText}）提交退款：${res.message}`,
    cards: [cards.refundCard({ ...res.refund, orderNo: order.order_no })],
    actions: [cards.btnOpenOrders(), cards.btnOpenService()],
    tools,
  };
}

function replyOrders(db, user, state) {
  const rows = recentOrders(db, user.id, 5);
  if (!rows.length) {
    return {
      content: '你还没有下过单。要不要我先按你的目标推荐一门？',
      cards: topProducts(db, 2).map(cards.productCard),
      actions: SUPPORT_ACTIONS(db),
    };
  }
  const unpaid = rows.filter((row) => row.status === 'pending' || row.status === 'created');
  const actionsList = [cards.btnOpenOrders()];
  if (unpaid.length) actionsList.unshift(cards.btnPayOrder(unpaid[0].order_no));
  return {
    content: `你最近有 ${rows.length} 笔订单，最新一笔是 ${rows[0].order_no}（${cards.orderStatusText(rows[0].status)}，¥${centsToYuanString(
      rows[0].total_cents
    )}）。${unpaid.length ? '还有未付款的订单，点「去支付」可以继续。' : '需要退款或开发票都可以跟我说。'}`,
    cards: rows.map((row) => cards.orderCard(row)),
    actions: actionsList,
  };
}

function replyEntitlements(db, user, state) {
  const rows = actions.myEntitlements(db, user.id, 5);
  if (!rows.length) {
    return {
      content: '你还没有已开通的课程。付款成功后系统会自动开通，通常几秒内到账；如果有付款成功但没看到课程，告诉我订单号，我帮你查。',
      cards: [],
      actions: [cards.btnOpenOrders(), cards.btnOpenService()],
    };
  }
  const first = rows[0];
  return {
    content: `你已开通 ${rows.length} 门课，最新是《${first.title}》${first.verify_code ? `，核销码 ${first.verify_code}` : ''}。线上课直接在「我的课程」里看，到店课记得提前 4 小时预约。`,
    cards: rows.map(cards.entitlementCard),
    actions: [cards.btnOpenService()],
  };
}

function replyService(db, user, state) {
  const conv = serviceSvc.ensureConversation(db, user.id);
  state.stage = state.stage || 'browsing';
  return {
    content: '已帮你接入人工客服（9:00-21:00 在线）。你可以把问题直接发在会话里，也可以先告诉我，我能当场解决的会先解决。',
    cards: [],
    actions: [cards.btnOpenService(conv.id)],
  };
}

function replyDist(db, user, state) {
  const l1 = db.getSettingNumber('commission_l1_bps', 1500);
  const l2 = db.getSettingNumber('commission_l2_bps', 500);
  const freeze = db.getSettingNumber('freeze_days', 7);
  const minWithdraw = db.getSettingNumber('min_withdraw_cents', 1000);
  const code = user.invite_code || '';
  const inviteCode = detectInviteCode(state.__text || '');
  const actionsList = [cards.btnOpenDist()];
  if (inviteCode) actionsList.push(cards.btnBindInvite(inviteCode));
  return {
    content: `二级分销怎么赚：你直接邀请的好友下单，你得 ${(l1 / 100).toFixed(1)}%；好友再邀请的人下单，你得 ${(
      l2 / 100
    ).toFixed(1)}%。佣金冻结 ${freeze} 天后可提现，最低提现 ¥${centsToYuanString(minWithdraw)}。你的专属邀请码是 ${
      code || '（生成中）'
    }，分享给好友下单就自动到账。${
      inviteCode ? `\n你发的 ${inviteCode} 是别人的邀请码，点「绑定邀请码」我帮你绑成上级。` : ''
    }`,
    cards: [],
    actions: actionsList,
  };
}

function replyFallback(db, user, state) {
  return {
    content:
      '我是瑜伽馆的 AI 顾问，可以帮你选课、下单、查订单、申请退款，也能算分销佣金。你可以直接说需求，比如「我想减脂」「我的订单在哪」「怎么退款」。',
    cards: [cards.textCard(`换个说法试试：${SUGGESTIONS.join(' / ')}`)],
    actions: [cards.btnOpenService()],
  };
}

/** 无课程卡片时的通用按钮组 */
function SUPPORT_ACTIONS(db) {
  const rows = topProducts(db, 2);
  const list = rows.map((row) => cards.btnCreateOrder(row.id));
  list.push(cards.btnOpenService());
  return list;
}

/* ------------------------------ 主入口 ------------------------------ */

/**
 * @param {{db:object, user:object, state:object, text:string, intent:string, goal:string|null}} input
 * @returns {Promise<{content:string, cards:Array, actions:Array, state:object, tools:Array}>}
 */
async function respond(input) {
  const { db, user, text } = input;
  const state = Object.assign({}, input.state);
  state.intent = input.intent;
  state.__text = text;

  let out;
  switch (input.intent) {
    case 'recommend':
      out = replyRecommend(db, user, state, input.goal);
      break;
    case 'price':
      out = replyPrice(db, user, state, input.goal);
      break;
    case 'create_order':
      out = await replyCreateOrder(db, user, state, input.goal);
      break;
    case 'pay':
      out = await replyPay(db, user, state);
      break;
    case 'mock_pay':
      out = await replyMockPay(db, user, state);
      break;
    case 'refund':
      out = await replyRefund(db, user, state);
      break;
    case 'orders':
      out = replyOrders(db, user, state);
      break;
    case 'entitlements':
      out = replyEntitlements(db, user, state);
      break;
    case 'service':
      out = replyService(db, user, state);
      break;
    case 'dist':
      out = replyDist(db, user, state);
      break;
    default:
      out = replyFallback(db, user, state);
      break;
  }

  delete state.__text;
  return {
    content: String(out.content || ''),
    cards: Array.isArray(out.cards) ? out.cards : [],
    actions: Array.isArray(out.actions) ? out.actions : [],
    state,
    tools: Array.isArray(out.tools) ? out.tools : [],
  };
}

/**
 * 客服自动回复：只出文案，绝不产生订单/退款等副作用。
 * @returns {{content:string, intent:string}}
 */
function serviceAutoReply(db, user, text) {
  const { intent, goal } = classify(text);
  const welcome = serviceSvc.welcomeText(db);

  switch (intent) {
    case 'recommend': {
      const rows = goal ? findProductsByGoal(db, goal, 2) : topProducts(db, 2);
      if (!rows.length) return { content: welcome, intent };
      return {
        intent,
        content: `${goal ? `${goal}方向` : '先推荐'}给你：${rows
          .map((row) => `《${row.title}》¥${centsToYuanString(row.price_cents)}`)
          .join('、')}。想报名可以直接在 AI 商城对话里说「买这个」，我帮你下单。`,
      };
    }
    case 'price': {
      const { lo, hi } = priceRange(db);
      if (!lo) return { content: welcome, intent };
      return {
        intent,
        content: `课程价格在 ¥${centsToYuanString(lo)} - ¥${centsToYuanString(hi)} 之间，按课时和形式不同；报具体课程名我可以给你准确报价。`,
      };
    }
    case 'create_order':
    case 'pay':
    case 'mock_pay':
      return {
        intent,
        content: '下单和付款在「AI 商城」对话里最方便：告诉我课程名或说「买这个」，会直接出收银台。付款后权益自动开通。',
      };
    case 'orders': {
      const rows = recentOrders(db, user.id, 3);
      if (!rows.length) return { intent, content: '你还没有订单。先把目标告诉我（减脂 / 塑形 / 肩颈 / 产后），我帮你选课。' };
      return {
        intent,
        content: `你最近 ${rows.length} 笔订单：${rows
          .map((row) => `${row.order_no}（${cards.orderStatusText(row.status)} ¥${centsToYuanString(row.total_cents)}）`)
          .join('、')}。`,
      };
    }
    case 'entitlements': {
      const rows = actions.myEntitlements(db, user.id, 5);
      if (!rows.length) return { intent, content: '你还没有已开通的课程。付款成功后会自动开通，通常几秒内到账。' };
      return {
        intent,
        content: `你已开通 ${rows.length} 门课：${rows.map((row) => `《${row.title}》${row.verify_code ? `（核销码 ${row.verify_code}）` : ''}`).join('、')}。`,
      };
    }
    case 'refund': {
      const windowDays = db.getSettingNumber('refund_window_days', 7);
      return {
        intent,
        content: `退款政策：付款后 ${windowDays} 天内、课程未开始学习可申请，款项原路退回 1-3 个工作日到账。需要我直接帮你提交退款就回「退款」。`,
      };
    }
    case 'dist': {
      const l1 = db.getSettingNumber('commission_l1_bps', 1500);
      const l2 = db.getSettingNumber('commission_l2_bps', 500);
      return {
        intent,
        content: `分销佣金：一级 ${(l1 / 100).toFixed(1)}%、二级 ${(l2 / 100).toFixed(
          1
        )}%，冻结 7 天后可提现。你的邀请码是 ${user.invite_code || '（生成中）'}。`,
      };
    }
    case 'service':
      return { intent, content: '我在的～ 你把问题发出来，复杂的情况我马上转人工客服（9:00-21:00 在线）。' };
    default:
      return { intent, content: welcome };
  }
}

module.exports = {
  INTENTS,
  SUGGESTIONS,
  classify,
  detectGoal,
  detectInviteCode,
  respond,
  serviceAutoReply,
  findProductsByGoal,
  topProducts,
  findProduct,
  recentOrders,
  refundableOrder,
  pendingOrder,
};
