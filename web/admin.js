/* =========================================================
 * 悦己瑜伽 · 运营后台（纯静态 ES module，零依赖）
 * - 路由：#/login #/dashboard #/products #/orders #/refunds
 *         #/withdrawals #/dist #/service #/users #/settings #/audit
 * - 鉴权：x-admin-token（localStorage: yoga_admin_token）
 * - 金额：优先后端 xxxText，缺字段才用「分」做字符串兜底
 * ========================================================= */

const TOKEN_KEY = 'yoga_admin_token';

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */
function $(sel, root) {
  return (root || document).querySelector(sel);
}

function esc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function centsText(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return null;
  const int = Math.trunc(n);
  const abs = String(Math.abs(int)).padStart(3, '0');
  return `${int < 0 ? '-' : ''}${abs.slice(0, -2)}.${abs.slice(-2)}`;
}

function pick(obj, ...names) {
  if (!obj) return undefined;
  for (const name of names) {
    if (obj[name] !== undefined && obj[name] !== null && obj[name] !== '') return obj[name];
  }
  return undefined;
}

/** 金额文本：xxxText / xxx_text > xxxCents / xxx_cents */
function moneyText(obj, key) {
  if (!obj) return '—';
  const direct = pick(obj, `${key}Text`, `${key}_text`);
  if (direct !== undefined) return String(direct);
  const fallback = centsText(pick(obj, `${key}Cents`, `${key}_cents`));
  return fallback === null ? '—' : fallback;
}

/** 统一货币展示：字段自带 ¥/￥ 时原样返回，避免「¥¥」 */
function withYuan(text) {
  if (text === undefined || text === null) return '—';
  const value = String(text).trim();
  if (!value || value === '—') return '—';
  return /^[¥￥]/.test(value) ? value : `¥${value}`;
}

function yuan(obj, key) {
  return withYuan(moneyText(obj, key));
}

function yuanToCents(text) {
  const raw = String(text === undefined || text === null ? '' : text).trim().replace(/[^\d.]/g, '');
  if (!raw) return null;
  const parts = raw.split('.');
  const intPart = parts[0] ? Number(parts[0]) : 0;
  const decPart = (parts[1] || '').padEnd(2, '0').slice(0, 2);
  const cents = intPart * 100 + Number(decPart || '0');
  return Number.isFinite(cents) ? cents : null;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function dateText(value, withTime) {
  if (!value) return '—';
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) return String(value).slice(0, 19).replace('T', ' ');
  const base = `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;
  return withTime === false ? base : `${base} ${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
}

function shortDate(value) {
  if (!value) return '—';
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) return String(value).slice(5, 10);
  return `${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;
}

function toList(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.list)) return data.list;
  return [];
}

function typeText(type) {
  return { online: '线上', offline: '到店', membership: '会员卡' }[type] || type || '—';
}

function statusTag(status, map) {
  const text = (map && map[status]) || status || '—';
  let cls = 'tag';
  if (['paid', 'completed', 'succeeded', 'approved', 'available', 'paid_out'].includes(status)) cls += ' tag--ok';
  else if (['pending', 'processing', 'refunding', 'wait_review'].includes(status)) cls += ' tag--warn';
  else if (['rejected', 'failed', 'cancelled', 'refunded', 'partial_refunded', 'off', 'revoked'].includes(status)) cls += ' tag--danger';
  else cls += ' tag--info';
  return `<span class="${cls}">${esc(text)}</span>`;
}

const ORDER_STATUS = {
  pending: '待支付',
  paid: '已支付',
  completed: '已完成',
  cancelled: '已取消',
  refunding: '退款中',
  refunded: '已退款',
  partial_refunded: '部分退款',
};
const REFUND_STATUS = {
  pending: '待审核',
  approved: '已通过',
  processing: '出款中',
  succeeded: '退款成功',
  rejected: '已驳回',
  failed: '出款失败',
};
const WITHDRAW_STATUS = {
  pending: '待审核',
  approved: '待打款',
  paid: '已打款',
  rejected: '已驳回',
};

/* ------------------------------------------------------------------ *
 * Toast / Modal
 * ------------------------------------------------------------------ */
function toast(message, type) {
  const wrap = $('#toast-wrap');
  if (!wrap || !message) return;
  const node = document.createElement('div');
  node.className = `toast${type ? ` toast--${type}` : ''}`;
  node.textContent = String(message);
  wrap.appendChild(node);
  setTimeout(() => {
    node.classList.add('is-out');
    setTimeout(() => node.remove(), 220);
  }, type === 'error' ? 3200 : 2200);
}

function openModal(title, html) {
  const root = $('#modal-root');
  if (!root) return null;
  root.innerHTML = `
    <div class="modal-mask" data-mask="1">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal__head">
          <div class="modal__title">${esc(title)}</div>
          <button class="modal__close" type="button" data-close="1" aria-label="关闭">✕</button>
        </div>
        <div class="modal__body">${html || ''}</div>
      </div>
    </div>`;
  const mask = $('[data-mask]', root);
  mask.addEventListener('click', (event) => {
    if (event.target === mask) closeModal();
  });
  $('[data-close]', root).addEventListener('click', closeModal);
  const first = $('.modal__body input, .modal__body textarea, .modal__body select', root);
  if (first) setTimeout(() => first.focus(), 30);
  return $('.modal__body', root);
}

function closeModal() {
  const root = $('#modal-root');
  if (root) root.innerHTML = '';
}

/* ------------------------------------------------------------------ *
 * 计时器 / 清理
 * ------------------------------------------------------------------ */
const state = { admin: null, timers: [], cleanups: [] };

function addTimer(fn, ms) {
  const id = setInterval(fn, ms);
  state.timers.push(id);
  return id;
}

function addCleanup(fn) {
  state.cleanups.push(fn);
}

function clearTimers() {
  state.timers.forEach((id) => clearInterval(id));
  state.timers = [];
  state.cleanups.forEach((fn) => {
    try {
      fn();
    } catch {
      /* 清理失败不影响导航 */
    }
  });
  state.cleanups = [];
}

/* ------------------------------------------------------------------ *
 * 请求封装
 * ------------------------------------------------------------------ */
class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || '请求失败');
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function api(method, path, body) {
  const headers = { Accept: 'application/json' };
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) headers['x-admin-token'] = token;
  let payload;
  if (body !== undefined && body !== null) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, { method, headers, body: payload });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', '网络连接失败，请确认后端服务已启动');
  }
  const text = await res.text();
  let raw = null;
  if (text) {
    try {
      raw = JSON.parse(text);
    } catch {
      raw = null;
    }
  }
  if (res.ok && raw && raw.ok === true) return raw.data;
  const code = (raw && raw.code) || `HTTP_${res.status}`;
  let message = (raw && raw.message) || '';
  if (!message) {
    if (res.status === 404) message = '接口尚未就绪（404）';
    else message = `请求失败（HTTP ${res.status}）`;
  }
  if (res.status === 401 || code === 'UNAUTHORIZED') {
    localStorage.removeItem(TOKEN_KEY);
    state.admin = null;
    if (!String(path).includes('/api/admin/login')) {
      toast('登录已过期，请重新登录', 'error');
      if (currentRoute() !== 'login') go('/login');
    }
  }
  throw new ApiError(res.status, code, message, raw && raw.details);
}

async function withBusy(btn, fn) {
  if (btn && btn.disabled) return { ok: false, error: new ApiError(0, 'BUSY', '请稍候') };
  if (btn) btn.disabled = true;
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    toast((err && err.message) || '操作失败', 'error');
    return { ok: false, error: err };
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */
function go(path) {
  const clean = String(path || '/dashboard');
  const target = clean.startsWith('#') ? clean : `#${clean.startsWith('/') ? '' : '/'}${clean}`;
  if (location.hash === target) render();
  else location.hash = target;
}

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/dashboard';
  const [path, search] = raw.split('?');
  const seg = path.split('/').filter(Boolean);
  return { path, seg, query: new URLSearchParams(search || '') };
}

function currentRoute() {
  const { seg } = parseHash();
  return seg.length ? seg[0] : 'dashboard';
}

const ROUTES = {
  login: { title: '登录', view: viewLogin, public: true, bare: true },
  dashboard: { title: '经营看板', view: viewDashboard },
  products: { title: '商品管理', view: viewProducts },
  orders: { title: '订单管理', view: viewOrders },
  refunds: { title: '退款审核', view: viewRefunds },
  withdrawals: { title: '提现审核', view: viewWithdrawals },
  dist: { title: '分销管理', view: viewDist },
  service: { title: '客服会话', view: viewService },
  users: { title: '用户查询', view: viewUsers },
  settings: { title: '业务参数', view: viewSettings },
  audit: { title: '审计日志', view: viewAudit },
};

function markNav(key) {
  document.querySelectorAll('[data-nav]').forEach((node) => {
    node.classList.toggle('is-active', node.dataset.nav === key);
  });
}

function paintChrome(route, key) {
  const title = $('#top-title');
  if (title) title.textContent = route.title || '后台';
  markNav(key);
  const badge = $('#top-admin');
  if (badge) badge.textContent = state.admin ? `${state.admin.username} · 管理员` : '未登录';
  const side = $('#side');
  if (side) side.classList.remove('is-open');
}

