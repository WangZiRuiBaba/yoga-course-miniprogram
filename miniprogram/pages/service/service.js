'use strict';
/** 在线客服：会话加载 / 发送消息 / 轮询新消息 / 快捷话术 / 结束会话 */
const request = require('../../utils/request.js');
const format = require('../../utils/format.js');
const view = require('../../utils/view.js');
const nav = require('../../utils/nav.js');

const POLL_INTERVAL = 3000;

Page({
  data: {
    loading: true,
    error: '',
    messages: [],
    quickReplies: [],
    welcome: '',
    input: '',
    sending: false,
    scrollTo: '',
    conversationStatus: '',
    closed: false,
    lastAt: '',
  },

  onLoad() {
    this.timer = null;
    this.loadConversation();
  },

  onShow() {
    if (this.data.messages.length > 0) this.startPolling();
  },

  onHide() {
    this.stopPolling();
  },

  onUnload() {
    this.stopPolling();
  },

  onRetry() {
    this.loadConversation();
  },

  loadConversation() {
    this.setData({ loading: true, error: '' });
    return request
      .get('/api/service/conversation')
      .then((data) => {
        const d = data || {};
        const conversation = d.conversation || {};
        const messages = (Array.isArray(d.messages) ? d.messages : []).map(view.toServiceMessage);
        this.setData(
          {
            loading: false,
            messages: messages,
            quickReplies: (Array.isArray(d.quickReplies) ? d.quickReplies : []).map(function (q, i) {
              if (typeof q === 'string') return { key: 'qr-' + i, text: q, content: q };
              const title = format.textOr(q.title || q.text || q.content, '');
              const body = format.textOr(q.content || q.title || q.text, title);
              return { key: q.id || 'qr-' + i, text: title, content: body };
            }),
            welcome: format.textOr(d.welcome),
            conversationStatus: format.textOr(conversation.status),
            closed: conversation.status === 'closed',
            lastAt: this.pickLastAt(messages),
          },
          () => {
            this.scrollToBottom();
            if (!this.data.closed) this.startPolling();
          }
        );
      })
      .catch((err) => {
        this.setData({ loading: false, error: (err && err.message) || '客服会话加载失败' });
      });
  },

  pickLastAt(messages) {
    if (!messages || messages.length === 0) return '';
    const last = messages[messages.length - 1];
    return format.textOr(last.createdAt);
  },

  startPolling() {
    if (this.timer) return;
    const self = this;
    this.timer = setInterval(function () {
      self.poll();
    }, POLL_INTERVAL);
  },

  stopPolling() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  poll() {
    if (this.data.closed || this.data.sending) return;
    const query = {};
    if (this.data.lastAt) query.after = this.data.lastAt;
    request
      .get('/api/service/messages', query, { silent: true })
      .then((data) => {
        const d = data || {};
        const list = Array.isArray(d.messages) ? d.messages : [];
        const conversation = d.conversation || null;
        if (list.length > 0) {
          const merged = this.data.messages.concat(list.map(view.toServiceMessage));
          this.setData(
            {
              messages: merged,
              lastAt: this.pickLastAt(merged),
              conversationStatus: conversation ? format.textOr(conversation.status) : this.data.conversationStatus,
              closed: conversation ? conversation.status === 'closed' : this.data.closed,
            },
            () => {
              this.scrollToBottom();
            }
          );
        } else if (conversation) {
          this.setData({
            conversationStatus: format.textOr(conversation.status),
            closed: conversation.status === 'closed',
          });
        }
      })
      .catch(function () {
        /* 轮询失败静默，下轮重试 */
      });
  },

  scrollToBottom() {
    const list = this.data.messages;
    if (list.length === 0) return;
    this.setData({ scrollTo: 'msg-' + (list.length - 1) });
  },

  onInput(e) {
    this.setData({ input: e.detail.value });
  },

  onPickQuick(e) {
    const text = e.currentTarget.dataset.text || '';
    const content = e.currentTarget.dataset.content || text;
    if (!content) return;
    this.send(content);
  },

  onSend() {
    const text = String(this.data.input || '').trim();
    if (!text) {
      request.toast('请输入内容');
      return;
    }
    if (this.data.closed) {
      request.toast('会话已结束，请重新进入客服');
      return;
    }
    this.send(text);
  },

  send(text) {
    if (this.data.sending) return;
    const self = this;
    const optimistic = {
      key: 'local-' + Date.now(),
      content: text,
      mine: true,
      senderText: '我',
      timeText: format.clockText(new Date()),
      createdAt: '',
    };
    this.setData(
      {
        sending: true,
        input: '',
        messages: this.data.messages.concat([optimistic]),
      },
      () => {
        this.scrollToBottom();
      }
    );

    request
      .post('/api/service/messages', { content: text, msgType: 'text' })
      .then((data) => {
        const d = data || {};
        const list = this.data.messages.slice();
        const idx = list.findIndex(function (m) {
          return m.key === optimistic.key;
        });
        const real = d.message ? view.toServiceMessage(d.message) : null;
        if (real && idx >= 0) list[idx] = real;
        if (d.autoReply) list.push(view.toServiceMessage(d.autoReply));
        self.setData(
          {
            sending: false,
            messages: list,
            lastAt: self.pickLastAt(list) || self.data.lastAt,
          },
          () => {
            self.scrollToBottom();
          }
        );
      })
      .catch(function () {
        const list = self.data.messages.filter(function (m) {
          return m.key !== optimistic.key;
        });
        self.setData({ sending: false, messages: list, input: text });
      });
  },

  onCloseConversation() {
    const self = this;
    wx.showModal({
      title: '结束会话',
      content: '结束后客服将不再回复，重新进入会开启新会话。确定结束吗？',
      success(res) {
        if (!res.confirm) return;
        request
          .post('/api/service/conversation/close', {})
          .then(function (data) {
            const d = data || {};
            const conversation = d.conversation || {};
            self.setData({
              closed: true,
              conversationStatus: format.textOr(conversation.status, 'closed'),
            });
            request.toast('会话已结束');
          })
          .catch(function (err) {
            if (err && err.code === 'INVALID_STATE') {
              self.setData({ closed: true });
            }
          });
      },
    });
  },

  goOrders() {
    nav.go('/pages/orders/orders');
  },
});
