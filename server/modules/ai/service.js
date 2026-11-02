'use strict';
/**
 * AI 商城业务逻辑（docs/API.md §10）。
 *
 * 对话链路：文本 → 意图（rule 引擎离线判定，llm 可选增强）→ 引擎产出卡片/按钮 + 副作用
 *          → 落库 ai_messages / ai_actions / ai_sessions.state
 * 动作链路：按钮 → actions.run（延迟 require 各业务模块，缺失则友好降级）→ 落库
 *
 * 资金类意图（下单 / 支付 / 退款）的判定始终以离线规则为准，LLM 只影响文案与只读意图，
 * 避免模型误判导致用户被扣款或订单被创建。
 */
const config = require('../../config');
const { ApiError, errors } = require('../../http/errors');
const engine = require('./engine');
const llm = require('./llm');
const actions = require('./actions');
const sessionSvc = require('./session');
const { pageResult } = require('../../http/validate');

const MUTATING = new Set(['create_order', 'pay', 'mock_pay', 'refund']);
const MAX_TEXT = 500;

function providerName() {
  return llm.available() ? 'llm' : 'rule';
}

/** 会话归属校验：不是自己的会话一律 404，避免越权读别人的对话 */
function requireSession(db, sessionId, userId) {
  const session = sessionSvc.getSessionForUser(db, sessionId, userId);
  if (!session) throw errors.notFound('会话不存在或已失效');
  return session;
}

function trimTitle(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > 20 ? `${t.slice(0, 20)}…` : t;
}

/** 只读意图允许 LLM 决定，资金意图以本地规则为准 */
function pickIntent(ruleIntent, llmIntent) {
  if (MUTATING.has(ruleIntent)) return ruleIntent;
  if (llmIntent && engine.INTENTS.includes(llmIntent)) return llmIntent;
  return ruleIntent;
}

/* ------------------------------ 会话 ------------------------------ */

function sessionView(db, session) {
  return {
    sessionId: session.id,
    provider: session.provider,
    status: session.status,
    title: session.title || '',
    state: sessionSvc.parseState(session),
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    messages: sessionSvc.listAiMessages(db, session.id, 50),
  };
}

function openSession(db, user) {
  const session = sessionSvc.getOrCreateSession(db, user, providerName());
  return sessionView(db, session);
}

function getSession(db, user, sessionId) {
  const session = requireSession(db, sessionId, user.id);
  return sessionView(db, session);
}

/* ------------------------------ 对话 ------------------------------ */

async function chat(db, user, { sessionId, text }) {
  const content = String(text === null || text === undefined ? '' : text).trim();
  if (!content) throw errors.validation('说点什么吧，比如「我想减脂」');
  if (content.length > MAX_TEXT) throw new ApiError(422, 'VALIDATION_ERROR', `一次最多说 ${MAX_TEXT} 个字`);

  const session = sessionId
    ? requireSession(db, sessionId, user.id)
    : sessionSvc.getOrCreateSession(db, user, providerName());
  const state = sessionSvc.parseState(session);
  const rule = engine.classify(content);

  // LLM 只做「润色 + 只读意图纠偏」，超时/报错自动降级到 rule
  let llmRes = { ok: false, provider: 'llm' };
  if (llm.available()) {
    const history = sessionSvc.recentMessages(db, session.id, 8);
    llmRes = await llm.complete({ text: content, history, state });
  }

  const intent = pickIntent(rule.intent, llmRes.ok ? llmRes.intent : null);
  const provider = llmRes.ok ? 'llm' : 'rule';

  const out = await engine.respond({ db, user, text: content, intent, goal: rule.goal, state });

  let replyText = out.content;
  if (llmRes.ok && llmRes.reply && !MUTATING.has(intent)) replyText = llmRes.reply;
  if (!replyText) replyText = '我在的，你可以说说想练什么，我帮你挑课。';

  const stateNext = out.state || state;
  stateNext.intent = intent;

  const userMsg = sessionSvc.appendAiMessage(db, {
    sessionId: session.id,
    role: 'user',
    content,
    meta: { intent, provider, goal: rule.goal || null },
  });
  const assistantMsg = sessionSvc.appendAiMessage(db, {
    sessionId: session.id,
    role: 'assistant',
    content: replyText,
    meta: { cards: out.cards, actions: out.actions, intent, provider },
  });

  sessionSvc.saveState(db, session.id, stateNext, {
    provider,
    title: session.title || trimTitle(content),
  });
  sessionSvc.logTools(db, { sessionId: session.id, userId: user.id, tools: out.tools });

  return {
    sessionId: session.id,
    reply: { content: replyText, cards: out.cards, actions: out.actions },
    messages: [sessionSvc.publicAiMessage(userMsg), sessionSvc.publicAiMessage(assistantMsg)],
    state: stateNext,
    provider,
  };
}