async function render() {
  clearTimers();
  closeModal();
  const { seg, query } = parseHash();
  const key = seg.length ? seg[0] : 'dashboard';
  const route = ROUTES[key];
  const app = $('.shell');

  if (!route) {
    paintChrome({ title: '页面不存在' }, '');
    $('#view').innerHTML = `
      <div class="empty">
        <div class="empty__ico">🧭</div>
        <div class="empty__title">页面不存在</div>
        <div class="empty__desc">请从左侧菜单进入功能页</div>
        <a class="btn btn--ghost btn--sm" href="#/dashboard">回到看板</a>
      </div>`;
    return;
  }

  const authorised = route.public || !!localStorage.getItem(TOKEN_KEY);
  if (!route.public && !authorised) {
    go('/login');
    return;
  }

  if (route.bare && app) app.classList.add('is-bare');

  paintChrome(route, key);

  const previous = $('#view');
  const host = previous.cloneNode(false);
  previous.replaceWith(host);
  host.innerHTML = '<div class="inline-loading"><span class="spin"></span>加载中…</div>';

  try {
    await route.view({ host, seg, query });
  } catch (err) {
    host.innerHTML = errorBox(err);
  }
}

function errorBox(err, hint) {
  const status = err && err.status;
  const code = (err && err.code) || (status ? `HTTP_${status}` : 'ERROR');
  return `
    <div class="error-box">
      <div class="error-box__ico">🥲</div>
      <div class="error-box__msg">${esc((err && err.message) || '加载失败')}</div>
      <div class="error-box__code">${esc(code)}</div>
      <div class="error-box__hint">${esc(hint || '接口就绪后会自动恢复')}</div>
      <button class="btn btn--ghost btn--sm" type="button" data-retry="1">重新加载</button>
    </div>`;
}

function emptyBox(icon, title, desc, extra) {
  return `
    <div class="empty">
      <div class="empty__ico">${esc(icon || '📭')}</div>
      <div class="empty__title">${esc(title || '暂无数据')}</div>
      <div class="empty__desc">${esc(desc || '')}</div>
      ${extra || ''}
    </div>`;
}

function bindRetry(root) {
  const scope = root || document;
  scope.querySelectorAll('[data-retry]').forEach((btn) => btn.addEventListener('click', () => render()));
}

function tableHtml(cols, rows, emptyHtml) {
  if (!rows.length) return emptyHtml || emptyBox('📭', '暂无数据', '调整筛选条件后再试');
  const head = cols
    .map((c) => `<th${c.width ? ` style="width:${c.width}"` : ''}${c.right ? ' class="right"' : ''}>${esc(c.label)}</th>`)
    .join('');
  const body = rows
    .map(
      (row) =>
        `<tr>${cols
          .map((c) => `<td${c.right ? ' class="right"' : ''}>${c.render ? c.render(row) : esc(pick(row, c.k))}</td>`)
          .join('')}</tr>`
    )
    .join('');
  return `<div class="table-wrap"><table class="table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function pagerHtml(page, total, size) {
  const pages = size > 0 ? Math.max(1, Math.ceil(total / size)) : 1;
  return `
    <div class="pager">
      <span>第 ${page} / ${pages} 页 · 共 ${total} 条</span>
      <button class="btn btn--ghost btn--sm" type="button" data-page="${Math.max(1, page - 1)}" ${page <= 1 ? 'disabled' : ''}>上一页</button>
      <button class="btn btn--ghost btn--sm" type="button" data-page="${Math.min(pages, page + 1)}" ${page >= pages ? 'disabled' : ''}>下一页</button>
    </div>`;
}

function bindPager(scope, onGo) {
  scope.querySelectorAll('[data-page]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      onGo(Number(btn.dataset.page) || 1);
    });
  });
}

/* ------------------------------------------------------------------ *
 * 视图 · 登录
 * ------------------------------------------------------------------ */
async function viewLogin({ host }) {
  const app = $('.shell');
  if (app) app.classList.add('is-bare');
  document.body.classList.add('is-login');

  host.innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <div class="login-card__logo">🧘</div>
        <div class="login-card__title">瑜伽卖课 · 运营后台</div>
        <div class="login-card__sub">本地演示环境，使用后台账号登录</div>
        <form id="login-form">
          <label class="field">
            <span class="field__label">账号</span>
            <input class="input" id="username" name="username" autocomplete="username" placeholder="admin" value="admin" />
          </label>
          <label class="field">
            <span class="field__label">密码</span>
            <input class="input" id="password" name="password" type="password" autocomplete="current-password" placeholder="admin123" value="admin123" />
          </label>
          <button class="btn btn--block" type="submit" id="login-submit">登录后台</button>
        </form>
        <div class="login-tip">默认账号 <b>admin</b> / 密码 <b>admin123</b>（来自 server/seed.js）</div>
        <div class="center mt12"><a class="small muted" href="/" target="_blank" rel="noopener">打开 H5 商城 ↗</a></div>
      </div>
    </div>`;

  const form = $('#login-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const btn = $('#login-submit');
    const username = $('#username').value.trim();
    const password = $('#password').value;
    if (!username || !password) {
      toast('请输入账号和密码');
      return;
    }
    const result = await withBusy(btn, () => api('POST', '/api/admin/login', { username, password }));
    if (!result.ok) return;
    const data = result.value || {};
    if (data.token) localStorage.setItem(TOKEN_KEY, data.token);
    state.admin = data.admin || null;
    toast('登录成功', 'ok');
    go('/dashboard');
  });
}

/* ------------------------------------------------------------------ *
 * 视图 · 看板
 * ------------------------------------------------------------------ */
async function viewDashboard({ host }) {
  const result = await withBusy(null, () => api('GET', '/api/admin/stats'));
  if (!result.ok) {
    host.innerHTML = errorBox(result.error, '/api/admin/stats 尚未就绪');
    bindRetry(host);
    return;
  }
  const stats = result.value || {};
  const orders = stats.orders || {};
  const today = stats.today || {};
  const pending = stats.pending || {};
  const commission = stats.commission || {};
  const users = stats.users || {};
  const series = fillSeries(Array.isArray(stats.series) ? stats.series : [], 14);
  const todayGmvText = centsText(today.gmvCents) || '0.00';
  const paidToday = Number(today.paidOrders || 0);
  const refundRate = orders.refundRate === undefined ? '—' : `${orders.refundRate}%`;

  host.innerHTML = `
    <div class="stat-grid">
      <div class="stat">
        <div class="stat__label">累计成交额（GMV）</div>
        <div class="stat__num stat__num--primary">${esc(withYuan(orders.gmvText || '0.00'))}</div>
        <div class="stat__foot">已支付订单 ${esc(orders.paid || 0)} 笔 / 共 ${esc(orders.total || 0)} 笔</div>
      </div>
      <div class="stat">
        <div class="stat__label">净收入（扣除退款）</div>
        <div class="stat__num stat__num--ok">${esc(withYuan(orders.netText || '0.00'))}</div>
        <div class="stat__foot">已退 ${esc(withYuan(orders.refundedText || '0.00'))} · 退款率 ${esc(refundRate)}</div>
      </div>
      <div class="stat">
        <div class="stat__label">今日成交</div>
        <div class="stat__num">${esc(withYuan(todayGmvText))}</div>
        <div class="stat__foot">${paidToday} 笔支付</div>
      </div>
      <div class="stat">
        <div class="stat__label">用户 / 分销员</div>
        <div class="stat__num">${esc(users.total || 0)}<span class="small muted"> / ${esc(users.distributors || 0)}</span></div>
        <div class="stat__foot">分销员占比由后台参数控制</div>
      </div>
    </div>

    <div class="card mt16">
      <div class="card__head">
        <div>
          <div class="card__title">近 14 天成交趋势</div>
          <div class="card__sub">柱形为每日成交额（元），折线为每日支付订单数</div>
        </div>
        <div class="legend">
          <span><span class="legend__dot" style="background:linear-gradient(180deg,#8b7cf6,#6c5ce7)"></span>成交额</span>
          <span><span class="legend__dot" style="background:#ff7a59"></span>支付单数</span>
        </div>
      </div>
      <div class="chart-wrap"><canvas id="trend-canvas" aria-label="近 14 天成交趋势图"></canvas></div>
    </div>

    <div class="stat-grid mt16">
      <div class="stat">
        <div class="stat__label">待处理</div>
        <div class="stat__num stat__num--accent">${esc(
          Number(pending.refunds || 0) + Number(pending.withdrawals || 0) + Number(pending.conversations || 0)
        )}</div>
        <div class="stat__foot">退款 ${esc(pending.refunds || 0)} · 提现 ${esc(pending.withdrawals || 0)} · 会话 ${esc(pending.conversations || 0)}</div>
        <div class="row mt8">
          <a class="btn btn--ghost btn--xs" href="#/refunds">审核退款</a>
          <a class="btn btn--ghost btn--xs" href="#/withdrawals">审核提现</a>
          <a class="btn btn--ghost btn--xs" href="#/service">客服会话</a>
        </div>
      </div>
      <div class="stat">
        <div class="stat__label">佣金池</div>
        <div class="stat__num">${esc(withYuan(centsText(commission.availableCents) || '0.00'))}</div>
        <div class="stat__foot">待结算 ${esc(withYuan(centsText(commission.pendingCents) || '0.00'))} · 已冲正 ${esc(
          withYuan(centsText(commission.reversedCents) || '0.00')
        )} · ${esc(commission.totalCount || 0)} 条</div>
      </div>
      <div class="stat">
        <div class="stat__label">订单状态分布</div>
        <div class="small mt8">
          ${Object.entries(orders.byStatus || {})
            .map(([k, v]) => `<div class="row row--between"><span class="muted">${esc(ORDER_STATUS[k] || k)}</span><span class="strong">${esc(v)}</span></div>`)
            .join('') || '<span class="muted">暂无订单</span>'}
        </div>
      </div>
      <div class="stat">
        <div class="stat__label">快捷入口</div>
        <div class="row mt8" style="flex-wrap:wrap">
          <a class="btn btn--ghost btn--xs" href="#/products">商品</a>
          <a class="btn btn--ghost btn--xs" href="#/orders">订单</a>
          <a class="btn btn--ghost btn--xs" href="#/dist">分销</a>
          <a class="btn btn--ghost btn--xs" href="#/settings">参数</a>
          <a class="btn btn--ghost btn--xs" href="#/audit">日志</a>
        </div>
        <div class="stat__foot mt8">数据来自 /api/admin/stats</div>
      </div>
    </div>`;

  const canvas = $('#trend-canvas');
  if (canvas) mountChart(canvas, series);
}

