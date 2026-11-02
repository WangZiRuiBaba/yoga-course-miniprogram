'use strict';
/** 分销中心：收益概览 / 邀请 / 团队 / 佣金 / 提现 / 开通与绑定 */
const request = require('../../utils/request.js');
const format = require('../../utils/format.js');
const nav = require('../../utils/nav.js');
const invite = require('../../utils/invite.js');

const TABS = [
  { key: 'team', label: '我的团队' },
  { key: 'commission', label: '佣金明细' },
  { key: 'withdraw', label: '提现记录' },
];

const TEAM_LEVELS = [
  { key: 1, label: '一级直推' },
  { key: 2, label: '二级团队' },
];

const COMMISSION_STATUS = [
  { key: '', label: '全部' },
  { key: 'pending', label: '冻结中' },
  { key: 'available', label: '可提现' },
  { key: 'reversed', label: '已退回' },
];

/** 元字符串 → 分（不用浮点） */
function yuanToCents(input) {
  const text = String(input || '').trim();
  if (!text) return 0;
  if (!/^\d+(\.\d{0,2})?$/.test(text)) return -1;
  const parts = text.split('.');
  const yuan = parseInt(parts[0] || '0', 10);
  let fen = 0;
  if (parts.length > 1) fen = parseInt((parts[1] + '00').slice(0, 2), 10);
  return yuan * 100 + fen;
}

function toTeamRow(raw, i) {
  const r = raw || {};
  return {
    key: r.id || r.userId || 'team-' + i,
    nickname: format.textOr(r.nickname || r.name, '瑜伽伙伴'),
    avatar: format.textOr(r.avatar),
    initial: format.textOr(r.nickname || r.name, '瑜').charAt(0),
    levelText: r.levelText || (r.level === 2 ? '二级' : '一级'),
    joinedText: format.timeText(r.joinedAt || r.createdAt || r.boundAt),
    ordersText: r.orderCount !== undefined ? r.orderCount + ' 单' : '',
    contributionText: r.contributionText ? '¥' + r.contributionText : '',
  };
}

function toCommissionRow(raw, i) {
  const r = raw || {};
  const status = format.textOr(r.status, 'pending');
  return {
    key: r.id || 'cm-' + i,
    amountText: format.moneyText(r.amountText, r.amountCents),
    statusText: format.textOr(r.statusText, format.commissionStatusText(status)),
    levelText: format.textOr(r.levelText, r.level === 2 ? '二级佣金' : r.level === 1 ? '一级佣金' : '佣金'),
    timeText: format.timeText(r.availableAt || r.createdAt || r.settledAt),
    orderNo: format.textOr(r.orderNo),
    fromText: format.textOr(r.buyerNickname || r.fromNickname || r.nickname),
    rateText: format.textOr(r.rateText),
  };
}

function toWithdrawRow(raw, i) {
  const r = raw || {};
  return {
    key: r.id || r.withdrawNo || 'wd-' + i,
    withdrawNo: format.textOr(r.withdrawNo || r.id),
    amountText: format.moneyText(r.amountText, r.amountCents),
    statusText: format.withdrawStatusText(format.textOr(r.status, 'pending')),
    timeText: format.timeText(r.createdAt || r.requestedAt),
    note: format.textOr(r.remark || r.reason || r.message),
  };
}