/* ------------------------------ 动作 ------------------------------ */

async function runAction(db, user, { sessionId, action, payload }) {
  const session = sessionId
    ? requireSession(db, sessionId, user.id)
    : sessionSvc.getOrCreateSession(db, user, providerName());
  const state = sessionSvc.parseState(session);

  const res = await actions.run(db, user, { action, payload: payload || {}, state });
  const stateNext = res.state || state;
  stateNext.intent = stateNext.intent || null;

  let messageRow = null;
  if (res.message) {
    messageRow = sessionSvc.appendAiMessage(db, {
      sessionId: session.id,
      role: 'assistant',
      content: res.message,
      meta: { cards: res.cardList || [], actions: res.actionList || [], action, intent: stateNext.intent },
    });
  }
  sessionSvc.logTools(db, { sessionId: session.id, userId: user.id, tools: res.tools });
  sessionSvc.saveState(db, session.id, stateNext);

  if (!res.ok) {
    return {
      ok: false,
      action,
      sessionId: session.id,
      code: res.code || 'ACTION_FAILED',
      message: res.message || '这一步没走通，换个方式试试？',
      ...(res.needConfirm ? { needConfirm: true } : {}),
      state: stateNext,
    };
  }

  return {
    ok: true,
    action,
    sessionId: session.id,
    result: res.result || null,
    message: res.message || '',
    cards: res.cardList || [],
    actions: res.actionList || [],
    state: stateNext,
    messageId: messageRow ? messageRow.id : null,
  };
}

/* ---------------------------- 推荐问题 / 日志 ---------------------------- */

function suggestions() {
  return { suggestions: engine.SUGGESTIONS.slice() };
}

/** 后台：AI 动作审计日志 */
function adminLogs(db, query = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const size = Math.max(1, Math.min(100, Number(query.size) || 20));
  const offset = (page - 1) * size;
  const where = [];
  const params = [];
  if (query.sessionId) {
    where.push('a.session_id = ?');
    params.push(String(query.sessionId));
  }
  if (query.tool) {
    where.push('a.tool = ?');
    params.push(String(query.tool));
  }
  if (query.status) {
    where.push('a.status = ?');
    params.push(String(query.status));
  }
  if (query.userId) {
    where.push('a.user_id = ?');
    params.push(String(query.userId));
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = Number(
    db.pluck(`SELECT COUNT(*) FROM ai_actions a ${clause}`, ...params) || 0
  );
  const rows = db.all(
    `SELECT a.*, u.nickname AS user_nickname, s.provider AS session_provider
       FROM ai_actions a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN ai_sessions s ON s.id = a.session_id
       ${clause}
      ORDER BY a.created_at DESC, a.rowid DESC
      LIMIT ? OFFSET ?`,
    ...params,
    size,
    offset
  );

  const list = rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    userId: row.user_id,
    userNickname: row.user_nickname || '',
    provider: row.session_provider || 'rule',
    tool: row.tool,
    args: sessionSvc.parseJson(row.args, null),
    result: sessionSvc.parseJson(row.result, null),
    status: row.status,
    createdAt: row.created_at,
  }));

  return pageResult(list, total, { page, size });
}

module.exports = {
  MUTATING,
  providerName,
  openSession,
  getSession,
  chat,
  runAction,
  suggestions,
  adminLogs,
  trimTitle,
  pickIntent,
  engine,
  llm,
  actions,
  session: sessionSvc,
};