function dayKey(date) {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseDayKey(key) {
  const parts = String(key || '').split('-').map((x) => Number(x));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return null;
  const date = new Date(parts[0], parts[1] - 1, parts[2]);
  date.setHours(0, 0, 0, 0);
  return date;
}

// 把后端 series 补齐成连续 days 天（缺失日期补 0），保证趋势图始终有完整时间轴
function fillSeries(raw, days) {
  const size = Math.max(1, Number(days) || 14);
  const byKey = new Map();
  raw.forEach((row) => {
    if (!row || !row.date) return;
    const key = String(row.date).slice(0, 10);
    const prev = byKey.get(key) || { orders: 0, paidCents: 0 };
    byKey.set(key, {
      orders: prev.orders + (Number(row.orders) || 0),
      paidCents: prev.paidCents + (Number(row.paidCents) || 0),
    });
  });

  let end = new Date();
  end.setHours(0, 0, 0, 0);
  byKey.forEach((_value, key) => {
    const date = parseDayKey(key);
    if (date && date > end) end = date;
  });

  const out = [];
  const cursor = new Date(end.getTime());
  cursor.setDate(cursor.getDate() - (size - 1));
  for (let i = 0; i < size; i += 1) {
    const key = dayKey(cursor);
    const hit = byKey.get(key) || { orders: 0, paidCents: 0 };
    out.push({ date: key, orders: hit.orders, paidCents: hit.paidCents });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

function mountChart(canvas, series) {
  let hover = -1;

  function paint() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(Math.round(rect.width) || 640, 320);
    const h = Math.max(Math.round(rect.height) || 240, 200);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const font = '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    if (!series.length) {
      ctx.fillStyle = '#807c93';
      ctx.font = `13px ${font}`;
      ctx.textAlign = 'center';
      ctx.fillText('暂无成交数据，支付成功后这里会出现曲线', w / 2, h / 2);
      return;
    }

    const padL = 62;
    const padR = 52;
    const padT = 16;
    const padB = 28;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    let maxPaid = 0;
    let maxOrders = 0;
    series.forEach((s) => {
      maxPaid = Math.max(maxPaid, Number(s.paidCents) || 0);
      maxOrders = Math.max(maxOrders, Number(s.orders) || 0);
    });
    if (maxPaid <= 0) maxPaid = 100;
    if (maxOrders <= 0) maxOrders = 1;

    const xOf = (i) => (series.length === 1 ? padL + plotW / 2 : padL + (plotW * i) / (series.length - 1));
    const yPaid = (v) => padT + plotH - (v / maxPaid) * plotH;
    const yOrders = (v) => padT + plotH - (v / maxOrders) * plotH;

    // 网格与左右刻度
    ctx.font = `11px ${font}`;
    for (let i = 0; i <= 4; i += 1) {
      const y = padT + (plotH * i) / 4;
      ctx.strokeStyle = '#efedf7';
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();

      const paidVal = maxPaid * (1 - i / 4);
      ctx.fillStyle = '#9a95b0';
      ctx.textAlign = 'right';
      ctx.fillText(centsText(Math.round(paidVal)) || '0.00', padL - 8, y + 4);

      const orderVal = Math.round(maxOrders * (1 - i / 4));
      ctx.textAlign = 'left';
      ctx.fillText(`${orderVal} 单`, padL + plotW + 8, y + 4);
    }

    // 柱形：成交额
    const slot = plotW / Math.max(series.length, 1);
    const barW = Math.max(Math.min(slot * 0.5, 20), 4);
    series.forEach((s, i) => {
      const paid = Number(s.paidCents) || 0;
      const x = xOf(i) - barW / 2;
      const y = yPaid(paid);
      const height = Math.max(padT + plotH - y, paid > 0 ? 2 : 0);
      const active = hover === i;
      const grad = ctx.createLinearGradient(0, y, 0, padT + plotH);
      grad.addColorStop(0, active ? '#9a8cff' : '#8b7cf6');
      grad.addColorStop(1, active ? '#6c5ce7' : '#6c5ce7');
      ctx.fillStyle = grad;
      roundRect(ctx, x, padT + plotH - height, barW, height, Math.min(5, barW / 2));
      ctx.fill();
    });

    // 折线：订单数
    ctx.strokeStyle = '#ff7a59';
    ctx.lineWidth = 2;
    ctx.beginPath();
    series.forEach((s, i) => {
      const x = xOf(i);
      const y = yOrders(Number(s.orders) || 0);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    series.forEach((s, i) => {
      const x = xOf(i);
      const y = yOrders(Number(s.orders) || 0);
      ctx.beginPath();
      ctx.arc(x, y, hover === i ? 4.5 : 3, 0, Math.PI * 2);
      ctx.fillStyle = hover === i ? '#ff5a34' : '#ff7a59';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });

    // X 轴日期
    ctx.fillStyle = '#9a95b0';
    ctx.font = `11px ${font}`;
    ctx.textAlign = 'center';
    const step = series.length > 9 ? 3 : series.length > 5 ? 2 : 1;
    const last = series.length - 1;
    series.forEach((s, i) => {
      if ((last - i) % step !== 0) return;
      ctx.fillText(shortDate(s.date), xOf(i), padT + plotH + 18);
    });

    // hover 提示
    if (hover >= 0 && hover < series.length) {
      const s = series[hover];
      const x = xOf(hover);
      ctx.strokeStyle = 'rgba(108,92,231,.28)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();

      const lines = [shortDate(s.date), `成交 ${withYuan(centsText(s.paidCents) || '0.00')}`, `${Number(s.orders) || 0} 单`];
      ctx.font = `12px ${font}`;
      const boxW = Math.max(...lines.map((line) => ctx.measureText(line).width)) + 20;
      const boxH = lines.length * 17 + 12;
      let boxX = x + 12;
      if (boxX + boxW > w - 4) boxX = x - boxW - 12;
      const boxY = padT + 4;
      ctx.fillStyle = 'rgba(29,26,46,.92)';
      roundRect(ctx, boxX, boxY, boxW, boxH, 9);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      lines.forEach((line, i) => {
        ctx.fillText(line, boxX + 10, boxY + 20 + i * 17);
      });
    }
  }

  function onMove(event) {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const padL = 62;
    const padR = 52;
    const plotW = Math.max(rect.width - padL - padR, 10);
    const ratio = (x - padL) / plotW;
    const index = Math.round(ratio * (series.length - 1));
    const next = Math.max(0, Math.min(series.length - 1, index));
    if (next !== hover) {
      hover = next;
      paint();
    }
  }

  function onLeave() {
    if (hover !== -1) {
      hover = -1;
      paint();
    }
  }

  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseleave', onLeave);
  let raf = 0;
  const onResize = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(paint);
  };
  window.addEventListener('resize', onResize);
  addCleanup(() => {
    window.removeEventListener('resize', onResize);
    canvas.removeEventListener('mousemove', onMove);
    canvas.removeEventListener('mouseleave', onLeave);
    if (raf) cancelAnimationFrame(raf);
  });
  paint();
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/* ------------------------------------------------------------------ *
 * 视图 · 商品
 * ------------------------------------------------------------------ */
const PRODUCT_STATUS = { on: '已上架', off: '已下架' };

async function viewProducts({ host }) {
  host.innerHTML = `
    <div class="toolbar">
      <input class="input" id="p-keyword" placeholder="搜索课程名称 / ID" />
      <select class="select" id="p-status">
        <option value="">全部状态</option>
        <option value="on">已上架</option>
        <option value="off">已下架</option>
      </select>
      <button class="btn" type="button" id="p-search">查询</button>
      <span class="toolbar__spacer"></span>
      <button class="btn btn--ghost" type="button" id="p-refresh">刷新</button>
    </div>
    <div class="card">
      <div class="card__head">
        <div>
          <div class="card__title">商品列表</div>
          <div class="card__sub">下架后商品不再出现在 H5 商城与首页</div>
        </div>
        <span class="badge" id="p-total">—</span>
      </div>
      <div id="p-body"><div class="inline-loading"><span class="spin"></span>加载商品…</div></div>
      <div id="p-pager"></div>
    </div>`;

  const body = $('#p-body');
  const pager = $('#p-pager');
  let page = 1;

  async function load() {
    body.innerHTML = '<div class="inline-loading"><span class="spin"></span>加载商品…</div>';
    const params = new URLSearchParams({ page: String(page), size: '20' });
    const keyword = $('#p-keyword').value.trim();
    const status = $('#p-status').value;
    if (keyword) params.set('keyword', keyword);
    if (status) params.set('status', status);
    const result = await withBusy(null, () => api('GET', `/api/admin/products?${params.toString()}`));
    if (!result.ok) {
      body.innerHTML = errorBox(result.error, '/api/admin/products 尚未就绪');
      bindRetry(body);
      pager.innerHTML = '';
      return;
    }
    const list = toList(result.value);
    const total = (result.value && result.value.total) || list.length;
    $('#p-total').textContent = `${total} 个商品`;
    body.innerHTML = tableHtml(
      [
        { label: '封面', width: '64px', render: (r) => `<img class="thumb" src="${esc(pick(r, 'cover') || `/api/media/cover/${pick(r, 'id') || ''}`)}" alt="" />` },
        {
          label: '课程',
          render: (r) =>
            `<div class="strong ellipsis" style="max-width:260px">${esc(pick(r, 'title') || '未命名')}</div>
             <div class="small muted ellipsis" style="max-width:260px">${esc(pick(r, 'subtitle') || '')}</div>
             <div class="small muted mono">${esc(pick(r, 'id') || '')}</div>`,
        },
        { label: '类型', render: (r) => `<span class="tag">${esc(typeText(pick(r, 'type')))}</span>` },
        { label: '售价', right: true, render: (r) => `<span class="amount">${esc(yuan(r, 'price'))}</span>` },
        { label: '库存', right: true, render: (r) => esc(pick(r, 'stock') === undefined ? '—' : pick(r, 'stock')) },
        { label: '销量', right: true, render: (r) => esc(pick(r, 'sales', 'sold') === undefined ? 0 : pick(r, 'sales', 'sold')) },
        { label: '状态', render: (r) => statusTag(pick(r, 'status'), PRODUCT_STATUS) },
        {
          label: '操作',
          render: (r) => {
            const on = pick(r, 'status') === 'on';
            return `<div class="acts">
              <button class="btn btn--ghost btn--xs" type="button" data-detail="${esc(pick(r, 'id'))}">详情</button>
              <button class="btn ${on ? 'btn--danger-line' : 'btn--line'} btn--xs" type="button"
                data-toggle="${esc(pick(r, 'id'))}" data-status="${on ? 'off' : 'on'}">${on ? '下架' : '上架'}</button>
            </div>`;
          },
        },
      ],
      list,
      emptyBox('🛍', '没有匹配的商品', keyword || status ? '换个关键词或状态再试' : '商品数据就绪后会出现在这里')
    );
    pager.innerHTML = pagerHtml(page, total, 20);
    bindPager(pager, (next) => {
      page = next;
      load();
    });
  }

  body.addEventListener('click', async (event) => {
    const toggle = event.target.closest('[data-toggle]');
    if (toggle) {
      const id = toggle.dataset.toggle;
      const next = toggle.dataset.status;
      const result = await withBusy(toggle, () =>
        api('PATCH', `/api/admin/products/${encodeURIComponent(id)}/status`, { status: next })
      );
      if (!result.ok) return;
      toast(next === 'on' ? '已上架' : '已下架', 'ok');
      load();
      return;
    }
    const detail = event.target.closest('[data-detail]');
    if (detail) {
      const id = detail.dataset.detail;
      const box = openModal('商品详情', '<div class="inline-loading"><span class="spin"></span>加载中…</div>');
      if (!box) return;
      const info = await api('GET', `/api/products/${encodeURIComponent(id)}`).catch((err) => ({ __error: err }));
      if (info && info.__error) {
        box.innerHTML = errorBox(info.__error, '商品详情接口未就绪');
        bindRetry(box);
        return;
      }
      const product = (info && info.product) || info || {};
      const skus = Array.isArray(info && info.skus) ? info.skus : [];
      box.innerHTML = `
        <dl class="kv">
          <dt>ID</dt><dd class="mono">${esc(pick(product, 'id'))}</dd>
          <dt>标题</dt><dd>${esc(pick(product, 'title'))}</dd>
          <dt>副标题</dt><dd>${esc(pick(product, 'subtitle') || '—')}</dd>
          <dt>类型</dt><dd>${esc(typeText(pick(product, 'type')))}</dd>
          <dt>售价</dt><dd>${esc(yuan(product, 'price'))}</dd>
          <dt>原价</dt><dd>${esc(yuan(product, 'originalPrice'))}</dd>
          <dt>库存 / 销量</dt><dd>${esc(pick(product, 'stock') || 0)} / ${esc(pick(product, 'sales') || 0)}</dd>
          <dt>目标标签</dt><dd>${esc((product.goalTags || []).join(' · ') || '—')}</dd>
          <dt>状态</dt><dd>${statusTag(pick(product, 'status'), PRODUCT_STATUS)}</dd>
        </dl>
        ${
          skus.length
            ? `<div class="strong small mt16">规格（${skus.length}）</div>
               <div class="table-wrap mt8"><table class="table"><thead><tr><th>名称</th><th>价格</th><th>库存</th><th>状态</th></tr></thead><tbody>
               ${skus
                 .map(
                   (sku) =>
                     `<tr><td>${esc(pick(sku, 'name') || '—')}</td><td>${esc(yuan(sku, 'price'))}</td><td>${esc(pick(sku, 'stock') || 0)}</td><td>${statusTag(pick(sku, 'status') || 'on', PRODUCT_STATUS)}</td></tr>`
                 )
                 .join('')}
               </tbody></table></div>`
            : ''
        }`;
    }
  });

  $('#p-search').addEventListener('click', () => {
    page = 1;
    load();
  });
  $('#p-keyword').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      page = 1;
      load();
    }
  });
  $('#p-status').addEventListener('change', () => {
    page = 1;
    load();
  });
  $('#p-refresh').addEventListener('click', () => load());

  await load();
}