Page({
  data: {
    loading: true,
    error: '',
    tab: 'team',
    tabs: TABS,
    overview: null,
    inviteInfo: null,
    inviteCode: '',
    isDistributor: false,
    levelText: '',
    teamSize: 0,
    teamSizeL2: 0,
    availableText: '0.00',
    pendingText: '0.00',
    settledText: '0.00',
    totalText: '0.00',
    minWithdrawText: '10.00',
    availableCents: 0,
    todayCommissionText: '0.00',
    todayOrders: 0,
    recent: [],
    team: [],
    teamLoading: false,
    teamLevel: 1,
    teamLevels: TEAM_LEVELS,
    commissions: [],
    commissionLoading: false,
    commissionStatus: '',
    commissionStatuses: COMMISSION_STATUS,
    withdrawals: [],
    withdrawLoading: false,
    binding: false,
    bindCode: '',
    acting: false,
    tips: [],
  },

  onLoad(options) {
    invite.consume(options);
    this.setData({ tab: (options && options.tab) || 'team' });
    this.loadOverview();
  },

  onPullDownRefresh() {
    this.loadOverview().then(
      () => {
        this.loadTabData();
        wx.stopPullDownRefresh();
      },
      () => {
        wx.stopPullDownRefresh();
      }
    );
  },

  loadOverview() {
    this.setData({ loading: true, error: '' });
    return request
      .get('/api/dist/overview')
      .then((data) => {
        const d = data || {};
        const balance = d.balance || {};
        const today = d.today || {};
        const recent = (Array.isArray(d.recent) ? d.recent : []).map(function (r, i) {
          const row = r || {};
          return {
            key: 'rc-' + i,
            levelText: row.level === 2 ? '二级' : '一级',
            amountText: format.moneyText(row.amountText, row.amountCents),
            statusText: format.commissionStatusText(format.textOr(row.status, 'pending')),
            timeText: format.timeText(row.availableAt || row.createdAt),
          };
        });
        this.setData({
          loading: false,
          overview: d,
          isDistributor: !!d.isDistributor,
          inviteCode: format.textOr(d.inviteCode),
          levelText: format.textOr(d.levelText, d.level ? String(d.level) + ' 级' : ''),
          teamSize: d.teamSize || 0,
          teamSizeL2: d.teamSizeL2 || 0,
          availableText: format.moneyText(balance.availableText, balance.availableCents),
          availableCents: typeof balance.availableCents === 'number' ? balance.availableCents : 0,
          pendingText: format.moneyText(balance.pendingText, balance.pendingCents, '0.00'),
          settledText: format.moneyText(balance.settledText, balance.settledCents, '0.00'),
          totalText: format.moneyText(balance.totalText, balance.totalCents, '0.00'),
          minWithdrawText: format.moneyText(balance.minWithdrawText, null, '10.00'),
          todayCommissionText: format.moneyText(today.commissionText, today.commissionCents, '0.00'),
          todayOrders: today.orders || 0,
          recent: recent,
        });
        this.loadInvite();
        this.loadTabData();
      })
      .catch((err) => {
        this.setData({ loading: false, error: (err && err.message) || '分销数据加载失败' });
      });
  },

  loadInvite() {
    if (!this.data.isDistributor) return;
    request
      .get('/api/dist/invite', null, { silent: true })
      .then((data) => {
        const d = data || {};
        const list = Array.isArray(d.tips) ? d.tips : d.tips ? [d.tips] : [];
        this.setData({
          inviteInfo: d,
          inviteCode: format.textOr(d.inviteCode, this.data.inviteCode),
          tips: list.map(function (t, i) {
            return { key: 'tip-' + i, text: format.textOr(t) };
          }),
          minWithdrawText: format.moneyText(
            (d.rules && d.rules.minWithdrawText) || this.data.minWithdrawText,
            null,
            this.data.minWithdrawText
          ),
        });
      })
      .catch(function () {
        /* 邀请信息失败不阻塞 */
      });
  },

  loadTabData() {
    if (!this.data.isDistributor) return;
    if (this.data.tab === 'team') this.loadTeam();
    else if (this.data.tab === 'commission') this.loadCommissions();
    else if (this.data.tab === 'withdraw') this.loadWithdrawals();
  },

  loadTeam() {
    this.setData({ teamLoading: true });
    return request
      .get('/api/dist/team', { level: this.data.teamLevel, page: 1, size: 50 }, { silent: true })
      .then((data) => {
        const rows = Array.isArray(data) ? data : (data && data.list) || [];
        this.setData({ teamLoading: false, team: rows.map(toTeamRow) });
      })
      .catch(() => {
        this.setData({ teamLoading: false, team: [] });
      });
  },

  loadCommissions() {
    this.setData({ commissionLoading: true });
    const query = { page: 1, size: 50 };
    if (this.data.commissionStatus) query.status = this.data.commissionStatus;
    return request
      .get('/api/dist/commissions', query, { silent: true })
      .then((data) => {
        const rows = Array.isArray(data) ? data : (data && data.list) || [];
        this.setData({ commissionLoading: false, commissions: rows.map(toCommissionRow) });
      })
      .catch(() => {
        this.setData({ commissionLoading: false, commissions: [] });
      });
  },

  loadWithdrawals() {
    this.setData({ withdrawLoading: true });
    return request
      .get('/api/dist/withdrawals', { page: 1, size: 50 }, { silent: true })
      .then((data) => {
        const rows = Array.isArray(data) ? data : (data && data.list) || [];
        this.setData({ withdrawLoading: false, withdrawals: rows.map(toWithdrawRow) });
      })
      .catch(() => {
        this.setData({ withdrawLoading: false, withdrawals: [] });
      });
  },

  onRetry() {
    this.loadOverview();
  },

  onTapTab(e) {
    const key = e.currentTarget.dataset.key || 'team';
    if (key === this.data.tab) return;
    this.setData({ tab: key }, () => {
      this.loadTabData();
    });
  },

  onTapTeamLevel(e) {
    const level = Number(e.currentTarget.dataset.level) || 1;
    if (level === this.data.teamLevel) return;
    this.setData({ teamLevel: level }, () => {
      this.loadTeam();
    });
  },

  onTapCommissionStatus(e) {
    const key = e.currentTarget.dataset.key === undefined ? '' : e.currentTarget.dataset.key;
    if (key === this.data.commissionStatus) return;
    this.setData({ commissionStatus: key }, () => {
      this.loadCommissions();
    });
  },

  /** 开通分销 */
  onEnable() {
    if (this.data.acting) return;
    this.setData({ acting: true });
    request
      .post('/api/dist/enable', {})
      .then(() => {
        this.setData({ acting: false });
        request.toast('分销已开通');
        this.loadOverview();
      })
      .catch((err) => {
        this.setData({ acting: false });
        if (err && err.code === 'INVALID_STATE') request.toast('你已经是分销员了');
      });
  },

  onBindInput(e) {
    this.setData({ bindCode: e.detail.value });
  },

  /** 绑定上级邀请码 */
  onBind() {
    const code = String(this.data.bindCode || '').trim();
    if (!code) {
      request.toast('请输入邀请码');
      return;
    }
    if (this.data.acting) return;
    this.setData({ acting: true });
    request
      .post('/api/dist/bind', { inviteCode: code })
      .then(() => {
        this.setData({ acting: false, bindCode: '' });
        request.toast('绑定成功');
        this.loadOverview();
      })
      .catch((err) => {
        this.setData({ acting: false });
        const c = err && err.code;
        if (c === 'DUPLICATE') request.toast('已经绑定过上级了');
        else if (c === 'VALIDATION_ERROR') request.toast('邀请码无效');
      });
  },

  /** 提现 */
  onWithdraw() {
    const self = this;
    wx.showModal({
      title: '申请提现',
      editable: true,
      placeholderText: '最低 ¥' + this.data.minWithdrawText,
      content: '',
      success(res) {
        if (!res.confirm) return;
        const cents = yuanToCents(res.content);
        if (cents <= 0) {
          request.toast('请输入正确的提现金额');
          return;
        }
        if (cents > self.data.availableCents) {
          request.toast('可提现余额不足');
          return;
        }
        request
          .post('/api/dist/withdrawals', { amountCents: cents })
          .then(function () {
            request.toast('提现申请已提交');
            self.loadOverview();
          })
          .catch(function (err) {
            if (err && err.code === 'INSUFFICIENT_BALANCE') request.toast('可提现余额不足');
            else if (err && err.code === 'VALIDATION_ERROR') request.toast('提现金额不符合规则');
          });
      },
    });
  },

  copyInvite() {
    const code = this.data.inviteCode;
    if (!code) {
      request.toast('邀请码还没生成');
      return;
    }
    wx.setClipboardData({
      data: code,
      success() {
        request.toast('邀请码已复制：' + code);
      },
    });
  },

  goService() {
    nav.go('/pages/service/service');
  },

  goOrders() {
    nav.go('/pages/orders/orders');
  },

  onShareAppMessage() {
    const code = this.data.inviteCode;
    const path = code
      ? '/pages/index/index' + request.pageQuery({ inviteCode: code })
      : '/pages/index/index';
    return {
      title: '跟我一起练瑜伽，好课一起上',
      path: path,
    };
  },
});
