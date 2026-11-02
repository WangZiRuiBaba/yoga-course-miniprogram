'use strict';
/**
 * AI 商城：会话 + 消息 + 卡片 + 动作。
 * /api/ai/action 与 /api/ai/chat 的 ok/result 在顶层，统一用 raw 模式自行判断。
 */
const request = require('../../utils/request.js');
const config = require('../../utils/config.js');
const view = require('../../utils/view.js');
const nav = require('../../utils/nav.js');
const invite = require('../../utils/invite.js');
const platform = require('../../utils/platform.js');

const FALLBACK_SUGGESTIONS = [
  '我想减脂，推荐课程',
  '我的订单在哪',
  '怎么退款',
  '怎么赚佣金',
];

/** 兼容 {ok:true,data} 与顶层结构两种返回 */
function unwrap(body) {
  if (body && typeof body === 'object' && body.ok === true && body.data !== undefined) return body.data;
  return body || {};
}

function toMessages(list, from) {
  const rows = Array.isArray(list) ? list : [];
  return rows.map(function (m, i) {
    return view.toAiMessage(m, from === undefined ? i : from + i);
  });
}

Page({
  data: {
    loading: true,
    error: '',
    sessionId: '',
    messages: [],
    input: '',
    sending: false,
    suggestions: FALLBACK_SUGGESTIONS,
    scrollTo: '',
    aiState: null,
    actionPending: false,
  },

  onLoad(options) {
    invite.consume(options);
    this.loadSuggestions();
    this.bootstrap();
  },

  onUnload() {
    const sessionId = this.data.sessionId;
    if (sessionId) config.storageSet(config.STORAGE_KEYS.aiSession, sessionId);
  },

  loadSuggestions() {
    request
      .get('/api/ai/suggestions', null, { auth: false, silent: true })
      .then((data) => {
        const list = Array.isArray(data) ? data : (data && data.list) || [];
        if (list.length > 0) this.setData({ suggestions: list.slice(0, 6) });
      })
      .catch(function () {
        /* 用内置兜底问题 */
      });
  },

  /** 优先恢复上次会话，失败则新建 */
  bootstrap() {
    this.setData({ loading: true, error: '' });
    const cached = config.storageGet(config.STORAGE_KEYS.aiSession, '');
    const task = cached
      ? request
          .get('/api/ai/session/' + cached, null, { raw: true, silent: true })
          .then((body) => {
            const d = unwrap(body);
            if (!d || !d.sessionId) throw new Error('会话已失效');
            return d;
          })
          .catch(function () {
            return null;
          })
      : Promise.resolve(null);

    return task
      .then((cachedSession) => {
        if (cachedSession) return cachedSession;
        return request
          .post('/api/ai/session', {}, { raw: true })
          .then(function (body) {
            return unwrap(body);
          });
      })
      .then((d) => {
        const data = d || {};
        const messages = toMessages(data.messages);
        this.setData({
          loading: false,
          sessionId: data.sessionId || '',
          messages: messages,
          aiState: data.state || null,
        });
        if (data.sessionId) config.storageSet(config.STORAGE_KEYS.aiSession, data.sessionId);
        this.scrollToBottom();
      })
      .catch((err) => {
        this.setData({ loading: false, error: (err && err.message) || 'AI 会话创建失败' });
      });
  },

  onRetry() {
    this.bootstrap();
  },

  onNewSession() {
    config.storageSet(config.STORAGE_KEYS.aiSession, '');
    this.setData({ sessionId: '', messages: [], input: '' });
    this.bootstrap();
  },

  onInput(e) {
    this.setData({ input: e.detail.value });
  },

  onPickSuggestion(e) {
    const text = e.currentTarget.dataset.text || '';
    if (!text) return;
    this.send(text);
  },

  onSend() {
    const text = String(this.data.input || '').trim();
    if (!text) return;
    this.send(text);
  },

  send(text) {
    if (this.data.sending) return;
    if (!this.data.sessionId) {
      request.toast('会话还没准备好，稍等一下');
      return;
    }
    const messages = this.data.messages.concat([
      view.toAiMessage({ role: 'user', content: text }, this.data.messages.length),
    ]);
    this.setData({ messages: messages, input: '', sending: true }, () => {
      this.scrollToBottom();
    });

    request
      .post('/api/ai/chat', { sessionId: this.data.sessionId, text: text }, { raw: true })
      .then((body) => {
        const d = unwrap(body);
        if (body && body.ok === false) {
          request.toast(body.message || 'AI 暂时没回应');
          this.setData({ sending: false });
          return;
        }
        let next = [];
        if (Array.isArray(d.messages) && d.messages.length > 0) {
          next = toMessages(d.messages);
        } else if (d.reply) {
          next = this.data.messages.concat([
            view.toAiMessage(
              { role: 'assistant', content: d.reply.content, cards: d.reply.cards, actions: d.reply.actions },
              this.data.messages.length
            ),
          ]);
        } else {
          next = this.data.messages;
        }
        this.setData({ sending: false, messages: next, aiState: d.state || this.data.aiState }, () => {
          this.scrollToBottom();
        });
      })
      .catch((err) => {
        this.setData({ sending: false });
        const code = err && err.code;
        if (code === 'TOO_MANY_REQUESTS') request.toast('问得太快啦，休息一下再问');
      });
  },

  scrollToBottom() {
    const len = this.data.messages.length;
    if (!len) return;
    this.setData({ scrollTo: 'msg-' + (len - 1) });
  },

  /** 点卡片：课程 / 订单 / 权益 分别跳转 */
  onTapCard(e) {
    const type = e.currentTarget.dataset.type || '';
    const productId = e.currentTarget.dataset.pid || '';
    const orderNo = e.currentTarget.dataset.no || '';
    const entId = e.currentTarget.dataset.ent || '';
    if (type === 'product' && productId) {
      nav.go('/pages/detail/detail' + request.pageQuery({ id: productId }));
      return;
    }
    if ((type === 'order' || type === 'pay') && orderNo) {
      if (type === 'pay') nav.go('/pages/pay/pay' + request.pageQuery({ orderNo: orderNo }));
      else nav.go('/pages/order-detail/order-detail' + request.pageQuery({ orderNo: orderNo }));
      return;
    }
    if (type === 'entitlement') {
      nav.go('/pages/entitlements/entitlements');
      return;
    }
    if (type === 'refund' && orderNo) {
      nav.go('/pages/refund/refund' + request.pageQuery({ orderNo: orderNo }));
      return;
    }
    if (productId) nav.go('/pages/detail/detail' + request.pageQuery({ id: productId }));
    else if (orderNo) nav.go('/pages/order-detail/order-detail' + request.pageQuery({ orderNo: orderNo }));
  },

  /** 执行 AI 建议动作 */
  onTapAction(e) {
    if (this.data.actionPending) return;
    const action = e.currentTarget.dataset.action || '';
    const payload = e.currentTarget.dataset.payload || {};
    if (!action) return;
    if (
      (action === 'create_order' || action === 'pay_order' || action === 'mock_pay') &&
      platform.guardPay()
    ) {
      return;
    }
    if (!this.data.sessionId) {
      request.toast('会话未就绪');
      return;
    }
    this.setData({ actionPending: true });
    request
      .post('/api/ai/action', { sessionId: this.data.sessionId, action: action, payload: payload }, { raw: true })
      .then((body) => {
        const d = body || {};
        this.setData({ actionPending: false });
        if (d.ok === false) {
          request.toast(d.message || '这个操作暂时做不了');
          return;
        }
        const result = d.result || {};
        // 把服务端的卡片/提示补进对话
        if (d.message || (Array.isArray(d.cards) && d.cards.length > 0)) {
          const extra = view.toAiMessage(
            { role: 'assistant', content: d.message || '', cards: d.cards || [], actions: d.actions || [] },
            this.data.messages.length
          );
          const messages = this.data.messages.concat([extra]);
          this.setData({ messages: messages, aiState: d.state || this.data.aiState }, () => {
            this.scrollToBottom();
          });
        } else if (d.state) {
          this.setData({ aiState: d.state });
        }
        this.routeAfterAction(action, result, payload);
      })
      .catch((err) => {
        this.setData({ actionPending: false });
        request.toast((err && err.message) || '操作失败，请重试');
      });
  },

  routeAfterAction(action, result, payload) {
    const res = result || {};
    const body = payload || {};
    if (action === 'create_order') {
      const orderNo = res.orderNo || (res.order && res.order.orderNo);
      if (orderNo) nav.go('/pages/pay/pay' + request.pageQuery({ orderNo: orderNo }));
      return;
    }
    if (action === 'pay_order' || action === 'mock_pay') {
      const orderNo = res.orderNo || body.orderNo;
      if (orderNo) nav.go('/pages/pay/pay' + request.pageQuery({ orderNo: orderNo }));
      return;
    }
    if (action === 'refund_order') {
      const orderNo = res.orderNo || body.orderNo;
      if (orderNo) nav.go('/pages/order-detail/order-detail' + request.pageQuery({ orderNo: orderNo }));
      return;
    }
    if (action === 'open_product') {
      const id = res.productId || body.productId;
      if (id) nav.go('/pages/detail/detail' + request.pageQuery({ id: id }));
      return;
    }
    if (action === 'open_orders') {
      nav.go('/pages/orders/orders');
      return;
    }
    if (action === 'open_service') {
      nav.go('/pages/service/service');
      return;
    }
    if (action === 'open_dist') {
      nav.go('/pages/dist/dist');
    }
  },

  onShareAppMessage() {
    return invite.shareMessage('AI 选课顾问 · 说说目标帮你选课', '/pages/ai/ai');
  },
});