/* ------------------------------------------------------------------ *
 * 视图 · 订单
 * ------------------------------------------------------------------ */
async function viewOrders({ host }) {
  host.innerHTML = `
    <div class="toolbar">
      <input class="input" id="o-keyword" placeholder="订单号 / 用户昵称" />
      <select class="select" id="o-status">
        <option value="">全部状态</option>
        ${Object.entries(ORDER_STATUS)
          .map(([key, label]) => `<option value="${esc(key)}">${esc(label)}</option>`)
          .join('')}
      </select>
      <button class="btn" type="button" id="o-search">查询</button>
      <span class="toolbar__spacer"></span>
      <button class="btn btn--ghost" type="button" id="o-refresh">刷新</button>
    </div>
    <div class="card">
      <div class="card__head">
        <div>
          <div class="card__title">订单列表</div>
          <div class="card__sub">可强制关单（pending）或标记完成（paid）</div>
        </div>
        <span class="badge" id="o-total">—</span>
      </div>
      <div id="o-body"><div class="inline-loading"><span class="spin"></span>加载订单…</div></div>
      <div id="o-pager"></div>
    </div>`;

  const body = $('#o-body');
  const pager = $('#o-pager');
  let page = 1;

  async function load() {
    body.innerHTML = '<div class="inline-loading"><span class="spin"></span>加载订单…</div>';
    const params = new URLSearchParams({ page: String(page), size: '20' });
    const keyword = $('#o-keyword').value.trim();
    const status = $('#o-status').value;
    if (keyword) params.set('keyword', keyword);
    if (status) params.set('status', status);
    const result = await withBusy(null, () => api('GET', `/api/admin/orders?${params.toString()}`));
    if (!result.ok) {
      body.innerHTML = errorBox(result.error, '/api/admin/orders 尚未就绪');
      bindRetry(body);
      pager.innerHTML = '';
      return;
    }
    const list = toList(result.value);
    const total = (result.value && result.value.total) || list.length;
    $('#o-total').textContent = `${total} 笔订单`;
    body.innerHTML = tableHtml(
      [
        {
          label: '订单',
          render: (r) =>
            `<div class="mono ellipsis" style="max-width:190px">${esc(pick(r, 'orderNo') || pick(r, 'order_no') || '')}</div>
             <div class="small muted">${esc(pick(r, 'productTitles', 'product_titles') || `${pick(r, 'itemsCount', 'items_count') || 1} 件`)}</div>`,
        },
        {
          label: '用户',
          render: (r) =>
            `<div class="ellipsis" style="max-width:150px">${esc(pick(r, 'nickname', 'userNickname', 'user_nickname') || pick(r, 'userId', 'user_id') || '—')}</div>`,
        },
        { label: '金额', right: true, render: (r) => `<span class="amount">${esc(yuan(r, 'total'))}</span>` },
        { label: '来源', render: (r) => `<span class="tag">${esc(pick(r, 'source') || 'miniprogram')}</span>` },
        { label: '状态', render: (r) => statusTag(pick(r, 'status'), ORDER_STATUS) },
        { label: '创建时间', render: (r) => `<span class="small">${esc(dateText(pick(r, 'createdAt', 'created_at')))}</span>` },
        {
          label: '操作',
          render: (r) => {
            const orderNo = pick(r, 'orderNo', 'order_no') || '';
            const status = pick(r, 'status');
            return `<div class="acts">
              <button class="btn btn--ghost btn--xs" type="button" data-detail="${esc(orderNo)}">详情</button>
              ${status === 'pending' ? `<button class="btn btn--danger-line btn--xs" type="button" data-close="${esc(orderNo)}">强制关单</button>` : ''}
              ${status === 'paid' ? `<button class="btn btn--line btn--xs" type="button" data-complete="${esc(orderNo)}">标记完成</button>` : ''}
            </div>`;
          },
        },
      ],
      list,
      emptyBox('🧾', '没有匹配的订单', keyword || status ? '换个条件再试' : 'H5 下单后会出现在这里')
    );
    pager.innerHTML = pagerHtml(page, total, 20);
    bindPager(pager, (next) => {
      page = next;
      load();
    });
  }

  body.addEventListener('click', async (event) => {
    const detailBtn = event.target.closest('[data-detail]');
    if (detailBtn) {
      const orderNo = detailBtn.dataset.detail;
      const box = openModal(`订单 ${orderNo}`, '<div class="inline-loading"><span class="spin"></span>加载中…</div>');
      if (!box) return;
      const info = await api('GET', `/api/admin/orders/${encodeURIComponent(orderNo)}`).catch((err) => ({ __error: err }));
      if (info && info.__error) {
        box.innerHTML = errorBox(info.__error, '订单详情接口未就绪');
        bindRetry(box);
        return;
      }
      const order = (info && (info.order || info)) || {};
      const items = Array.isArray(info && info.items) ? info.items : [];
      const payment = (info && info.payment) || null;
      box.innerHTML = `
        <dl class="kv">
          <dt>订单号</dt><dd class="mono">${esc(pick(order, 'orderNo', 'order_no') || orderNo)}</dd>
          <dt>状态</dt><dd>${statusTag(pick(order, 'status'), ORDER_STATUS)}</dd>
          <dt>订单金额</dt><dd>${esc(yuan(order, 'total'))}</dd>
          <dt>实付</dt><dd>${esc(yuan(order, 'paid'))}</dd>
          <dt>已退</dt><dd>${esc(yuan(order, 'refunded'))}</dd>
          <dt>用户</dt><dd>${esc(pick(order, 'nickname', 'userId', 'user_id') || '—')}</dd>
          <dt>来源</dt><dd>${esc(pick(order, 'source') || '—')}</dd>
          <dt>创建</dt><dd>${esc(dateText(pick(order, 'createdAt', 'created_at')))}</dd>
          <dt>支付</dt><dd>${esc(dateText(pick(order, 'paidAt', 'paid_at')))}</dd>
          <dt>过期</dt><dd>${esc(dateText(pick(order, 'expireAt', 'expire_at')))}</dd>
          ${payment ? `<dt>支付单</dt><dd class="mono">${esc(pick(payment, 'outTradeNo', 'out_trade_no') || '—')}</dd>` : ''}
          ${order.remark ? `<dt>备注</dt><dd>${esc(order.remark)}</dd>` : ''}
        </dl>
        ${
          items.length
            ? `<div class="strong small mt16">商品（${items.length}）</div>
               <div class="table-wrap mt8"><table class="table"><thead><tr><th>课程</th><th class="right">单价</th><th class="right">数量</th></tr></thead><tbody>
               ${items
                 .map(
                   (item) =>
                     `<tr><td>${esc(pick(item, 'title') || '课程')}</td><td class="right">${esc(yuan(item, 'price'))}</td><td class="right">${esc(pick(item, 'quantity') || 1)}</td></tr>`
                 )
                 .join('')}
               </tbody></table></div>`
            : ''
        }`;
      return;
    }

    const closeBtn = event.target.closest('[data-close]');
    if (closeBtn) {
      const orderNo = closeBtn.dataset.close;
      const result = await withBusy(closeBtn, () => api('POST', `/api/admin/orders/${encodeURIComponent(orderNo)}/close`, {}));
      if (!result.ok) return;
      toast('订单已强制关闭', 'ok');
      load();
      return;
    }

    const completeBtn = event.target.closest('[data-complete]');
    if (completeBtn) {
      const orderNo = completeBtn.dataset.complete;
      const result = await withBusy(completeBtn, () => api('POST', `/api/admin/orders/${encodeURIComponent(orderNo)}/complete`, {}));
      if (!result.ok) return;
      toast('已标记完成', 'ok');
      load();
    }
  });

  $('#o-search').addEventListener('click', () => {
    page = 1;
    load();
  });
  $('#o-keyword').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      page = 1;
      load();
    }
  });
  $('#o-status').addEventListener('change', () => {
    page = 1;
    load();
  });
  $('#o-refresh').addEventListener('click', () => load());

  await load();
}

/* ------------------------------------------------------------------ *
 * 视图 · 退款审核
 * ------------------------------------------------------------------ */
async function viewRefunds({ host }) {
  host.innerHTML = `
    <div class="toolbar">
      <input class="input" id="r-keyword" placeholder="退款单号 / 订单号" />
      <select class="select" id="r-status">
        <option value="">全部状态</option>
        ${Object.entries(REFUND_STATUS)
          .map(([key, label]) => `<option value="${esc(key)}">${esc(label)}</option>`)
          .join('')}
      </select>
      <button class="btn" type="button" id="r-search">查询</button>
      <span class="toolbar__spacer"></span>
      <button class="btn btn--ghost" type="button" id="r-refresh">刷新</button>
    </div>
    <div class="card">
      <div class="card__head">
        <div>
          <div class="card__title">退款申请</div>
          <div class="card__sub">通过后立即出款（mock 立即成功），驳回需填写原因</div>
        </div>
        <span class="badge" id="r-total">—</span>
      </div>
      <div id="r-body"><div class="inline-loading"><span class="spin"></span>加载退款单…</div></div>
      <div id="r-pager"></div>
    </div>`;

  const body = $('#r-body');
  const pager = $('#r-pager');
  let page = 1;

  async function act(btn, path, payload, okText) {
    const result = await withBusy(btn, () => api('POST', path, payload));
    if (!result.ok) return;
    toast(okText, 'ok');
    load();
  }

  async function load() {
    body.innerHTML = '<div class="inline-loading"><span class="spin"></span>加载退款单…</div>';
    const params = new URLSearchParams({ page: String(page), size: '20' });
    const keyword = $('#r-keyword').value.trim();
    const status = $('#r-status').value;
    if (keyword) params.set('keyword', keyword);
    if (status) params.set('status', status);
    const result = await withBusy(null, () => api('GET', `/api/admin/refunds?${params.toString()}`));
    if (!result.ok) {
      body.innerHTML = errorBox(result.error, '/api/admin/refunds 尚未就绪');
      bindRetry(body);
      pager.innerHTML = '';
      return;
    }
    const list = toList(result.value);
    const total = (result.value && result.value.total) || list.length;
    $('#r-total').textContent = `${total} 条退款`;
    body.innerHTML = tableHtml(
      [
        {
          label: '退款单',
          render: (r) =>
            `<div class="mono ellipsis" style="max-width:170px">${esc(pick(r, 'refundNo', 'refund_no') || '')}</div>
             <div class="small muted mono ellipsis" style="max-width:170px">${esc(pick(r, 'orderNo', 'order_no') || '')}</div>`,
        },
        {
          label: '用户',
          render: (r) => `<div class="ellipsis" style="max-width:130px">${esc(pick(r, 'nickname', 'userId', 'user_id') || '—')}</div>`,
        },
        { label: '金额', right: true, render: (r) => `<span class="amount">${esc(yuan(r, 'amount'))}</span>` },
        {
          label: '原因',
          render: (r) => `<div class="small ellipsis" style="max-width:220px" title="${esc(pick(r, 'reason') || '')}">${esc(pick(r, 'reason') || '—')}</div>`,
        },
        { label: '状态', render: (r) => statusTag(pick(r, 'status'), REFUND_STATUS) },
        { label: '申请时间', render: (r) => `<span class="small">${esc(dateText(pick(r, 'createdAt', 'created_at')))}</span>` },
        {
          label: '操作',
          render: (r) => {
            const refundNo = pick(r, 'refundNo', 'refund_no') || '';
            const status = pick(r, 'status');
            const canReview = ['pending', 'approved', 'processing'].includes(status);
            return `<div class="acts">
              ${
                canReview
                  ? `<button class="btn btn--ok btn--xs" type="button" data-approve="${esc(refundNo)}">通过并出款</button>
                     <button class="btn btn--danger-line btn--xs" type="button" data-reject="${esc(refundNo)}">驳回</button>`
                  : `<span class="small muted">已处理</span>`
              }
            </div>`;
          },
        },
      ],
      list,
      emptyBox('↩️', '没有退款申请', keyword || status ? '换个条件再试' : 'H5 提交退款后会出现在这里')
    );
    pager.innerHTML = pagerHtml(page, total, 20);
    bindPager(pager, (next) => {
      page = next;
      load();
    });
  }

  body.addEventListener('click', async (event) => {
    const approve = event.target.closest('[data-approve]');
    if (approve) {
      const refundNo = approve.dataset.approve;
      await act(approve, `/api/admin/refunds/${encodeURIComponent(refundNo)}/approve`, { note: '' }, '退款已通过并出款');
      return;
    }
    const reject = event.target.closest('[data-reject]');
    if (reject) {
      const refundNo = reject.dataset.reject;
      const box = openModal('驳回退款', `
        <label class="field">
          <span class="field__label">驳回原因（会通知用户）</span>
          <textarea class="textarea" id="reject-reason" placeholder="例如：课程已开课，按规则不支持退款"></textarea>
        </label>
        <div class="row mt16" style="justify-content:flex-end">
          <button class="btn btn--ghost" type="button" data-cancel="1">取消</button>
          <button class="btn btn--danger" type="button" id="reject-submit">确认驳回</button>
        </div>`);
      if (!box) return;
      box.querySelector('[data-cancel]').addEventListener('click', closeModal);
      box.querySelector('#reject-submit').addEventListener('click', async (e) => {
        const reason = box.querySelector('#reject-reason').value.trim();
        if (!reason) {
          toast('请填写驳回原因');
          return;
        }
        const result = await withBusy(e.currentTarget, () =>
          api('POST', `/api/admin/refunds/${encodeURIComponent(refundNo)}/reject`, { reason })
        );
        if (!result.ok) return;
        closeModal();
        toast('已驳回该退款', 'ok');
        load();
      });
    }
  });

  $('#r-search').addEventListener('click', () => {
    page = 1;
    load();
  });
  $('#r-keyword').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      page = 1;
      load();
    }
  });
  $('#r-status').addEventListener('change', () => {
    page = 1;
    load();
  });
  $('#r-refresh').addEventListener('click', () => load());

  await load();
}

/* ------------------------------------------------------------------ *
 * 视图 · 提现审核
 * ------------------------------------------------------------------ */
async function viewWithdrawals({ host }) {
  host.innerHTML = `
    <div class="toolbar">
      <select class="select" id="w-status">
        <option value="">全部状态</option>
        ${Object.entries(WITHDRAW_STATUS)
          .map(([key, label]) => `<option value="${esc(key)}">${esc(label)}</option>`)
          .join('')}
      </select>
      <button class="btn" type="button" id="w-search">查询</button>
      <span class="toolbar__spacer"></span>
      <button class="btn btn--ghost" type="button" id="w-refresh">刷新</button>
    </div>
    <div class="card">
      <div class="card__head">
        <div>
          <div class="card__title">提现申请</div>
          <div class="card__sub">通过 → 待打款 → 标记已打款；驳回会退回余额</div>
        </div>
        <span class="badge" id="w-total">—</span>
      </div>
      <div id="w-body"><div class="inline-loading"><span class="spin"></span>加载提现单…</div></div>
      <div id="w-pager"></div>
    </div>`;

  const body = $('#w-body');
  const pager = $('#w-pager');
  let page = 1;

  async function load() {
    body.innerHTML = '<div class="inline-loading"><span class="spin"></span>加载提现单…</div>';
    const params = new URLSearchParams({ page: String(page), size: '20' });
    const status = $('#w-status').value;
    if (status) params.set('status', status);
    const result = await withBusy(null, () => api('GET', `/api/admin/withdrawals?${params.toString()}`));
    if (!result.ok) {
      body.innerHTML = errorBox(result.error, '/api/admin/withdrawals 尚未就绪');
      bindRetry(body);
      pager.innerHTML = '';
      return;
    }
    const list = toList(result.value);
    const total = (result.value && result.value.total) || list.length;
    $('#w-total').textContent = `${total} 条提现`;
    body.innerHTML = tableHtml(
      [
        {
          label: '提现单',
          render: (r) => `<div class="mono small ellipsis" style="max-width:160px">${esc(pick(r, 'id') || '')}</div>`,
        },
        {
          label: '用户',
          render: (r) =>
            `<div class="ellipsis" style="max-width:150px">${esc(pick(r, 'nickname', 'userNickname', 'user_nickname') || pick(r, 'userId', 'user_id') || '—')}</div>`,
        },
        { label: '金额', right: true, render: (r) => `<span class="amount">${esc(yuan(r, 'amount'))}</span>` },
        { label: '状态', render: (r) => statusTag(pick(r, 'status'), WITHDRAW_STATUS) },
        { label: '申请时间', render: (r) => `<span class="small">${esc(dateText(pick(r, 'createdAt', 'created_at')))}</span>` },
        {
          label: '备注',
          render: (r) => `<div class="small muted ellipsis" style="max-width:180px">${esc(pick(r, 'reviewNote', 'review_note', 'reason') || '—')}</div>`,
        },
        {
          label: '操作',
          render: (r) => {
            const id = pick(r, 'id') || '';
            const status = pick(r, 'status');
            return `<div class="acts">
              ${status === 'pending' ? `<button class="btn btn--ok btn--xs" type="button" data-approve="${esc(id)}">通过</button>` : ''}
              ${status === 'approved' ? `<button class="btn btn--line btn--xs" type="button" data-paid="${esc(id)}">标记已打款</button>` : ''}
              ${['pending', 'approved'].includes(status) ? `<button class="btn btn--danger-line btn--xs" type="button" data-reject="${esc(id)}">驳回</button>` : ''}
              ${!['pending', 'approved'].includes(status) ? '<span class="small muted">已处理</span>' : ''}
            </div>`;
          },
        },
      ],
      list,
      emptyBox('🏦', '没有提现申请', status ? '换个状态再试' : '分销员申请提现后会出现在这里')
    );
    pager.innerHTML = pagerHtml(page, total, 20);
    bindPager(pager, (next) => {
      page = next;
      load();
    });
  }

  body.addEventListener('click', async (event) => {
    const approve = event.target.closest('[data-approve]');
    if (approve) {
      const result = await withBusy(approve, () => api('POST', `/api/admin/withdrawals/${encodeURIComponent(approve.dataset.approve)}/approve`, {}));
      if (!result.ok) return;
      toast('已通过，等待打款', 'ok');
      load();
      return;
    }
    const paid = event.target.closest('[data-paid]');
    if (paid) {
      const result = await withBusy(paid, () => api('POST', `/api/admin/withdrawals/${encodeURIComponent(paid.dataset.paid)}/paid`, {}));
      if (!result.ok) return;
      toast('已标记为已打款', 'ok');
      load();
      return;
    }
    const reject = event.target.closest('[data-reject]');
    if (reject) {
      const id = reject.dataset.reject;
      const box = openModal('驳回提现', `
        <label class="field">
          <span class="field__label">驳回原因</span>
          <textarea class="textarea" id="wd-reason" placeholder="例如：收款信息不完整，请联系客服补全"></textarea>
        </label>
        <div class="row mt16" style="justify-content:flex-end">
          <button class="btn btn--ghost" type="button" data-cancel="1">取消</button>
          <button class="btn btn--danger" type="button" id="wd-submit">确认驳回</button>
        </div>`);
      if (!box) return;
      box.querySelector('[data-cancel]').addEventListener('click', closeModal);
      box.querySelector('#wd-submit').addEventListener('click', async (e) => {
        const reason = box.querySelector('#wd-reason').value.trim();
        if (!reason) {
          toast('请填写驳回原因');
          return;
        }
        const result = await withBusy(e.currentTarget, () =>
          api('POST', `/api/admin/withdrawals/${encodeURIComponent(id)}/reject`, { reason })
        );
        if (!result.ok) return;
        closeModal();
        toast('已驳回，金额退回余额', 'ok');
        load();
      });
    }
  });

  $('#w-search').addEventListener('click', () => {
    page = 1;
    load();
  });
  $('#w-status').addEventListener('change', () => {
    page = 1;
    load();
  });
  $('#w-refresh').addEventListener('click', () => load());

  await load();
}

/* ------------------------------------------------------------------ *
 * 视图 · 分销
 * ------------------------------------------------------------------ */
async function viewDist({ host }) {
  const result = await withBusy(null, () => api('GET', '/api/admin/dist?page=1&size=50'));
  if (!result.ok) {
    host.innerHTML = errorBox(result.error, '/api/admin/dist 尚未就绪');
    bindRetry(host);
    return;
  }
  const list = toList(result.value);
  const total = (result.value && result.value.total) || list.length;

  host.innerHTML = `
    <div class="card">
      <div class="card__head">
        <div>
          <div class="card__title">分销员列表</div>
          <div class="card__sub">共 ${esc(total)} 位分销员 · 可手工调整佣金（写 adjust 流水）</div>
        </div>
        <button class="btn btn--ghost btn--sm" type="button" data-retry="1">刷新</button>
      </div>
      ${tableHtml(
        [
          {
            label: '分销员',
            render: (r) =>
              `<div class="strong ellipsis" style="max-width:160px">${esc(pick(r, 'nickname') || '未命名')}</div>
               <div class="small muted mono">${esc(pick(r, 'id', 'userId', 'user_id') || '')}</div>`,
          },
          { label: '邀请码', render: (r) => `<span class="mono">${esc(pick(r, 'inviteCode', 'invite_code') || '—')}</span>` },
          { label: '上级', render: (r) => esc(pick(r, 'parentNickname', 'parent_nickname') || '—') },
          { label: '团队', right: true, render: (r) => esc(pick(r, 'teamSize', 'team_size') === undefined ? '—' : pick(r, 'teamSize', 'team_size')) },
          { label: '状态', render: (r) => statusTag(pick(r, 'distEnabled', 'dist_enabled') ? 'on' : 'off', { on: '已开通', off: '未开通' }) },
          { label: '可提现', right: true, render: (r) => `<span class="amount">${esc(withYuan(moneyText(r, 'available') || '0.00'))}</span>` },
          {
            label: '操作',
            render: (r) => `<button class="btn btn--ghost btn--xs" type="button" data-adjust="${esc(pick(r, 'id', 'userId', 'user_id') || '')}"
              data-name="${esc(pick(r, 'nickname') || '')}">调整佣金</button>`,
          },
        ],
        list,
        emptyBox('💰', '还没有分销员', '用户在 H5 分销中心开通后会出现在这里')
      )}
    </div>`;

  host.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-adjust]');
    if (!btn) return;
    const userId = btn.dataset.adjust;
    const name = btn.dataset.name || userId;
    const box = openModal(`调整佣金 · ${name}`, `
      <label class="field">
        <span class="field__label">调整金额（元，可负数）</span>
        <input class="input" id="adj-amount" inputmode="decimal" placeholder="例如 50 或 -20" />
      </label>
      <label class="field mt12">
        <span class="field__label">备注（写进流水）</span>
        <input class="input" id="adj-note" maxlength="80" placeholder="例如：活动奖励" />
      </label>
      <div class="row mt16" style="justify-content:flex-end">
        <button class="btn btn--ghost" type="button" data-cancel="1">取消</button>
        <button class="btn" type="button" id="adj-submit">提交调整</button>
      </div>`);
    if (!box) return;
    box.querySelector('[data-cancel]').addEventListener('click', closeModal);
    box.querySelector('#adj-submit').addEventListener('click', async (e) => {
      const raw = box.querySelector('#adj-amount').value.trim();
      const negative = raw.startsWith('-');
      const amountCents = yuanToCents(raw);
      if (!amountCents) {
        toast('请输入调整金额');
        return;
      }
      const note = box.querySelector('#adj-note').value.trim();
      const result2 = await withBusy(e.currentTarget, () =>
        api('POST', '/api/admin/dist/adjust', {
          userId,
          amountCents: negative ? -amountCents : amountCents,
          note: note || '后台手工调整',
        })
      );
      if (!result2.ok) return;
      closeModal();
      toast('佣金已调整', 'ok');
      render();
    });
  });
}

/* ------------------------------------------------------------------ *
 * 视图 · 客服会话
 * ------------------------------------------------------------------ */
async function viewService({ host }) {
  host.innerHTML = `
    <div class="split">
      <div class="card">
        <div class="card__head">
          <div>
            <div class="card__title">会话</div>
            <div class="card__sub" id="conv-count">加载中…</div>
          </div>
          <select class="select" id="conv-status" style="width:104px">
            <option value="open">进行中</option>
            <option value="closed">已结束</option>
            <option value="">全部</option>
          </select>
        </div>
        <div class="conv-list" id="conv-list"><div class="inline-loading"><span class="spin"></span>加载会话…</div></div>
      </div>
      <div class="card">
        <div id="thread"></div>
      </div>
    </div>`;

  const listBox = $('#conv-list');
  let activeId = '';
  let conversations = [];

  function threadShell(conv) {
    const name = pick(conv, 'nickname', 'userNickname', 'user_nickname') || pick(conv, 'userId', 'user_id') || '用户';
    return `
      <div class="thread">
        <div class="card__head" style="margin-bottom:8px">
          <div>
            <div class="card__title">${esc(name)}</div>
            <div class="card__sub">会话 ${esc(pick(conv, 'id') || '')} · ${esc(dateText(pick(conv, 'lastMsgAt', 'last_msg_at')))}</div>
          </div>
          <div class="row">
            <button class="btn btn--ghost btn--sm" type="button" id="conv-refresh">刷新</button>
            <button class="btn btn--danger-line btn--sm" type="button" id="conv-close">结束会话</button>
          </div>
        </div>
        <div class="thread__scroll" id="thread-scroll"></div>
        <div class="thread__foot">
          <div class="row">
            <input class="input" id="reply-input" placeholder="以客服身份回复…" />
            <button class="btn" type="button" id="reply-send">发送</button>
          </div>
          <div class="small muted mt8">回车发送 · 每 5 秒自动拉取新消息</div>
        </div>
      </div>`;
  }

  function msgHtml(msg) {
    const type = pick(msg, 'senderType', 'sender_type') || 'user';
    const cls = type === 'user' ? 'msg--user' : type === 'system' ? 'msg--system' : 'msg--admin';
    const who = type === 'user' ? '用户' : type === 'admin' ? '客服（我）' : type === 'ai' ? 'AI 助手' : '系统';
    return `
      <div class="msg ${cls}">
        <div class="msg__who">${esc(who)}</div>
        <div class="msg__bubble">${esc(pick(msg, 'content') || '')}</div>
        <div class="msg__time">${esc(dateText(pick(msg, 'createdAt', 'created_at')))}</div>
      </div>`;
  }

  async function loadThread(conv) {
    const thread = $('#thread');
    const scroll = $('#thread-scroll');
    if (!thread || !scroll) return;
    const result = await withBusy(null, () => api('GET', `/api/admin/conversations/${encodeURIComponent(pick(conv, 'id'))}/messages`));
    if (!result.ok) {
      scroll.innerHTML = errorBox(result.error, '会话消息接口尚未就绪');
      bindRetry(scroll);
      return;
    }
    const list = toList(result.value && result.value.messages ? result.value.messages : result.value);
    const wasBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 60;
    scroll.innerHTML = list.length ? list.map(msgHtml).join('') : '<div class="small muted center">暂无消息</div>';
    if (wasBottom || true) scroll.scrollTop = scroll.scrollHeight;

    const send = $('#reply-send');
    const input = $('#reply-input');
    const close = $('#conv-close');
    const refresh = $('#conv-refresh');

    const doSend = async () => {
      const content = input.value.trim();
      if (!content) return;
      const sent = await withBusy(send, () =>
        api('POST', `/api/admin/conversations/${encodeURIComponent(pick(conv, 'id'))}/messages`, { content })
      );
      if (!sent.ok) return;
      input.value = '';
      await loadThread(conv);
    };

    send.addEventListener('click', doSend);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        doSend();
      }
    });
    refresh.addEventListener('click', () => loadThread(conv));
    close.addEventListener('click', async () => {
      const done = await withBusy(close, () =>
        api('POST', `/api/admin/conversations/${encodeURIComponent(pick(conv, 'id'))}/close`, {})
      );
      if (!done.ok) return;
      toast('会话已结束', 'ok');
      loadConversations();
      $('#thread').innerHTML = emptyBox('💬', '未选择会话', '从左侧选择一个会话开始回复');
    });
  }

  async function loadConversations() {
    listBox.innerHTML = '<div class="inline-loading"><span class="spin"></span>加载会话…</div>';
    const status = $('#conv-status').value;
    const params = new URLSearchParams({ page: '1', size: '50' });
    if (status) params.set('status', status);
    const result = await withBusy(null, () => api('GET', `/api/admin/conversations?${params.toString()}`));
    if (!result.ok) {
      listBox.innerHTML = errorBox(result.error, '/api/admin/conversations 尚未就绪');
      bindRetry(listBox);
      $('#conv-count').textContent = '加载失败';
      return;
    }
    conversations = toList(result.value);
    $('#conv-count').textContent = `${conversations.length} 个会话`;
    if (!conversations.length) {
      listBox.innerHTML = emptyBox('💬', '暂无会话', '用户从 H5 发起客服咨询后会出现在这里');
      $('#thread').innerHTML = emptyBox('💬', '未选择会话', '从左侧选择一个会话开始回复');
      return;
    }
    listBox.innerHTML = conversations
      .map((conv) => {
        const id = pick(conv, 'id') || '';
        const name = pick(conv, 'nickname', 'userNickname', 'user_nickname') || pick(conv, 'userId', 'user_id') || '用户';
        const unread = Number(pick(conv, 'unreadAdmin', 'unread_admin') || 0);
        return `
          <a class="conv${id === activeId ? ' is-active' : ''}" data-conv="${esc(id)}" href="#/service">
            <div class="conv__head">
              <span class="conv__name">${esc(name)}${unread ? ` <span class="tag tag--danger">${unread}</span>` : ''}</span>
              <span class="conv__time">${esc(dateText(pick(conv, 'lastMsgAt', 'last_msg_at')))}</span>
            </div>
            <div class="conv__preview">${esc(pick(conv, 'lastMsgPreview', 'last_msg_preview') || '（暂无消息）')}</div>
            <div class="small muted mt4">${statusTag(pick(conv, 'status'), { open: '进行中', closed: '已结束' })}</div>
          </a>`;
      })
      .join('');

    const first = conversations.find((conv) => pick(conv, 'id') === activeId) || conversations[0];
    if (first) {
      activeId = pick(first, 'id');
      $('#thread').innerHTML = threadShell(first);
      await loadThread(first);
      listBox.querySelectorAll('[data-conv]').forEach((node) => {
        node.classList.toggle('is-active', node.dataset.conv === activeId);
      });
      addTimer(() => {
        const current = conversations.find((conv) => pick(conv, 'id') === activeId);
        if (current) loadThread(current);
      }, 5000);
    }
  }

  listBox.addEventListener('click', async (event) => {
    const link = event.target.closest('[data-conv]');
    if (!link) return;
    event.preventDefault();
    activeId = link.dataset.conv;
    const conv = conversations.find((item) => pick(item, 'id') === activeId);
    if (!conv) return;
    listBox.querySelectorAll('[data-conv]').forEach((node) => node.classList.toggle('is-active', node.dataset.conv === activeId));
    clearTimers();
    $('#thread').innerHTML = threadShell(conv);
    await loadThread(conv);
    addTimer(() => {
      const current = conversations.find((item) => pick(item, 'id') === activeId);
      if (current) loadThread(current);
    }, 5000);
  });

  $('#conv-status').addEventListener('change', () => {
    activeId = '';
    loadConversations();
  });

  await loadConversations();
}

/* ------------------------------------------------------------------ *
 * 视图 · 用户
 * ------------------------------------------------------------------ */
async function viewUsers({ host }) {
  host.innerHTML = `
    <div class="toolbar">
      <input class="input" id="u-keyword" placeholder="昵称 / 用户 ID / 邀请码" />
      <button class="btn" type="button" id="u-search">查询</button>
      <span class="toolbar__spacer"></span>
      <button class="btn btn--ghost" type="button" id="u-refresh">刷新</button>
    </div>
    <div class="card">
      <div class="card__head">
        <div>
          <div class="card__title">用户列表</div>
          <div class="card__sub">含上级关系与团队人数，可用于客服排查分销链路</div>
        </div>
        <span class="badge" id="u-total">—</span>
      </div>
      <div id="u-body"><div class="inline-loading"><span class="spin"></span>加载用户…</div></div>
      <div id="u-pager"></div>
    </div>`;

  const body = $('#u-body');
  const pager = $('#u-pager');
  let page = 1;

  async function load() {
    body.innerHTML = '<div class="inline-loading"><span class="spin"></span>加载用户…</div>';
    const params = new URLSearchParams({ page: String(page), size: '20' });
    const keyword = $('#u-keyword').value.trim();
    if (keyword) params.set('keyword', keyword);
    const result = await withBusy(null, () => api('GET', `/api/admin/users?${params.toString()}`));
    if (!result.ok) {
      body.innerHTML = errorBox(result.error, '/api/admin/users 尚未就绪');
      bindRetry(body);
      pager.innerHTML = '';
      return;
    }
    const list = toList(result.value);
    const total = (result.value && result.value.total) || list.length;
    $('#u-total').textContent = `${total} 位用户`;
    body.innerHTML = tableHtml(
      [
        {
          label: '用户',
          render: (r) =>
            `<div class="strong ellipsis" style="max-width:150px">${esc(pick(r, 'nickname') || '未命名')}</div>
             <div class="small muted mono ellipsis" style="max-width:150px">${esc(pick(r, 'id') || '')}</div>`,
        },
        { label: '邀请码', render: (r) => `<span class="mono">${esc(pick(r, 'inviteCode', 'invite_code') || '—')}</span>` },
        { label: '上级', render: (r) => esc(pick(r, 'parentNickname', 'parent_nickname') || '—') },
        { label: '团队人数', right: true, render: (r) => esc(pick(r, 'teamSize', 'team_size') === undefined ? 0 : pick(r, 'teamSize', 'team_size')) },
        { label: '分销', render: (r) => statusTag(pick(r, 'distEnabled', 'dist_enabled') ? 'on' : 'off', { on: '已开通', off: '未开通' }) },
        { label: '注册时间', render: (r) => `<span class="small">${esc(dateText(pick(r, 'createdAt', 'created_at')))}</span>` },
      ],
      list,
      emptyBox('👥', '没有匹配的用户', keyword ? '换个关键词再试' : '用户通过 dev-login 登录后会出现在这里')
    );
    pager.innerHTML = pagerHtml(page, total, 20);
    bindPager(pager, (next) => {
      page = next;
      load();
    });
  }

  $('#u-search').addEventListener('click', () => {
    page = 1;
    load();
  });
  $('#u-keyword').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      page = 1;
      load();
    }
  });
  $('#u-refresh').addEventListener('click', () => load());

  await load();
}

/* ------------------------------------------------------------------ *
 * 视图 · 业务参数
 * ------------------------------------------------------------------ */
const SETTING_META = {
  commission_l1_bps: { label: '一级佣金比例（bps）', hint: '100 bps = 1%，默认 1500 = 15%' },
  commission_l2_bps: { label: '二级佣金比例（bps）', hint: '100 bps = 1%，默认 500 = 5%' },
  freeze_days: { label: '佣金冻结天数', hint: '支付后冻结 N 天转为可提现' },
  refund_window_days: { label: '退款窗口（天）', hint: '超过该天数不可自助退款' },
  auto_refund_max_cents: { label: 'AI 自动退款上限（分）', hint: '订单实付不超过该值时自动通过退款' },
  auto_refund_enabled: { label: '开启 AI 自动退款', hint: '关闭后退款全部进人工审核' },
  min_withdraw_cents: { label: '最低提现金额（分）', hint: '1000 = 10.00 元' },
  order_timeout_minutes: { label: '订单支付超时（分钟）', hint: '超时自动关单并回滚库存' },
  allow_partial_refund: { label: '允许部分退款', hint: '关闭后只支持全额退款' },
  service_welcome: { label: '客服欢迎语', hint: '用户进入客服会话时自动展示' },
  ai_provider: { label: 'AI 引擎', hint: 'rule 为本地规则引擎' },
};

async function viewSettings({ host }) {
  const result = await withBusy(null, () => api('GET', '/api/admin/settings'));
  if (!result.ok) {
    host.innerHTML = errorBox(result.error, '/api/admin/settings 尚未就绪');
    bindRetry(host);
    return;
  }
  const data = result.value || {};
  const settings = data.settings || {};
  const editable = data.editable || {};
  const defaults = data.defaults || {};
  const keys = Object.keys(editable);
  const initial = {};

  if (!keys.length) {
    host.innerHTML = emptyBox('⚙️', '没有可配置项', '后台未返回 EDITABLE_SETTINGS 白名单');
    return;
  }

  host.innerHTML = `
    <div class="card">
      <div class="card__head">
        <div>
          <div class="card__title">业务参数</div>
          <div class="card__sub">修改后立即对下单 / 退款 / 分销生效；只提交改动的项</div>
        </div>
        <div class="row">
          <button class="btn btn--ghost btn--sm" type="button" id="s-reset">重新载入</button>
          <button class="btn btn--sm" type="button" id="s-save">保存修改</button>
        </div>
      </div>
      <div class="settings-grid">
        ${keys
          .map((key) => {
            const type = editable[key];
            const meta = SETTING_META[key] || { label: key, hint: '' };
            const value = settings[key];
            const def = defaults[key];
            if (type === 'bool') {
              const checked = value === true || value === 1 || String(value) === 'true';
              initial[key] = checked;
              return `
                <div class="setting">
                  <span class="setting__label">${esc(meta.label)}</span>
                  <label class="check"><input type="checkbox" data-setting="${esc(key)}" data-type="bool" ${checked ? 'checked' : ''} /><span>${checked ? '已开启' : '已关闭'}</span></label>
                  <span class="setting__hint">${esc(meta.hint)}${def === undefined ? '' : `（默认 ${esc(def)}）`}</span>
                  <span class="setting__key">${esc(key)}</span>
                </div>`;
            }
            initial[key] = value === undefined ? '' : String(value);
            if (type === 'int') {
              return `
                <div class="setting">
                  <span class="setting__label">${esc(meta.label)}</span>
                  <input class="input" type="number" min="0" step="1" data-setting="${esc(key)}" data-type="int" value="${esc(initial[key])}" />
                  <span class="setting__hint">${esc(meta.hint)}${def === undefined ? '' : `（默认 ${esc(def)}）`}</span>
                  <span class="setting__key">${esc(key)}</span>
                </div>`;
            }
            return `
              <div class="setting">
                <span class="setting__label">${esc(meta.label)}</span>
                <input class="input" data-setting="${esc(key)}" data-type="string" value="${esc(initial[key])}" />
                <span class="setting__hint">${esc(meta.hint)}${def === undefined ? '' : `（默认 ${esc(def)}）`}</span>
                <span class="setting__key">${esc(key)}</span>
              </div>`;
          })
          .join('')}
      </div>
      <div class="small muted mt16">金额相关参数单位是「分」：18000 分 = 180.00 元。修改会被写入审计日志。</div>
    </div>`;

  host.querySelectorAll('[data-type="bool"]').forEach((input) => {
    input.addEventListener('change', () => {
      const text = input.parentElement.querySelector('span');
      if (text) text.textContent = input.checked ? '已开启' : '已关闭';
    });
  });

  $('#s-reset').addEventListener('click', () => render());

  $('#s-save').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    const patch = {};
    host.querySelectorAll('[data-setting]').forEach((input) => {
      const key = input.dataset.setting;
      const type = input.dataset.type;
      if (type === 'bool') {
        if (input.checked !== initial[key]) patch[key] = input.checked;
        return;
      }
      const raw = input.value.trim();
      if (raw === initial[key]) return;
      if (type === 'int') {
        const num = Number(raw);
        if (!Number.isFinite(num) || num < 0) {
          toast(`${key} 必须是非负数字`);
          input.focus();
          return;
        }
        patch[key] = Math.trunc(num);
        return;
      }
      patch[key] = raw;
    });

    const changed = Object.keys(patch);
    if (!changed.length) {
      toast('没有修改任何参数');
      return;
    }
    const saved = await withBusy(btn, () => api('PUT', '/api/admin/settings', patch));
    if (!saved.ok) return;
    toast(`已保存 ${changed.length} 项参数`, 'ok');
    render();
  });
}

/* ------------------------------------------------------------------ *
 * 视图 · 审计日志
 * ------------------------------------------------------------------ */
async function viewAudit({ host }) {
  const result = await withBusy(null, () => api('GET', '/api/admin/audit-logs?page=1&size=50'));
  if (!result.ok) {
    host.innerHTML = errorBox(result.error, '/api/admin/audit-logs 尚未就绪');
    bindRetry(host);
    return;
  }
  const list = toList(result.value);
  const total = (result.value && result.value.total) || list.length;

  host.innerHTML = `
    <div class="card">
      <div class="card__head">
        <div>
          <div class="card__title">审计日志</div>
          <div class="card__sub">最近 ${esc(list.length)} 条 / 共 ${esc(total)} 条</div>
        </div>
        <button class="btn btn--ghost btn--sm" type="button" data-retry="1">刷新</button>
      </div>
      ${tableHtml(
        [
          { label: '时间', render: (r) => `<span class="small nowrap">${esc(dateText(pick(r, 'createdAt', 'created_at')))}</span>` },
          { label: '操作者', render: (r) => `<span class="mono small">${esc(pick(r, 'actorType', 'actor_type') || '—')}</span><div class="small muted mono">${esc(pick(r, 'actorId', 'actor_id') || '')}</div>` },
          { label: '动作', render: (r) => `<span class="strong small">${esc(pick(r, 'action') || '')}</span>` },
          {
            label: '对象',
            render: (r) =>
              `<div class="small">${esc(pick(r, 'targetType', 'target_type') || '—')}</div><div class="small muted mono">${esc(pick(r, 'targetId', 'target_id') || '')}</div>`,
          },
          {
            label: '详情',
            render: (r) => `<div class="small muted ellipsis" style="max-width:320px" title="${esc(pick(r, 'detail') || '')}">${esc(pick(r, 'detail') || '—')}</div>`,
          },
        ],
        list,
        emptyBox('📜', '还没有审计记录', '后台的每次写操作都会落一条日志')
      )}
    </div>`;
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */
function boot() {
  if (!location.hash) history.replaceState(null, '', `${location.pathname}#/dashboard`);

  window.addEventListener('hashchange', () => {
    render().catch(() => toast('页面渲染失败，请重试', 'error'));
  });

  const logout = $('#logout');
  if (logout) {
    logout.addEventListener('click', () => {
      localStorage.removeItem(TOKEN_KEY);
      state.admin = null;
      toast('已退出登录', 'ok');
      go('/login');
    });
  }

  const menuBtn = $('#menu-btn');
  const side = $('#side');
  if (menuBtn && side) {
    menuBtn.addEventListener('click', () => side.classList.toggle('is-open'));
    document.addEventListener('click', (event) => {
      if (!side.classList.contains('is-open')) return;
      if (side.contains(event.target) || menuBtn.contains(event.target)) return;
      side.classList.remove('is-open');
    });
  }

  // 首次进入：有 token 就补一次 /api/admin/me，失效会自动跳登录
  if (localStorage.getItem(TOKEN_KEY)) {
    api('GET', '/api/admin/me')
      .then((data) => {
        state.admin = (data && data.admin) || null;
        const badge = $('#top-admin');
        if (badge && state.admin) badge.textContent = `${state.admin.username} · 管理员`;
      })
      .catch(() => {});
  }

  render().catch(() => toast('页面渲染失败，请重试', 'error'));
}

boot();
