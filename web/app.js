/* =========================================================
 * 悦己瑜伽 · H5 商城（原生 ES module，零依赖）
 * - 统一 fetch：解 {ok:true,data} / {ok:false,code,message}
 * - 401 清 token 并跳登录；错误 toast；按钮请求中 disabled
 * - 金额一律优先使用后端 xxxText（缺字段时才按「分」做字符串兜底）
 * - hash 路由：/#/home /#/products /#/product/:id /#/checkout/:id
 *              /#/cashier/:orderNo /#/orders /#/order/:orderNo
 *              /#/refund/:orderNo /#/courses /#/dist /#/service /#/ai /#/me /#/login
 * ========================================================= */

const TOKEN_KEY = 'yoga_user_token';
const OPENID_KEY = 'yoga_user_openid';
const PENDING_INVITE_KEY = 'yoga_pending_invite';

const TYPE_TEXT = { online: '线上课程', offline: '到店课程', membership: '会员卡' };
const ORDER_STATUS = {
  pending: '待支付',
  paid: '已支付',
  completed: '已完成',
  cancelled: '已取消',
  refunding: '退款中',
  refunded: '已退款',
  partial_refunded: '部分退款',
};
const ORDER_STATUS_CLASS = {
  pending: 'status--warning',
  paid: 'status--ok',
  completed: 'status--muted',
  cancelled: 'status--muted',
  refunding: 'status--warning',
  refunded: 'status--danger',
  partial_refunded: 'status--danger',
};
const REFUND_STATUS = {
  pending: '待审核',
  approved: '已通过',
  processing: '退款处理中',
  succeeded: '退款成功',
  rejected: '已驳回',
  failed: '退款失败',
};
const REFUND_STATUS_CLASS = {
  pending: 'status--warning',
  approved: 'status--warning',
  processing: 'status--warning',
  succeeded: 'status--ok',
  rejected: 'status--danger',
  failed: 'status--danger',
};
const WITHDRAW_STATUS = {
  pending: '待审核',
  approved: '待打款',
  paid: '已打款',
  rejected: '已驳回',
};
const AI_INTENT_HINT = 'AI 会按你的目标推荐课程，并可直接下单、支付、退款';

const state = { me: null, timers: [], cleanup: [] };

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

/** 后端未提供 xxxText 时的兜底格式化：纯字符串拼接，不做除法运算 */
function centsText(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return null;
  const int = Math.trunc(n);
  const abs = String(Math.abs(int)).padStart(3, '0');
  return `${int < 0 ? '-' : ''}${abs.slice(0, -2)}.${abs.slice(-2)}`;
}

/** 取金额文本：优先 obj[key+'Text']（后端契约），缺字段才兜底 */
function money(obj, key) {
  if (!obj) return '—';
  const text = obj[`${key}Text`];
  if (text !== undefined && text !== null && text !== '') return String(text);
  const fallback = centsText(obj[`${key}Cents`]);
  return fallback === null ? '—' : fallback;
}

/** 统一货币展示：字段已带 ¥/￥ 时原样返回，避免出现「¥¥」 */
function withYuan(text) {
  if (text === undefined || text === null) return '—';
  const value = String(text).trim();
  if (!value) return '—';
  if (value === '—') return '—';
  return /^[¥￥]/.test(value) ? value : `¥${value}`;
}

/** 展示金额：优先后端 xxxText，统一补 ¥ 前缀（后端字段有无符号都能兼容） */
function yuanText(obj, key) {
  return withYuan(money(obj, key));
}

/** 分 → 「¥ + 纯数字」（仅用于前端乘法合计这类临时展示） */
function yuanCents(cents) {
  const text = centsText(cents);
  return text === null ? '—' : withYuan(text);
}

/** 输入框「元」→ 分（用户输入换算，非展示除法） */
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

function dateText(iso, withTime) {
  if (!iso) return '—';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return String(iso).slice(0, 16).replace('T', ' ');
  const base = `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;
  return withTime === false ? base : `${base} ${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
}

function timeText(iso) {
  if (!iso) return '';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  return `${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
}

function typeText(type) {
  return TYPE_TEXT[type] || '课程';
}

function coverOf(item) {
  if (!item) return '';
  if (item.cover) return item.cover;
  if (item.id) return `/api/media/cover/${encodeURIComponent(item.id)}`;
  if (item.productId) return `/api/media/cover/${encodeURIComponent(item.productId)}`;
  return '';
}

function statusText(obj, fallbackMap) {
  if (!obj) return '—';
  if (obj.statusText) return String(obj.statusText);
  const map = fallbackMap || ORDER_STATUS;
  return map[obj.status] || obj.status || '—';
}

function statusClass(status, map) {
  const m = map || ORDER_STATUS_CLASS;
  return m[status] || 'status--muted';
}

function toList(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.list)) return data.list;
  return [];
}

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

function openModal(title, bodyHtml) {
  const root = $('#modal-root');
  if (!root) return null;
  root.innerHTML = `
    <div class="modal-mask" data-mask="1">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal__head">
          <div class="modal__title">${esc(title)}</div>
          <button class="modal__close" type="button" data-close="1" aria-label="关闭">✕</button>
        </div>
        <div class="modal__body">${bodyHtml || ''}</div>
      </div>
    </div>`;
  const mask = $('[data-mask]', root);
  mask.addEventListener('click', (event) => {
    if (event.target === mask) closeModal();
  });
  $('[data-close]', root).addEventListener('click', closeModal);
  return $('.modal__body', root);
}

function closeModal() {
  const root = $('#modal-root');
  if (root) root.innerHTML = '';
}

/* ------------------------------------------------------------------ *
 * 计时器（路由切换时统一清理，避免轮询泄漏）
 * ------------------------------------------------------------------ */
function addTimer(fn, ms) {
  const id = setInterval(fn, ms);
  state.timers.push(id);
  return id;
}

function addCleanup(fn) {
  state.cleanup.push(fn);
}

function clearTimers() {
  state.timers.forEach((id) => clearInterval(id));
  state.timers = [];
  state.cleanup.forEach((fn) => {
    try {
      fn();
    } catch {
      /* 清理失败不影响导航 */
    }
  });
  state.cleanup = [];
}

/* ------------------------------------------------------------------ *
 * 统一 fetch 封装
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
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined && body !== null) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, { method, headers, body: payload });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', '网络连接失败，请检查后端服务是否已启动');
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
  if (res.ok && raw && raw.ok === true) return raw.data !== undefined ? raw.data : raw;
  const code = (raw && raw.code) || `HTTP_${res.status}`;
  let message = (raw && raw.message) || '';
  if (!message) {
    if (res.status === 404) message = '接口尚未就绪（404），功能上线后可用';
    else if (res.status === 0) message = '网络连接失败';
    else message = `请求失败（HTTP ${res.status}）`;
  }
  if (res.status === 401 || code === 'UNAUTHORIZED') {
    handleUnauthorized(message, path);
    throw new ApiError(401, code, message, raw && raw.details);
  }
  throw new ApiError(res.status, code, message, raw && raw.details);
}

function handleUnauthorized(message, path) {
  localStorage.removeItem(TOKEN_KEY);
  state.me = null;
  if (String(path).startsWith('/api/auth/')) return;
  toast(message || '登录已过期，请重新登录', 'error');
  const here = currentPath();
  if (!here.startsWith('/login')) go(`/login?next=${encodeURIComponent(here)}`);
}

/** 包一层：请求中禁用按钮，失败统一 toast */
async function withBusy(btn, fn) {
  if (btn && btn.disabled) return { ok: false, error: new ApiError(0, 'BUSY', '请稍候') };
  if (btn) btn.disabled = true;
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (err) {
    toast((err && err.message) || '操作失败', 'error');
    return { ok: false, error: err };
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ *
 * 登录态
 * ------------------------------------------------------------------ */
function hasToken() {
  return !!localStorage.getItem(TOKEN_KEY);
}

function currentPath() {
  const raw = location.hash.replace(/^#/, '');
  return raw || '/home';
}

function ensureLogin(nextPath) {
  if (hasToken()) return true;
  toast('请先登录后继续');
  go(`/login?next=${encodeURIComponent(nextPath || currentPath())}`);
  return false;
}

async function loadMe(force) {
  if (state.me && !force) return state.me;
  if (!hasToken()) return null;
  try {
    const data = await api('GET', '/api/me');
    state.me = data && data.user ? data.user : null;
    return data;
  } catch {
    return null;
  }
}

function randomOpenid() {
  let openid = localStorage.getItem(OPENID_KEY);
  if (!openid) {
    openid = `dev_h5_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(OPENID_KEY, openid);
  }
  return openid;
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */
function go(path) {
  const clean = String(path || '/home');
  const target = clean.startsWith('#') ? clean : `#${clean.startsWith('/') ? '' : '/'}${clean}`;
  if (location.hash === target) render();
  else location.hash = target;
}

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/home';
  const [path, search] = raw.split('?');
  const seg = path.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  return { path, seg, query: new URLSearchParams(search || '') };
}

const ROUTES = {
  home: { title: '悦己瑜伽', tab: 'home', view: viewHome },
  products: { title: '全部课程', tab: 'home', view: viewProducts },
  product: { title: '课程详情', view: viewProduct },
  checkout: { title: '确认订单', view: viewCheckout },
  cashier: { title: '收银台', view: viewCashier },
  orders: { title: '我的订单', view: viewOrders },
  order: { title: '订单详情', view: viewOrderDetail },
  refund: { title: '申请退款', view: viewRefund },
  courses: { title: '我的课程', tab: 'courses', view: viewCourses },
  dist: { title: '分销中心', view: viewDist },
  service: { title: '在线客服', full: true, view: viewService },
  ai: { title: 'AI 课程顾问', full: true, view: viewAi },
  me: { title: '我的', tab: 'me', view: viewMe },
  login: { title: '登录', tab: 'login-hide', hideTab: true, view: viewLogin },
  join: { title: '接受邀请', hideTab: true, view: viewJoin },
};

function renderChrome(route) {
  const titleNode = $('#appbar-title');
  if (titleNode) titleNode.textContent = route.title || '悦己瑜伽';
  const back = $('#appbar-back');
  if (back) {
    const showBack = !route.tab;
    back.hidden = !showBack;
    back.onclick = () => {
      if (history.length > 1) history.back();
      else go('/home');
    };
  }
  const tabbar = $('#tabbar');
  if (tabbar) {
    const showTab = !!route.tab && route.tab !== 'login-hide' && !route.hideTab && !route.full;
    tabbar.hidden = !showTab;
    tabbar.querySelectorAll('.tabbar__item').forEach((item) => {
      item.classList.toggle('is-active', item.dataset.tab === route.tab);
    });
  }
}

async function render() {
  clearTimers();
  closeModal();
  const { seg, query } = parseHash();
  const key = seg.length ? seg[0] : 'home';
  const route = ROUTES[key] || { title: '页面不存在', view: viewNotFound, hideTab: true };
  renderChrome(route);
  // 每轮渲染换一个干净的宿主节点，避免事件监听在多次渲染后叠加
  const previous = $('#view');
  if (!previous) return;
  const host = previous.cloneNode(false);
  previous.replaceWith(host);
  host.className = route.full ? 'view view--full' : 'view';
  host.innerHTML = '<div class="skel-wrap"><div class="skeleton skel-hero"></div><div class="skel-grid"><div class="skeleton skel-card"></div><div class="skeleton skel-card"></div></div></div>';
  window.scrollTo(0, 0);
  try {
    await route.view({ seg, query, host });
  } catch (err) {
    host.innerHTML = errorBox(err);
    bindRetry(host);
  }
}

/* ------------------------------------------------------------------ *
 * 通用状态块
 * ------------------------------------------------------------------ */
function errorBox(err, hint) {
  const status = err && err.status;
  const code = (err && err.code) || (status ? `HTTP_${status}` : 'ERROR');
  const message = (err && err.message) || '加载失败';
  return `
    <div class="error-box">
      <div class="error-box__ico">🥲</div>
      <div class="error-box__msg">${esc(message)}</div>
      <div class="error-box__code">${esc(code)}</div>
      <div class="error-box__hint">${esc(hint || '接口就绪后会自动恢复，可稍后重试')}</div>
      <button class="btn btn--ghost btn--sm" type="button" data-retry="1">重新加载</button>
    </div>`;
}

function emptyBox(icon, title, desc, extraHtml) {
  return `
    <div class="empty">
      <div class="empty__ico">${esc(icon || '🍃')}</div>
      <div class="empty__title">${esc(title || '这里还空着')}</div>
      <div class="empty__desc">${esc(desc || '')}</div>
      ${extraHtml || ''}
    </div>`;
}

function skeletonGrid(count) {
  const n = count || 4;
  let cards = '';
  for (let i = 0; i < n; i += 1) cards += '<div class="skeleton skel-card"></div>';
  return `<div class="skel-grid">${cards}</div>`;
}

function bindRetry(root) {
  const scope = root || document;
  const btn = scope.querySelector('[data-retry]');
  if (btn) {
    btn.addEventListener('click', () => render());
  }
}

function bindRetries(root) {
  const scope = root || document;
  scope.querySelectorAll('[data-retry]').forEach((btn) => {
    btn.addEventListener('click', () => render());
  });
}

/* ------------------------------------------------------------------ *
 * 组件片段
 * ------------------------------------------------------------------ */
function productCard(p) {
  const id = p.id || p.productId || '';
  const badges = Array.isArray(p.badges) && p.badges.length ? p.badges[0] : '';
  return `
    <a class="pcard" href="#/product/${encodeURIComponent(id)}">
      <div class="pcard__cover">
        <img src="${esc(coverOf(p))}" alt="${esc(p.title || '课程')}" loading="lazy" />
        ${badges ? `<span class="pcard__badge">${esc(badges)}</span>` : ''}
        ${p.discountText ? `<span class="pcard__discount">${esc(p.discountText)}</span>` : ''}
      </div>
      <div class="pcard__body">
        <div class="pcard__title">${esc(p.title || '未命名课程')}</div>
        <div class="pcard__sub">${esc(p.subtitle || '')}</div>
        <div class="pcard__meta">${esc(typeText(p.type))}${p.durationMin ? ` · ${esc(p.durationMin)} 分钟` : ''}</div>
        <div class="pcard__price">
          <span class="price">${esc(yuanText(p, 'price'))}</span>
          ${p.originalPriceText ? `<span class="price-old">${esc(yuanText(p, 'originalPrice'))}</span>` : ''}
          <span class="pcard__sales">${p.sales ? `已售 ${esc(p.sales)}` : ''}</span>
        </div>
      </div>
    </a>`;
}

function productGrid(list) {
  return `<div class="pgrid">${list.map(productCard).join('')}</div>`;
}

function orderCard(order) {
  const status = order && order.status;
  return `
    <div class="ocard" data-order="${esc(order && order.orderNo)}">
      <div class="ocard__head">
        <span class="ocard__no">${esc((order && order.orderNo) || '订单号未返回')}</span>
        <span class="status ${statusClass(status)}">${esc(statusText(order))}</span>
      </div>
      <div class="ocard__title">${esc(
        (order && (order.productTitles || order.title)) ||
          `共 ${(order && order.itemsCount) || 1} 件课程`
      )}</div>
      <div class="ocard__foot">
        <span class="ocard__amt price">${esc(yuanText(order, 'total'))}</span>
        <span class="ocard__acts">
          <a class="btn btn--ghost btn--xs" href="#/order/${encodeURIComponent((order && order.orderNo) || '')}">详情</a>
          ${
            (order && typeof order.canPay === 'boolean' ? order.canPay : status === 'pending')
              ? `<button class="btn btn--primary btn--xs" type="button" data-pay="${esc(order.orderNo)}">去支付</button>`
              : ''
          }
          ${
            (order && typeof order.canRefund === 'boolean'
              ? order.canRefund
              : status === 'paid' || status === 'completed' || status === 'partial_refunded')
              ? `<button class="btn btn--danger btn--xs" type="button" data-refund="${esc(order.orderNo)}">申请退款</button>`
              : ''
          }
        </span>
      </div>
    </div>`;
}

function chatShell(options) {
  return `
    <div class="chat">
      <div class="chat__head">
        <div class="avatar">${esc(options.icon || '✨')}</div>
        <div class="grow">
          <div class="chat__title">${esc(options.title || '')}</div>
          <div class="chat__sub">${esc(options.sub || '')}</div>
        </div>
        <div class="chat__tools">${options.tools || ''}</div>
      </div>
      <div class="chat__scroll" id="chat-scroll">
        <div class="chat__inner" id="chat-inner"></div>
      </div>
      <div id="chat-foot"></div>
    </div>`;
}

function scrollChat() {
  const box = $('#chat-scroll');
  if (box) box.scrollTop = box.scrollHeight;
}

/* ------------------------------------------------------------------ *
 * 视图 · 首页
 * ------------------------------------------------------------------ */
async function viewHome({ host }) {
  let homeErr = null;
  const [home, goals] = await Promise.all([
    api('GET', '/api/home').catch((err) => {
      homeErr = err;
      return null;
    }),
    api('GET', '/api/goals').catch(() => []),
  ]);

  let data = home;
  if (!data) {
    const page = await api('GET', '/api/products?sort=hot&page=1&size=6').catch((err) => {
      homeErr = homeErr || err;
      return null;
    });
    if (page) {
      data = {
        banners: [],
        notice: '',
        sections: [{ key: 'hot', title: '热门课程', subtitle: '首页接口尚未就绪，先看热门', products: toList(page) }],
      };
      homeErr = null;
    }
  }
  if (!data) {
    host.innerHTML = errorBox(homeErr, '首页接口（/api/home、/api/products）尚未就绪');
    bindRetry(host);
    return;
  }

  const banners = Array.isArray(data.banners) ? data.banners : [];
  const sections = Array.isArray(data.sections) ? data.sections : [];
  const goalList = Array.isArray(goals) ? goals : [];
  const notice = data.notice || (homeErr ? '部分模块未就绪，页面已自动降级展示' : '');

  const bannerHtml = banners.length
    ? banners
        .map((b, index) => {
          const href = b.productId
            ? `#/product/${encodeURIComponent(b.productId)}`
            : b.url || b.link || '#/products';
          const img = b.image || b.imageUrl || b.cover || '';
          return `
            <a class="banner" href="${esc(href)}" style="${
              b.bgColor ? `background:${esc(b.bgColor)};` : ''
            }">
              <div class="banner__eyebrow">${esc(b.eyebrow || `YOGIFT · 0${index + 1}`)}</div>
              <div class="banner__title">${esc(b.title || b.name || '悦己瑜伽')}</div>
              <div class="banner__sub">${esc(b.subtitle || b.desc || '')}</div>
              <span class="banner__cta">${esc(b.ctaText || b.buttonText || '立即查看')} →</span>
              ${img ? `<img class="banner__img" src="${esc(img)}" alt="" />` : ''}
            </a>`;
        })
        .join('')
    : `
      <a class="banner" href="#/products">
        <div class="banner__eyebrow">WELCOME</div>
        <div class="banner__title">先把身体交给呼吸<br />再交给体式</div>
        <div class="banner__sub">6 门精选课程 · 线上到店都有</div>
        <span class="banner__cta">开始选课 →</span>
      </a>
      <a class="banner" href="#/ai" style="background:linear-gradient(135deg,#2f2a54,#6c5ce7 60%,#a99bff)">
        <div class="banner__eyebrow">AI 顾问</div>
        <div class="banner__title">不知道练什么？<br />跟我说一句就行</div>
        <div class="banner__sub">${esc(AI_INTENT_HINT)}</div>
        <span class="banner__cta">去问问 →</span>
      </a>`;

  const goalsHtml = goalList.length
    ? `<div class="chips">${goalList
        .map(
          (g) => `
        <a class="chip" href="#/products?goal=${encodeURIComponent(g.key || g.label || '')}">
          ${esc(g.icon || '')} ${esc(g.label || g.key || '')}${g.count ? ` · ${esc(g.count)}` : ''}
        </a>`
        )
        .join('')}</div>`
    : '';

  const sectionsHtml = sections
    .map((section) => {
      const list = Array.isArray(section.products) ? section.products : [];
      return `
        <section class="section">
          <div class="section__head">
            <div>
              <div class="section__title">${esc(section.title || '推荐课程')}</div>
              ${section.subtitle ? `<div class="section__sub">${esc(section.subtitle)}</div>` : ''}
            </div>
            <a class="section__more" href="#/products">全部 ›</a>
          </div>
          ${list.length ? productGrid(list) : emptyBox('🍃', '该板块暂无课程', '稍后再来看看')}
        </section>`;
    })
    .join('');

  host.innerHTML = `
    <div class="hero"><div class="hero__track">${bannerHtml}</div></div>
    ${notice ? `<div class="notice"><span class="notice__ico">📢</span><span class="grow">${esc(notice)}</span></div>` : ''}
    <a class="ai-entry" href="#/ai">
      <span class="ai-entry__ico">✨</span>
      <span class="grow">
        <span class="ai-entry__title">AI 课程顾问</span>
        <span class="ai-entry__desc">说「我想减脂」，直接推荐并下单</span>
      </span>
      <span class="ai-entry__go">›</span>
    </a>
    ${goalsHtml ? `<section class="section"><div class="section__head"><div class="section__title">按目标选课</div></div>${goalsHtml}</section>` : ''}
    ${sectionsHtml || emptyBox('📚', '暂无推荐课程', '课程数据就绪后会自动出现在这里', '<a class="btn btn--ghost btn--sm mt8" href="#/products">看看全部课程</a>')}
    <p class="center muted small mt20">本地演示环境 · 支付为 mock 模拟</p>
  `;
}

/* ------------------------------------------------------------------ *
 * 视图 · 商品列表
 * ------------------------------------------------------------------ */
function readFilters(query) {
  return {
    type: query.get('type') || '',
    goal: query.get('goal') || '',
    sort: query.get('sort') || 'hot',
    keyword: query.get('keyword') || '',
  };
}

function filtersToHash(filters) {
  const params = new URLSearchParams();
  if (filters.type) params.set('type', filters.type);
  if (filters.goal) params.set('goal', filters.goal);
  if (filters.sort && filters.sort !== 'hot') params.set('sort', filters.sort);
  if (filters.keyword) params.set('keyword', filters.keyword);
  const qs = params.toString();
  return `/products${qs ? `?${qs}` : ''}`;
}

async function viewProducts({ host, query }) {
  const filters = readFilters(query);
  const goals = await api('GET', '/api/goals').catch(() => []);

  const typeChips = [
    { key: '', label: '全部' },
    { key: 'online', label: '线上' },
    { key: 'offline', label: '到店' },
    { key: 'membership', label: '会员' },
  ];
  const sortChips = [
    { key: 'hot', label: '最热' },
    { key: 'new', label: '最新' },
    { key: 'price_asc', label: '价格 ↑' },
    { key: 'price_desc', label: '价格 ↓' },
  ];
  const goalList = Array.isArray(goals) ? goals : [];

  host.innerHTML = `
    <div class="field" style="margin-bottom:10px">
      <input class="input" id="p-search" type="search" placeholder="搜索课程 / 老师" value="${esc(filters.keyword)}" />
    </div>
    <div class="chips" id="p-type">
      ${typeChips
        .map(
          (c) =>
            `<button class="chip${filters.type === c.key ? ' is-active' : ''}" type="button" data-type="${esc(c.key)}">${esc(c.label)}</button>`
        )
        .join('')}
    </div>
    ${
      goalList.length
        ? `<div class="chips" id="p-goal">
            <button class="chip chip--accent${filters.goal ? '' : ' is-active'}" type="button" data-goal="">不限目标</button>
            ${goalList
              .map(
                (g) =>
                  `<button class="chip chip--accent${filters.goal === (g.key || g.label) ? ' is-active' : ''}" type="button" data-goal="${esc(g.key || g.label || '')}">${esc(g.icon || '')} ${esc(g.label || g.key || '')}</button>`
              )
              .join('')}
          </div>`
        : ''
    }
    <div class="chips" id="p-sort">
      ${sortChips
        .map(
          (c) =>
            `<button class="chip${filters.sort === c.key ? ' is-active' : ''}" type="button" data-sort="${esc(c.key)}">${esc(c.label)}</button>`
        )
        .join('')}
    </div>
    <div id="plist">${skeletonGrid(4)}</div>`;

  const current = { ...filters };
  const goto = () => go(filtersToHash(current));

  $('#p-type').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-type]');
    if (!btn) return;
    current.type = btn.dataset.type || '';
    goto();
  });
  $('#p-sort').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-sort]');
    if (!btn) return;
    current.sort = btn.dataset.sort || 'hot';
    goto();
  });
  const goalBox = $('#p-goal');
  if (goalBox) {
    goalBox.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-goal]');
      if (!btn) return;
      current.goal = btn.dataset.goal || '';
      goto();
    });
  }
  const search = $('#p-search');
  const submitSearch = () => {
    current.keyword = search.value.trim();
    goto();
  };
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitSearch();
    }
  });
  search.addEventListener('change', submitSearch);

  const listHost = $('#plist');
  let page = 1;

  async function load(nextPage, append) {
    if (!append) listHost.innerHTML = skeletonGrid(4);
    const params = new URLSearchParams({ page: String(nextPage), size: '20', sort: current.sort || 'hot' });
    if (current.type) params.set('type', current.type);
    if (current.goal) params.set('goal', current.goal);
    if (current.keyword) params.set('keyword', current.keyword);
    const result = await withBusy(null, () => api('GET', `/api/products?${params.toString()}`));
    if (!result.ok) {
      if (!append) {
        listHost.innerHTML = errorBox(result.error, '/api/products 尚未就绪');
        bindRetry(listHost);
      }
      return;
    }
    const list = toList(result.value);
    const hasMore = !!(result.value && result.value.hasMore);
    if (!append) {
      listHost.innerHTML = list.length
        ? productGrid(list)
        : emptyBox('🔍', '没有匹配的课程', '换个目标标签或关键词试试', '<a class="btn btn--ghost btn--sm mt8" href="#/products">清空筛选</a>');
    } else {
      const grid = listHost.querySelector('.pgrid');
      if (grid) grid.insertAdjacentHTML('beforeend', list.map(productCard).join(''));
    }
    const oldMore = listHost.querySelector('[data-more]');
    if (oldMore) oldMore.parentElement.remove();
    if (hasMore && list.length) {
      listHost.insertAdjacentHTML(
        'beforeend',
        '<div class="center mt12"><button class="btn btn--line btn--sm" type="button" data-more="1">加载更多</button></div>'
      );
      const moreBtn = listHost.querySelector('[data-more]');
      moreBtn.addEventListener('click', () => {
        moreBtn.disabled = true;
        page += 1;
        load(page, true).catch(() => {
          moreBtn.disabled = false;
        });
      });
    }
  }

  await load(page, false);
}

/* ------------------------------------------------------------------ *
 * 视图 · 课程详情
 * ------------------------------------------------------------------ */
async function viewProduct({ host, seg }) {
  const productId = seg[1] || '';
  if (!productId) {
    host.innerHTML = errorBox(new ApiError(400, 'BAD_REQUEST', '缺少课程 ID'), '链接不完整');
    bindRetry(host);
    return;
  }
  const result = await withBusy(null, () => api('GET', `/api/products/${encodeURIComponent(productId)}`));
  if (!result.ok) {
    host.innerHTML = errorBox(result.error, '/api/products/:id 尚未就绪');
    bindRetry(host);
    return;
  }
  const payload = result.value || {};
  const product = payload.product || payload || {};
  const skus = (Array.isArray(payload.skus) ? payload.skus : []).filter((s) => s.status !== 'off');
  const faq = Array.isArray(payload.faq) ? payload.faq : [];
  const related = Array.isArray(payload.related) ? payload.related : [];
  const tags = Array.isArray(product.goalTags) ? product.goalTags : [];

  let selectedSku = skus.length ? skus[0] : null;

  host.innerHTML = `
    <div class="pdt__cover"><img src="${esc(coverOf(product))}" alt="${esc(product.title || '课程')}" /></div>
    <div class="pdt__title">${esc(product.title || '未命名课程')}</div>
    <div class="pdt__sub">${esc(product.subtitle || '')}</div>
    <div class="pdt__price">
      <span class="price" id="pdt-price">${esc(yuanText(selectedSku || product, 'price'))}</span>
      ${product.originalPriceText ? `<span class="price-old">${esc(yuanText(product, 'originalPrice'))}</span>` : ''}
      ${product.discountText ? `<span class="tag tag--accent">${esc(product.discountText)}</span>` : ''}
      <span class="pdt__sold">${product.sales ? `已售 ${esc(product.sales)}` : ''}</span>
    </div>
    ${tags.length ? `<div class="chips mt8">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
    ${
      skus.length
        ? `<div class="card mt12">
            <div class="strong small">选择规格</div>
            <div class="sku-list" id="sku-list">
              ${skus
                .map(
                  (sku, index) => `
                <button class="sku${index === 0 ? ' is-active' : ''}" type="button" data-sku="${esc(sku.id)}"
                        data-price-text="${esc(sku.priceText || '')}" data-price-cents="${esc(sku.priceCents || 0)}"
                        data-name="${esc(sku.name || '规格')}">
                  <div class="sku__name">${esc(sku.name || '规格')}</div>
                  ${sku.spec ? `<div class="sku__spec">${esc(sku.spec)}</div>` : ''}
                  <div class="sku__price">${esc(yuanText(sku, 'price'))}</div>
                </button>`
                )
                .join('')}
            </div>
          </div>`
        : ''
    }
    <div class="card mt12">
      <div class="strong small">课程信息</div>
      <div class="info-list">
        <div class="info-row"><span class="info-row__k">类型</span><span class="info-row__v">${esc(typeText(product.type))}</span></div>
        ${product.teacher ? `<div class="info-row"><span class="info-row__k">老师</span><span class="info-row__v">${esc(product.teacher)}</span></div>` : ''}
        ${product.durationMin ? `<div class="info-row"><span class="info-row__k">时长</span><span class="info-row__v">${esc(product.durationMin)} 分钟 / 节</span></div>` : ''}
        ${product.schedule ? `<div class="info-row"><span class="info-row__k">排课</span><span class="info-row__v">${esc(product.schedule)}</span></div>` : ''}
        <div class="info-row"><span class="info-row__k">库存</span><span class="info-row__v">${product.stock === undefined ? '充足' : `${esc(product.stock)} 份`}</span></div>
      </div>
    </div>
    ${product.detailHtml ? `<div class="card mt12"><div class="strong small">课程介绍</div><div class="detail-html mt8">${product.detailHtml}</div></div>` : ''}
    ${
      faq.length
        ? `<div class="card mt12">
            <div class="strong small">常见问题</div>
            <div class="faq">
              ${faq
                .map(
                  (item) => `
                <details>
                  <summary>${esc(item.q || item.question || '')}</summary>
                  <div class="faq__a">${esc(item.a || item.answer || '')}</div>
                </details>`
                )
                .join('')}
            </div>
          </div>`
        : ''
    }
    ${
      related.length
        ? `<section class="section mt16">
            <div class="section__head"><div class="section__title">相关课程</div></div>
            ${productGrid(related)}
          </section>`
        : ''
    }
    <div style="height:76px"></div>
    <div class="buybar">
      <div class="buybar__price">
        <span class="price" id="buybar-price">${esc(yuanText(selectedSku || product, 'price'))}</span>
        <div class="buybar__hint">${selectedSku ? esc(selectedSku.name || '') : '默认规格'}</div>
      </div>
      <button class="btn btn--accent" type="button" id="buy-now">立即购买</button>
    </div>`;

  const skuList = $('#sku-list');
  if (skuList) {
    skuList.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-sku]');
      if (!btn) return;
      skuList.querySelectorAll('[data-sku]').forEach((node) => node.classList.remove('is-active'));
      btn.classList.add('is-active');
      const skuCents = centsText(btn.dataset.priceCents);
      const text = withYuan(btn.dataset.priceText || skuCents);
      $('#pdt-price').textContent = text;
      $('#buybar-price').textContent = text;
      $('.buybar__hint').textContent = btn.dataset.name || '';
      selectedSku = skus.find((sku) => String(sku.id) === String(btn.dataset.sku)) || selectedSku;
    });
  }

  $('#buy-now').addEventListener('click', () => {
    const params = new URLSearchParams();
    if (selectedSku && selectedSku.id) params.set('sku', selectedSku.id);
    params.set('qty', '1');
    go(`/checkout/${encodeURIComponent(productId)}?${params.toString()}`);
  });
}

/* ------------------------------------------------------------------ *
 * 视图 · 确认订单
 * ------------------------------------------------------------------ */
async function viewCheckout({ host, seg, query }) {
  if (!ensureLogin(`/checkout/${seg[1] || ''}`)) return;
  const productId = seg[1] || '';
  const result = await withBusy(null, () => api('GET', `/api/products/${encodeURIComponent(productId)}`));
  if (!result.ok) {
    host.innerHTML = errorBox(result.error, '无法加载课程信息，暂时不能下单');
    bindRetry(host);
    return;
  }
  const payload = result.value || {};
  const product = payload.product || payload || {};
  const skus = (Array.isArray(payload.skus) ? payload.skus : []).filter((s) => s.status !== 'off');
  const wantedSku = query.get('sku');
  let selected = skus.find((sku) => String(sku.id) === String(wantedSku)) || (skus.length ? skus[0] : null);
  let quantity = Math.min(Math.max(Number(query.get('qty')) || 1, 1), 9);

  const unitCents = selected ? Number(selected.priceCents || 0) : Number(product.priceCents || 0);
  const unitText = () => (selected ? yuanText(selected, 'price') : yuanText(product, 'price'));

  host.innerHTML = `
    <div class="card">
      <div class="checkout-item">
        <div class="checkout-item__img"><img src="${esc(coverOf(product))}" alt="" /></div>
        <div class="grow">
          <div class="checkout-item__title">${esc(product.title || '课程')}</div>
          <div class="muted small mt4">${esc(product.subtitle || typeText(product.type))}</div>
          <div class="price mt4" id="unit-price">${esc(unitText())}</div>
        </div>
      </div>
    </div>
    ${
      skus.length
        ? `<div class="card">
            <div class="strong small">规格</div>
            <div class="sku-list" id="co-sku">
              ${skus
                .map(
                  (sku) => `
                <button class="sku${selected && sku.id === selected.id ? ' is-active' : ''}" type="button"
                        data-sku="${esc(sku.id)}" data-price-text="${esc(sku.priceText || '')}" data-price-cents="${esc(sku.priceCents || 0)}">
                  <div class="sku__name">${esc(sku.name || '规格')}</div>
                  ${sku.spec ? `<div class="sku__spec">${esc(sku.spec)}</div>` : ''}
                  <div class="sku__price">${esc(yuanText(sku, 'price'))}</div>
                </button>`
                )
                .join('')}
            </div>
          </div>`
        : ''
    }
    <div class="card">
      <div class="row row--between">
        <span class="small strong">购买数量</span>
        <span class="qty">
          <button class="qty__btn" type="button" id="qty-minus" aria-label="减少">−</button>
          <span class="qty__val" id="qty-val">${quantity}</span>
          <button class="qty__btn" type="button" id="qty-plus" aria-label="增加">+</button>
        </span>
      </div>
      <div class="divider"></div>
      <label class="field" style="margin-bottom:0">
        <span class="field__label">备注（可选）</span>
        <textarea class="textarea" id="remark" maxlength="120" placeholder="例如：想从下周开始练"></textarea>
      </label>
    </div>
    <div class="card">
      <div class="summary">
        <div class="summary__row"><span class="muted">商品小计</span><span id="sum-price">${esc(unitText())}</span></div>
        <div class="summary__row"><span class="muted">数量</span><span id="sum-qty">× ${quantity}</span></div>
        <div class="summary__row summary__row--total"><span>合计</span><span class="price" id="sum-total">${esc(yuanCents(unitCents * quantity))}</span></div>
      </div>
      <p class="muted small mt8">提交后库存即锁定，请在订单有效期内完成支付。</p>
    </div>
    <div style="height:76px"></div>
    <div class="buybar">
      <div class="buybar__price">
        <span class="price" id="bar-total">${esc(yuanCents(unitCents * quantity))}</span>
        <div class="buybar__hint">最终金额以订单接口返回为准</div>
      </div>
      <button class="btn btn--primary" type="button" id="submit-order">提交订单</button>
    </div>`;

  const refreshTotals = () => {
    const unit = selected ? Number(selected.priceCents || 0) : Number(product.priceCents || 0);
    const total = yuanCents(unit * quantity);
    $('#unit-price').textContent = unitText();
    $('#sum-price').textContent = unitText();
    $('#sum-qty').textContent = `× ${quantity}`;
    $('#sum-total').textContent = total;
    $('#bar-total').textContent = total;
    $('#qty-val').textContent = String(quantity);
    $('#qty-minus').disabled = quantity <= 1;
    $('#qty-plus').disabled = quantity >= 9;
  };
  refreshTotals();

  const skuBox = $('#co-sku');
  if (skuBox) {
    skuBox.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-sku]');
      if (!btn) return;
      skuBox.querySelectorAll('[data-sku]').forEach((node) => node.classList.remove('is-active'));
      btn.classList.add('is-active');
      selected = skus.find((sku) => String(sku.id) === String(btn.dataset.sku)) || selected;
      refreshTotals();
    });
  }
  $('#qty-minus').addEventListener('click', () => {
    if (quantity > 1) quantity -= 1;
    refreshTotals();
  });
  $('#qty-plus').addEventListener('click', () => {
    if (quantity < 9) quantity += 1;
    refreshTotals();
  });

  $('#submit-order').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    const remark = $('#remark').value.trim();
    const body = { productId, quantity, source: 'h5' };
    if (selected && selected.id) body.skuId = selected.id;
    if (remark) body.remark = remark;
    const created = await withBusy(btn, () => api('POST', '/api/orders', body));
    if (!created.ok) return;
    const orderNo = (created.value && created.value.orderNo) || '';
    toast('下单成功，去支付吧', 'ok');
    if (orderNo) go(`/cashier/${encodeURIComponent(orderNo)}`);
    else go('/orders');
  });
}

/* ------------------------------------------------------------------ *
 * 视图 · 收银台
 * ------------------------------------------------------------------ */
async function viewCashier({ host, seg }) {
  if (!ensureLogin(`/cashier/${seg[1] || ''}`)) return;
  const orderNo = seg[1] || '';
  if (!orderNo) {
    host.innerHTML = errorBox(new ApiError(400, 'BAD_REQUEST', '缺少订单号'), '链接不完整');
    bindRetry(host);
    return;
  }

  const orderResult = await withBusy(null, () => api('GET', `/api/orders/${encodeURIComponent(orderNo)}`));
  const orderDetail = orderResult.ok ? orderResult.value || {} : null;
  const order = orderDetail ? orderDetail.order || orderDetail : null;

  if (order && order.status && order.status !== 'pending') {
    const paid = order.status === 'paid' || order.status === 'completed';
    host.innerHTML = `
      <div class="pay-panel">
        <div class="${paid ? 'success-mark' : ''}">${paid ? '✓' : '⏳'}</div>
        <div class="pay-panel__label">${paid ? '该订单已支付' : '该订单不可支付'}</div>
        <div class="pay-panel__amount">${esc(yuanText(order, 'total'))}</div>
        <div class="pay-panel__no">订单号 ${esc(orderNo)} · ${esc(statusText(order))}</div>
      </div>
      <div class="card mt12">
        ${paid ? '<a class="btn btn--primary btn--block" href="#/courses">查看我的课程</a>' : ''}
        <a class="btn btn--ghost btn--block mt8" href="#/order/${encodeURIComponent(orderNo)}">查看订单详情</a>
        <a class="btn btn--ghost btn--block mt8" href="#/orders">返回订单列表</a>
      </div>`;
    return;
  }

  const payResult = await withBusy(null, () => api('POST', `/api/orders/${encodeURIComponent(orderNo)}/pay`, {}));
  const pay = payResult.ok ? payResult.value || {} : null;
  const outTradeNo =
    (pay && pay.payParams && pay.payParams.outTradeNo) || (pay && pay.payment && pay.payment.outTradeNo) || '';
  const provider = (pay && (pay.provider || (pay.payment && pay.payment.provider))) || 'mock';
  const isMock = provider === 'mock' || !!(pay && (pay.mock || (pay.payParams && pay.payParams.mock)));

  const amountText = yuanText(order || pay || {}, 'total') !== '—' ? yuanText(order || pay || {}, 'total') : yuanText(pay || {}, 'amount');

  host.innerHTML = `
    <div class="pay-panel">
      <div class="pay-panel__label">${order && order.status === 'paid' ? '已支付' : '待支付金额'}</div>
      <div class="pay-panel__amount">${esc(amountText)}</div>
      <div class="pay-panel__no">订单号 ${esc(orderNo)}</div>
    </div>
    <div class="card mt12">
      <div class="pay-method">
        <span class="pay-method__ico">￥</span>
        <div class="grow">
          <div class="pay-method__name">${isMock ? '模拟支付（本地演示）' : '微信支付'}</div>
          <div class="pay-method__desc">${isMock ? '点「我已支付」即刻到账，无需真实扣款' : '请在小程序内完成微信支付'}</div>
        </div>
      </div>
      ${
        outTradeNo
          ? `<div class="pay-state mt12"><span class="pay-state__dot"></span><span>正在等待支付结果…（每 2 秒自动刷新）</span></div>`
          : ''
      }
      ${payResult.ok ? '' : `<div class="muted small mt12">发起支付失败：${esc(payResult.error && payResult.error.message)}</div>`}
      <div class="mt12" id="cashier-actions">
        ${
          outTradeNo
            ? `<button class="btn btn--primary btn--block" type="button" id="paid-btn">我已支付</button>
               <button class="btn btn--line btn--block mt8" type="button" id="cancel-btn">取消订单</button>`
            : `<button class="btn btn--primary btn--block" type="button" id="retry-pay">重新发起支付</button>`
        }
        <a class="btn btn--ghost btn--block mt8" href="#/order/${encodeURIComponent(orderNo)}">查看订单详情</a>
      </div>
      <p class="muted small mt12">演示环境：支付成功后自动开通课程（我的课程里可见核销码）。</p>
    </div>`;

  let settled = false;

  async function markSuccess(payload) {
    if (settled) return;
    settled = true;
    clearTimers();
    const detail = payload || {};
    host.innerHTML = `
      <div class="pay-panel">
        <div class="success-mark">✓</div>
        <div class="pay-panel__label">支付成功</div>
        <div class="pay-panel__amount">${esc(amountText)}</div>
        <div class="pay-panel__no">订单号 ${esc(orderNo)}</div>
      </div>
      <div class="card mt12">
        <div class="row row--between"><span class="muted small">支付时间</span><span class="small">${esc(dateText(detail.paidAt) || '刚刚')}</span></div>
        <div class="row row--between mt8"><span class="muted small">交易号</span><span class="small mono">${esc(detail.transactionId || '—')}</span></div>
      </div>
      <div class="card mt12">
        <div class="strong">课程已开通</div>
        <p class="muted small mt4">去「我的课程」查看核销码与上课须知。</p>
        <a class="btn btn--primary btn--block mt12" href="#/courses">查看我的课程</a>
        <a class="btn btn--ghost btn--block mt8" href="#/order/${encodeURIComponent(orderNo)}">查看订单详情</a>
      </div>`;
    toast('支付成功，课程已开通', 'ok');
  }

  async function pollOnce() {
    if (!outTradeNo || settled) return;
    try {
      const status = await api('GET', `/api/pay/status/${encodeURIComponent(outTradeNo)}`);
      const paidState = String((status && status.status) || '').toLowerCase();
      const orderState = String((status && status.orderStatus) || '').toLowerCase();
      if (
        paidState === 'succeeded' ||
        paidState === 'success' ||
        paidState === 'paid' ||
        orderState === 'paid' ||
        orderState === 'completed'
      ) {
        await markSuccess(status);
      }
    } catch {
      /* 轮询失败静默重试 */
    }
  }

  if (outTradeNo) {
    addTimer(pollOnce, 2000);
    pollOnce();
  }

  const paidBtn = $('#paid-btn');
  if (paidBtn) {
    paidBtn.addEventListener('click', async () => {
      const result = await withBusy(paidBtn, () =>
        api('POST', '/api/pay/mock-notify', { outTradeNo, success: true })
      );
      if (!result.ok) return;
      toast('已通知后端确认支付', 'ok');
      await pollOnce();
    });
  }

  const retryPay = $('#retry-pay');
  if (retryPay) {
    retryPay.addEventListener('click', async () => {
      const result = await withBusy(retryPay, () => render());
      if (!result.ok) toast('重试失败，请刷新页面', 'error');
    });
  }

  const cancelBtn = $('#cancel-btn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', async () => {
      const result = await withBusy(cancelBtn, () =>
        api('POST', `/api/orders/${encodeURIComponent(orderNo)}/cancel`, { reason: '用户取消支付' })
      );
      if (!result.ok) return;
      toast('订单已取消', 'ok');
      go('/orders');
    });
  }
}

/* ------------------------------------------------------------------ *
 * 视图 · 订单列表
 * ------------------------------------------------------------------ */
async function viewOrders({ host, query }) {
  if (!ensureLogin('/orders')) return;
  const filters = [
    { key: '', label: '全部' },
    { key: 'pending', label: '待支付' },
    { key: 'paid', label: '已支付' },
    { key: 'refunding', label: '退款中' },
    { key: 'refunded', label: '已退款' },
  ];
  const active = query.get('status') || '';

  host.innerHTML = `
    <div class="chips olist-tabs">
      ${filters
        .map(
          (f) =>
            `<a class="chip${active === f.key ? ' is-active' : ''}" href="#/orders${f.key ? `?status=${f.key}` : ''}">${esc(f.label)}</a>`
        )
        .join('')}
    </div>
    <div id="olist">${skeletonGrid(3)}</div>`;

  const listHost = $('#olist');
  const params = new URLSearchParams({ page: '1', size: '20' });
  if (active) params.set('status', active);
  const result = await withBusy(null, () => api('GET', `/api/orders?${params.toString()}`));
  if (!result.ok) {
    listHost.innerHTML = errorBox(result.error, '/api/orders 尚未就绪');
    bindRetries(listHost);
    return;
  }
  const list = toList(result.value);
  if (!list.length) {
    listHost.innerHTML = emptyBox('🧾', '还没有订单', '挑一门喜欢的课，从今天开始练', '<a class="btn btn--primary btn--sm mt8" href="#/products">去选课</a>');
    return;
  }
  listHost.innerHTML = list.map(orderCard).join('');

  listHost.addEventListener('click', async (event) => {
    const payBtn = event.target.closest('[data-pay]');
    if (payBtn) {
      go(`/cashier/${encodeURIComponent(payBtn.dataset.pay)}`);
      return;
    }
    const refundBtn = event.target.closest('[data-refund]');
    if (refundBtn) {
      go(`/refund/${encodeURIComponent(refundBtn.dataset.refund)}`);
    }
  });
}

/* ------------------------------------------------------------------ *
 * 视图 · 订单详情
 * ------------------------------------------------------------------ */
function buildLocalTimeline(order) {
  if (!order) return [];
  const items = [{ label: '创建订单', time: order.createdAt }];
  if (order.paidAt) items.push({ label: '支付成功', time: order.paidAt });
  if (order.status === 'refunded' || order.status === 'partial_refunded') items.push({ label: '退款完成', time: order.updatedAt || '' });
  if (order.status === 'cancelled') items.push({ label: '订单已取消', time: order.updatedAt || '' });
  return items.filter((item) => item.time);
}

async function viewOrderDetail({ host, seg }) {
  if (!ensureLogin(`/order/${seg[1] || ''}`)) return;
  const orderNo = seg[1] || '';
  const result = await withBusy(null, () => api('GET', `/api/orders/${encodeURIComponent(orderNo)}`));
  if (!result.ok) {
    host.innerHTML = errorBox(result.error, '订单详情接口尚未就绪');
    bindRetry(host);
    return;
  }
  const detail = result.value || {};
  const order = detail.order || {};
  const items = Array.isArray(detail.items) ? detail.items : [];
  const payment = detail.payment || null;
  const entitlements = Array.isArray(detail.entitlements) ? detail.entitlements : [];
  const timeline = Array.isArray(detail.timeline) && detail.timeline.length
    ? detail.timeline.map((t) => ({
        label: t.label || t.title || t.name || t.status || '状态更新',
        time: t.at || t.time || t.createdAt || '',
        note: t.note || t.desc || '',
        done: t.done !== undefined ? !!t.done : true,
      }))
    : buildLocalTimeline(order);

  host.innerHTML = `
    <div class="card">
      <div class="row row--between">
        <span class="status ${statusClass(order.status)}">${esc(statusText(order))}</span>
        <span class="muted small">${esc(dateText(order.createdAt))}</span>
      </div>
      <div class="mono small muted mt8">${esc(order.orderNo || orderNo)}</div>
      ${
        order.expireAt && order.status === 'pending'
          ? `<div class="tag tag--warn mt8">请在 ${esc(dateText(order.expireAt))} 前完成支付</div>`
          : ''
      }
    </div>
    ${
      items.length
        ? `<div class="card">
            <div class="strong small">课程清单</div>
            ${items
              .map(
                (item) => `
              <div class="list-row">
                <div class="list-row__main">
                  <div class="list-row__title">${esc(item.title || item.productTitle || '课程')}</div>
                  <div class="list-row__sub">${esc(dateText(item.createdAt, false) === '—' ? '' : '')}数量 × ${esc(item.quantity || 1)}</div>
                </div>
                <div class="list-row__amt price">${esc(yuanText(item, 'price'))}</div>
              </div>`
              )
              .join('')}
          </div>`
        : ''
    }
    <div class="card">
      <div class="summary">
        <div class="summary__row"><span class="muted">订单金额</span><span class="price">${esc(yuanText(order, 'total'))}</span></div>
        <div class="summary__row"><span class="muted">实付金额</span><span>${esc(yuanText(order, 'paid'))}</span></div>
        <div class="summary__row"><span class="muted">已退金额</span><span>${esc(yuanText(order, 'refunded'))}</span></div>
        ${payment ? `<div class="summary__row"><span class="muted">支付方式</span><span>${esc(payment.provider || 'mock')}</span></div>` : ''}
        ${payment && payment.paidAt ? `<div class="summary__row"><span class="muted">支付时间</span><span>${esc(dateText(payment.paidAt))}</span></div>` : ''}
      </div>
    </div>
    ${
      detail.refund
        ? `<div class="card">
            <div class="row row--between">
              <span class="strong small">退款进度</span>
              <span class="status ${statusClass(detail.refund.status, REFUND_STATUS_CLASS)}">${esc(detail.refund.statusText || REFUND_STATUS[detail.refund.status] || detail.refund.status || '')}</span>
            </div>
            <div class="info-row"><span class="info-row__k">退款单号</span><span class="info-row__v mono">${esc(detail.refund.refundNo || '—')}</span></div>
            <div class="info-row"><span class="info-row__k">退款金额</span><span class="info-row__v price">${esc(yuanText(detail.refund, 'amount'))}</span></div>
            <div class="info-row"><span class="info-row__k">退款原因</span><span class="info-row__v">${esc(detail.refund.reason || '—')}</span></div>
            <div class="info-row"><span class="info-row__k">申请时间</span><span class="info-row__v">${esc(dateText(detail.refund.createdAt))}</span></div>
            ${
              detail.refund.reviewNote
                ? `<div class="info-row"><span class="info-row__k">审核备注</span><span class="info-row__v">${esc(detail.refund.reviewNote)}</span></div>`
                : ''
            }
          </div>`
        : ''
    }
    ${
      entitlements.length
        ? `<div class="card">
            <div class="strong small">已开通课程</div>
            ${entitlements
              .map(
                (ent) => `
              <div class="list-row">
                <div class="list-row__main">
                  <div class="list-row__title">${esc(ent.title || '课程')}</div>
                  <div class="list-row__sub">核销码 <span class="mono">${esc(ent.verifyCode || '—')}</span> · ${esc(ent.statusText || (ent.status === 'revoked' ? '已失效' : '有效'))}</div>
                </div>
                <a class="btn btn--ghost btn--xs" href="#/courses">查看</a>
              </div>`
              )
              .join('')}
          </div>`
        : ''
    }
    ${
      timeline.length
        ? `<div class="card">
            <div class="strong small">订单进度</div>
            <div class="timeline">
              ${timeline
                .map(
                  (t) => `
                <div class="timeline__item${t.done ? ' is-done' : ''}">
                  <span class="timeline__dot"></span>
                  <div class="timeline__label">${esc(t.label)}</div>
                  ${t.note ? `<div class="small muted">${esc(t.note)}</div>` : ''}
                  <div class="timeline__time">${esc(dateText(t.time))}</div>
                </div>`
                )
                .join('')}
            </div>
          </div>`
        : ''
    }
    <div class="card">
      ${detail.canPay ? '<button class="btn btn--primary btn--block" type="button" data-act="pay">去支付</button>' : ''}
      ${detail.canCancel ? '<button class="btn btn--line btn--block mt8" type="button" data-act="cancel">取消订单</button>' : ''}
      ${detail.canRefund ? '<button class="btn btn--danger btn--block mt8" type="button" data-act="refund">申请退款</button>' : ''}
      ${order.status === 'paid' ? '<button class="btn btn--ghost btn--block mt8" type="button" data-act="confirm">确认已完成</button>' : ''}
      ${!detail.canPay && !detail.canCancel && !detail.canRefund ? '<p class="muted small center">当前状态暂无可执行操作</p>' : ''}
    </div>`;

  host.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'pay') {
      go(`/cashier/${encodeURIComponent(orderNo)}`);
      return;
    }
    if (act === 'refund') {
      go(`/refund/${encodeURIComponent(orderNo)}`);
      return;
    }
    const pathMap = { cancel: '/cancel', confirm: '/confirm' };
    const bodyMap = { cancel: { reason: '用户主动取消' }, confirm: {} };
    const result2 = await withBusy(btn, () =>
      api('POST', `/api/orders/${encodeURIComponent(orderNo)}${pathMap[act]}`, bodyMap[act])
    );
    if (!result2.ok) return;
    toast(act === 'cancel' ? '订单已取消' : '已确认完成', 'ok');
    render();
  });
}

/* ------------------------------------------------------------------ *
 * 视图 · 申请退款
 * ------------------------------------------------------------------ */
async function viewRefund({ host, seg }) {
  if (!ensureLogin(`/refund/${seg[1] || ''}`)) return;
  const orderNo = seg[1] || '';
  const reasons = [
    { key: 'quality', label: '课程内容与预期不符' },
    { key: 'schedule_conflict', label: '时间冲突无法上课' },
    { key: 'wrong_purchase', label: '买错课程' },
    { key: 'duplicate', label: '重复购买' },
    { key: 'other', label: '其他原因' },
  ];
  let order = null;
  const detail = await withBusy(null, () => api('GET', `/api/orders/${encodeURIComponent(orderNo)}`));
  if (detail.ok) order = (detail.value && detail.value.order) || null;

  host.innerHTML = `
    <div class="card">
      <div class="row row--between">
        <span class="muted small">订单号</span>
        <span class="mono small">${esc(orderNo)}</span>
      </div>
      <div class="row row--between mt8">
        <span class="muted small">订单金额</span>
        <span class="price">${esc(yuanText(order, 'total'))}</span>
      </div>
      <div class="row row--between mt8">
        <span class="muted small">可退金额</span>
        <span class="price">${esc(yuanText(order, 'refundable') === '—' ? yuanText(order, 'total') : yuanText(order, 'refundable'))}</span>
      </div>
      ${
        order && order.hasPendingRefund
          ? '<div class="notice notice--warn mt8">该订单已有待处理的退款申请，请在订单详情查看进度。</div>'
          : ''
      }
    </div>
    <div class="card">
      <div class="strong small">退款原因</div>
      <div class="chips mt8" id="reason-chips">
        ${reasons
          .map(
            (r, i) =>
              `<button class="chip${i === 0 ? ' is-active' : ''}" type="button" data-reason-key="${esc(r.key)}" data-reason-label="${esc(r.label)}">${esc(r.label)}</button>`
          )
          .join('')}
      </div>
      <label class="field mt12">
        <span class="field__label">补充说明（可选）</span>
        <textarea class="textarea" id="reason-text" maxlength="200" placeholder="说明一下具体情况，客服处理更快"></textarea>
      </label>
      <label class="field" style="margin-bottom:0">
        <span class="field__label">退款金额（元，留空视为全额退款）</span>
        <input class="input" id="refund-amount" inputmode="decimal" placeholder="例如 99.00" />
      </label>
      <p class="muted small mt8">未开课/未观看的课程 7 天内可申请退款；AI 自动审核额度内的退款会立即通过。</p>
    </div>
    <button class="btn btn--primary btn--block" type="button" id="refund-submit"${order && order.canRefund === false ? ' disabled' : ''}>${
      order && order.canRefund === false ? '当前订单不可申请退款' : '提交退款申请'
    }</button>
    <div id="refund-result" class="mt12"></div>`;

  let selectedReason = reasons[0];
  $('#reason-chips').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-reason-key]');
    if (!btn) return;
    $('#reason-chips').querySelectorAll('[data-reason-key]').forEach((node) => node.classList.remove('is-active'));
    btn.classList.add('is-active');
    selectedReason = { key: btn.dataset.reasonKey, label: btn.dataset.reasonLabel };
  });

  $('#refund-submit').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    const extra = $('#reason-text').value.trim();
    const reason = (extra ? `${selectedReason.label}：${extra}` : selectedReason.label).slice(0, 100);
    const amountCents = yuanToCents($('#refund-amount').value);
    const body = { reason, reasonType: selectedReason.key };
    if (amountCents !== null && amountCents > 0) body.amountCents = amountCents;

    const result = await withBusy(btn, () => api('POST', `/api/orders/${encodeURIComponent(orderNo)}/refund`, body));
    if (!result.ok) {
      $('#refund-result').innerHTML = errorBox(result.error, '退款接口尚未就绪时会出现该提示');
      bindRetries($('#refund-result'));
      return;
    }
    const data = result.value || {};
    const nextActionText =
      data.nextAction === 'wait_review'
        ? '已进入人工审核，审核结果会在订单里更新'
        : data.nextAction === 'contact_service'
          ? '请前往在线客服补充材料'
          : '无需额外交互';
    $('#refund-result').innerHTML = `
      <div class="card">
        <div class="row row--between">
          <span class="strong">退款申请已提交</span>
          <span class="tag ${data.autoApproved ? 'tag--ok' : 'tag--warn'}">${data.autoApproved ? '自动通过' : '待审核'}</span>
        </div>
        <div class="info-list">
          <div class="info-row"><span class="info-row__k">退款单号</span><span class="info-row__v mono">${esc(data.refundNo || '—')}</span></div>
          <div class="info-row"><span class="info-row__k">退款金额</span><span class="info-row__v price">${esc(yuanText(data, 'amount') !== '—' ? yuanText(data, 'amount') : yuanText(order, 'total'))}</span></div>
          <div class="info-row"><span class="info-row__k">当前状态</span><span class="info-row__v">${esc(data.statusText || REFUND_STATUS[data.status] || data.status || '—')}</span></div>
          <div class="info-row"><span class="info-row__k">后续</span><span class="info-row__v">${esc(nextActionText)}</span></div>
        </div>
        ${data.message ? `<p class="muted small mt8">${esc(data.message)}</p>` : ''}
        <a class="btn btn--primary btn--block mt12" href="#/order/${encodeURIComponent(data.orderNo || orderNo)}">查看订单</a>
        <a class="btn btn--ghost btn--block mt8" href="#/service">联系客服</a>
      </div>`;
    toast('退款申请已提交', 'ok');
    $('#refund-submit').disabled = true;
  });
}

/* ------------------------------------------------------------------ *
 * 视图 · 我的课程
 * ------------------------------------------------------------------ */
async function viewCourses({ host }) {
  if (!ensureLogin('/courses')) return;
  const result = await withBusy(null, () => api('GET', '/api/my/entitlements'));
  if (!result.ok) {
    host.innerHTML = errorBox(result.error, '/api/my/entitlements 尚未就绪');
    bindRetry(host);
    return;
  }
  const list = toList(result.value);
  if (!list.length) {
    host.innerHTML = emptyBox(
      '📚',
      '还没有课程',
      '购买后课程会立刻出现在这里，核销码用于到店上课',
      '<a class="btn btn--primary btn--sm mt8" href="#/products">去选课</a>'
    );
    return;
  }
  host.innerHTML = `
    <div class="card card--soft">
      <div class="strong">我的课程 ${esc(list.length)} 门</div>
      <p class="muted small mt4">线上课程永久回看；到店课程请向店员出示核销码。</p>
    </div>
    <div class="mt12">
      ${list
        .map(
          (ent) => `
        <div class="ent" data-ent="${esc(ent.id || '')}">
          <div class="ent__img"><img src="${esc(coverOf(ent))}" alt="" /></div>
          <div class="grow">
            <div class="ent__title">${esc(ent.title || '课程')}</div>
            <div class="ent__meta">${esc(typeText(ent.type))}${ent.expiresAt ? ` · ${esc(dateText(ent.expiresAt, false))} 到期` : ' · 长期有效'}</div>
            ${ent.verifyCode ? `<div class="ent__code">核销码 <span class="mono">${esc(ent.verifyCode)}</span></div>` : ''}
            <div class="ent__meta">${esc(ent.statusText || (ent.status === 'revoked' ? '已失效' : '有效'))}${
              ent.orderNo ? ` · ${esc(ent.orderNo)}` : ''
            }</div>
          </div>
        </div>`
        )
        .join('')}
    </div>`;

  host.addEventListener('click', async (event) => {
    const card = event.target.closest('[data-ent]');
    if (!card || !card.dataset.ent) return;
    const body = openModal('课程详情', '<div class="inline-loading"><span class="spin"></span>加载中…</div>');
    if (!body) return;
    const detail = await api('GET', `/api/my/entitlements/${encodeURIComponent(card.dataset.ent)}`).catch((err) => ({ __error: err }));
    if (detail && detail.__error) {
      body.innerHTML = errorBox(detail.__error, '课程详情接口未就绪，可在列表查看核销码');
      bindRetries(body);
      return;
    }
    const ent = (detail && detail.entitlement) || detail || {};
    body.innerHTML = `
      <div class="verify">
        <div class="small" style="opacity:.8">到店核销码</div>
        <div class="verify__code">${esc(ent.verifyCode || '—')}</div>
        <div class="verify__hint">出示给店员即可核销 · 线上课程无需核销</div>
      </div>
      <div class="info-list mt12">
        <div class="info-row"><span class="info-row__k">课程</span><span class="info-row__v">${esc(ent.title || '')}</span></div>
        <div class="info-row"><span class="info-row__k">类型</span><span class="info-row__v">${esc(typeText(ent.type))}</span></div>
        <div class="info-row"><span class="info-row__k">开通时间</span><span class="info-row__v">${esc(dateText(ent.grantedAt))}</span></div>
        <div class="info-row"><span class="info-row__k">有效期</span><span class="info-row__v">${ent.expiresAt ? esc(dateText(ent.expiresAt, false)) : '长期有效'}</span></div>
        ${ent.orderNo ? `<div class="info-row"><span class="info-row__k">来源订单</span><span class="info-row__v mono">${esc(ent.orderNo)}</span></div>` : ''}
      </div>
      ${
        ent.notice || ent.noticeHtml
          ? `<div class="card card--soft mt12"><div class="strong small">上课须知</div><div class="small mt4">${ent.noticeHtml || esc(ent.notice)}</div></div>`
          : `<div class="card card--soft mt12"><div class="strong small">上课须知</div><p class="muted small mt4">请提前 10 分钟入场；到店课程请带好运动毛巾与水。课程开始前可在订单页申请退款。</p></div>`
      }`;
  });
}

/* ------------------------------------------------------------------ *
 * 视图 · 分销中心
 * ------------------------------------------------------------------ */
async function viewDist({ host, query }) {
  if (!ensureLogin('/dist')) return;

  const overview = await withBusy(null, () => api('GET', '/api/dist/overview'));
  if (!overview.ok) {
    host.innerHTML = errorBox(overview.error, '/api/dist/overview 尚未就绪');
    bindRetry(host);
    return;
  }
  const data = overview.value || {};
  const balance = data.balance || {};
  const isDist = !!data.isDistributor;
  const inviteCode = data.inviteCode || (state.me && state.me.inviteCode) || '';
  const inviteUrl = data.inviteUrl || (inviteCode ? `${location.origin}/#/join?code=${inviteCode}` : '');

  host.innerHTML = `
    <div class="card card--soft">
      <div class="row row--between">
        <div>
          <div class="strong">${isDist ? '二级分销中心' : '开通分销赚佣金'}</div>
          <div class="muted small mt4">${isDist ? `我的邀请码 ${esc(inviteCode || '—')}` : '开通后可生成专属邀请码'}</div>
        </div>
        ${isDist ? `<span class="tag tag--ok">已开通</span>` : `<button class="btn btn--accent btn--sm" type="button" id="enable-dist">立即开通</button>`}
      </div>
      ${isDist && inviteUrl ? `<p class="muted small mt8" style="word-break:break-all">${esc(inviteUrl)}</p>
        <button class="btn btn--line btn--sm mt8" type="button" id="copy-invite">复制邀请链接</button>` : ''}
    </div>
    <div class="stat-grid mt12">
      <div class="stat"><div class="stat__num stat__num--accent">${esc(yuanCents(balance.availableCents || 0))}</div><div class="stat__label">可提现</div></div>
      <div class="stat"><div class="stat__num">${esc(yuanCents(balance.pendingCents || 0))}</div><div class="stat__label">待结算</div></div>
      <div class="stat"><div class="stat__num">${esc(data.teamSize === undefined ? '—' : data.teamSize)}</div><div class="stat__label">一级团队</div></div>
    </div>
    <div class="card mt12">
      <div class="row row--between">
        <div><div class="strong small">今日</div><div class="muted small">佣金 ${esc(yuanText(data.today || {}, 'commission'))} · ${esc((data.today && data.today.orders) || 0)} 单</div></div>
        <div class="center"><div class="strong small">${esc(data.teamSizeL2 === undefined ? '—' : data.teamSizeL2)}</div><div class="muted small">二级团队</div></div>
      </div>
    </div>
    <div class="card mt12">
      <div class="seg" id="dist-seg">
        <button class="seg__item is-active" type="button" data-panel="team">团队</button>
        <button class="seg__item" type="button" data-panel="commission">佣金</button>
        <button class="seg__item" type="button" data-panel="withdraw">提现</button>
      </div>
      <div id="dist-panel" class="mt12"></div>
    </div>
    <div class="card mt12">
      <div class="strong small">绑定上级邀请码</div>
      <div class="row mt8">
        <input class="input" id="bind-code" placeholder="输入好友邀请码，例如 DEMOA" value="${esc(query.get('code') || '')}" />
        <button class="btn btn--ghost btn--sm" type="button" id="bind-btn">绑定</button>
      </div>
      <p class="muted small mt8">每位用户只能绑定一次上级，绑定后不可更改。</p>
    </div>
    <p class="muted small center mt16">一级佣金 ${esc(data.commissionL1Bps ? `${Math.round(data.commissionL1Bps / 100)}%` : '按后台设置')} · 佣金冻结后到期自动可提现</p>`;

  const enableBtn = $('#enable-dist');
  if (enableBtn) {
    enableBtn.addEventListener('click', async () => {
      const result = await withBusy(enableBtn, () => api('POST', '/api/dist/enable', {}));
      if (!result.ok) return;
      toast('分销已开通', 'ok');
      render();
    });
  }

  const copyBtn = $('#copy-invite');
  if (copyBtn && inviteUrl) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(inviteUrl);
        toast('邀请链接已复制', 'ok');
      } catch {
        toast('复制失败，请手动长按选择链接');
      }
    });
  }

  const bindBtn = $('#bind-btn');
  if (bindBtn) {
    bindBtn.addEventListener('click', async () => {
      const code = $('#bind-code').value.trim();
      if (!code) {
        toast('请输入邀请码');
        return;
      }
      const result = await withBusy(bindBtn, () => api('POST', '/api/dist/bind', { inviteCode: code }));
      if (!result.ok) return;
      toast('绑定成功', 'ok');
      render();
    });
  }

  const panel = $('#dist-panel');
  const seg = $('#dist-seg');

  async function loadPanel(kind) {
    seg.querySelectorAll('[data-panel]').forEach((b) => b.classList.toggle('is-active', b.dataset.panel === kind));
    panel.innerHTML = '<div class="inline-loading"><span class="spin"></span>加载中…</div>';
    if (kind === 'team') {
      const result = await withBusy(null, () => api('GET', '/api/dist/team?level=1'));
      if (!result.ok) {
        panel.innerHTML = errorBox(result.error, '/api/dist/team 尚未就绪');
        bindRetries(panel);
        return;
      }
      const list = toList(result.value);
      panel.innerHTML = list.length
        ? list
            .map(
              (m) => `
          <div class="list-row">
            <span class="avatar">${esc(String(m.nickname || m.name || '学').slice(0, 1))}</span>
            <div class="list-row__main">
              <div class="list-row__title">${esc(m.nickname || m.name || '学员')}</div>
              <div class="list-row__sub">${esc(dateText(m.joinedAt || m.createdAt, false))} 加入 · 贡献 ${esc(m.orderCount || m.orders || 0)} 单</div>
            </div>
            <span class="list-row__amt price">${esc(yuanText(m, 'commission'))}</span>
          </div>`
            )
            .join('')
        : emptyBox('👥', '还没有团队成员', '把邀请链接发给好友，他们下单你就有佣金');
      return;
    }
    if (kind === 'commission') {
      const result = await withBusy(null, () => api('GET', '/api/dist/commissions'));
      if (!result.ok) {
        panel.innerHTML = errorBox(result.error, '/api/dist/commissions 尚未就绪');
        bindRetries(panel);
        return;
      }
      const list = toList(result.value);
      panel.innerHTML = list.length
        ? list
            .map(
              (c) => `
          <div class="list-row">
            <div class="list-row__main">
              <div class="list-row__title">${esc(c.title || c.productTitle || `L${c.level || 1} 佣金`)}</div>
              <div class="list-row__sub">${esc(c.type === 'reverse' ? '退款冲正' : c.type === 'adjust' ? '手工调整' : '佣金入账')} · ${esc(dateText(c.createdAt))}</div>
            </div>
            <div class="center">
              <div class="list-row__amt price">${esc(yuanText(c, 'amount'))}</div>
              <div class="muted small">${esc(c.statusText || (c.status === 'available' ? '可提现' : c.status === 'pending' ? '冻结中' : c.status === 'cancelled' ? '已取消' : c.status || ''))}</div>
            </div>
          </div>`
            )
            .join('')
        : emptyBox('💰', '还没有佣金记录', '团队下单后这里会出现佣金流水');
      return;
    }
    const result = await withBusy(null, () => api('GET', '/api/dist/withdrawals'));
    if (!result.ok) {
      panel.innerHTML = errorBox(result.error, '/api/dist/withdrawals 尚未就绪');
      bindRetries(panel);
      return;
    }
    const list = toList(result.value);
    panel.innerHTML = `
      <div class="row">
        <input class="input" id="wd-amount" inputmode="decimal" placeholder="提现金额（元）" />
        <button class="btn btn--primary btn--sm" type="button" id="wd-btn">申请</button>
      </div>
      <p class="muted small mt8">最低提现 ${esc(balance.minWithdrawText || '10.00')} 元，仅可提现「可提现」余额。</p>
      <div class="mt8">
        ${
          list.length
            ? list
                .map(
                  (w) => `
            <div class="list-row">
              <div class="list-row__main">
                <div class="list-row__title price">${esc(yuanText(w, 'amount'))}</div>
                <div class="list-row__sub">${esc(dateText(w.createdAt))} · ${esc(w.reason || '提现申请')}</div>
              </div>
              <span class="tag ${w.status === 'paid' ? 'tag--ok' : w.status === 'rejected' ? 'tag--danger' : 'tag--warn'}">${esc(w.statusText || WITHDRAW_STATUS[w.status] || w.status || '')}</span>
            </div>`
                )
                .join('')
            : emptyBox('🏦', '还没有提现记录', '佣金解冻后可申请提现')
        }
      </div>`;

    const wdBtn = $('#wd-btn');
    if (wdBtn) {
      wdBtn.addEventListener('click', async () => {
        const amountCents = yuanToCents($('#wd-amount').value);
        if (!amountCents || amountCents <= 0) {
          toast('请输入正确的提现金额');
          return;
        }
        const result2 = await withBusy(wdBtn, () => api('POST', '/api/dist/withdrawals', { amountCents }));
        if (!result2.ok) return;
        toast('提现申请已提交', 'ok');
        loadPanel('withdraw');
      });
    }
  }

  seg.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-panel]');
    if (btn) loadPanel(btn.dataset.panel);
  });

  await loadPanel('team');
}

/* ------------------------------------------------------------------ *
 * 视图 · 在线客服
 * ------------------------------------------------------------------ */
async function viewService({ host }) {
  if (!ensureLogin('/service')) return;

  host.innerHTML = chatShell({
    icon: '🎧',
    title: '在线客服',
    sub: '课程 / 订单 / 退款都可以问',
    tools: '<button class="btn btn--ghost btn--xs" type="button" id="svc-close">结束会话</button>',
  });

  const inner = $('#chat-inner');
  const foot = $('#chat-foot');

  inner.innerHTML = '<div class="inline-loading"><span class="spin"></span>正在接入客服…</div>';

  const result = await withBusy(null, () => api('GET', '/api/service/conversation'));
  if (!result.ok) {
    inner.innerHTML = errorBox(result.error, '/api/service/conversation 尚未就绪');
    bindRetries(inner);
    foot.innerHTML = '<div class="composer"><textarea class="composer__input" disabled placeholder="客服接口未就绪"></textarea><button class="composer__send" disabled>发送</button></div>';
    return;
  }
  const data = result.value || {};
  const conversation = data.conversation || {};
  let messages = Array.isArray(data.messages) ? data.messages : [];
  const quickReplies = Array.isArray(data.quickReplies) ? data.quickReplies : [];
  const seen = new Set(messages.map((m) => m.id).filter(Boolean));

  const msgHtml = (msg) => {
    const type = msg.senderType || (msg.role === 'user' ? 'user' : 'ai');
    const cls = type === 'user' ? 'msg--me' : type === 'system' ? 'msg--system' : 'msg--ai';
    const who = type === 'user' ? '我' : type === 'admin' ? '客服' : type === 'system' ? '' : '客服助手';
    return `
      <div class="msg ${cls}">
        ${who ? `<div class="msg__who">${esc(who)}</div>` : ''}
        <div class="msg__bubble">${esc(msg.content || '')}</div>
        <div class="msg__time">${esc(timeText(msg.createdAt))}</div>
      </div>`;
  };

  const paint = () => {
    const welcome = data.welcome
      ? `<div class="msg msg--system"><div class="msg__bubble">${esc(data.welcome)}</div></div>`
      : '';
    inner.innerHTML = welcome + messages.map(msgHtml).join('');
    scrollChat();
  };

  paint();

  let lastAt = messages.length ? messages[messages.length - 1].createdAt || '' : '';

  const markSeen = (list) => {
    const fresh = [];
    list.forEach((msg) => {
      const key = msg.id || `${msg.createdAt}|${msg.content}`;
      if (seen.has(key)) return;
      seen.add(key);
      fresh.push(msg);
    });
    return fresh;
  };
  messages.forEach((m) => seen.add(m.id || `${m.createdAt}|${m.content}`));

  foot.innerHTML = `
    ${quickReplies.length ? `<div class="quick" id="svc-quick">${quickReplies.map((q) => `<button class="quick__item" type="button" data-q="${esc(q.content || q.title || '')}">${esc(q.title || q.content || '')}</button>`).join('')}</div>` : ''}
    <div class="composer">
      <textarea class="composer__input" id="svc-input" rows="1" placeholder="输入消息…"></textarea>
      <button class="composer__send" type="button" id="svc-send">发送</button>
    </div>`;

  const input = $('#svc-input');
  const sendBtn = $('#svc-send');

  const appendMessages = (fresh) => {
    if (!fresh.length) return;
    inner.insertAdjacentHTML('beforeend', fresh.map(msgHtml).join(''));
    scrollChat();
  };

  async function send(content) {
    const text = String(content || '').trim();
    if (!text) return;
    const sendResult = await withBusy(sendBtn, () =>
      api('POST', '/api/service/messages', { content: text, msgType: 'text' })
    );
    if (!sendResult.ok) return;
    const payload = sendResult.value || {};
    const fresh = [];
    if (payload.message) fresh.push(payload.message);
    if (payload.autoReply) fresh.push(payload.autoReply);
    const added = markSeen(fresh);
    appendMessages(added);
    if (payload.message && payload.message.createdAt) lastAt = payload.message.createdAt;
    input.value = '';
  }

  sendBtn.addEventListener('click', () => send(input.value));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send(input.value);
    }
  });

  const quick = $('#svc-quick');
  if (quick) {
    quick.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-q]');
      if (btn) send(btn.dataset.q);
    });
  }

  $('#svc-close').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    const closeResult = await withBusy(btn, () => api('POST', '/api/service/conversation/close', {}));
    if (!closeResult.ok) return;
    toast('会话已结束', 'ok');
    render();
  });

  addTimer(async () => {
    try {
      const params = lastAt ? `?after=${encodeURIComponent(lastAt)}` : '';
      const poll = await api('GET', `/api/service/messages${params}`);
      const list = (poll && Array.isArray(poll.messages) ? poll.messages : []).slice();
      if (!list.length) return;
      const fresh = markSeen(list);
      lastAt = list[list.length - 1].createdAt || lastAt;
      appendMessages(fresh);
    } catch {
      /* 轮询失败静默 */
    }
  }, 4000);

  if (conversation.status === 'closed') {
    input.disabled = true;
    sendBtn.disabled = true;
    inner.insertAdjacentHTML('beforeend', '<div class="msg msg--system"><div class="msg__bubble">会话已结束</div></div>');
  }
}

/* ------------------------------------------------------------------ *
 * 视图 · AI 商城对话
 * ------------------------------------------------------------------ */
function aiCardHtml(card) {
  if (!card || !card.type) return '';
  if (card.type === 'product') {
    const href = `#/product/${encodeURIComponent(card.productId || '')}`;
    return `
      <a class="gcard" href="${href}">
        <div class="gcard__img"><img src="${esc(card.cover || coverOf(card))}" alt="" /></div>
        <div class="grow">
          <div class="gcard__title">${esc(card.title || '课程')}</div>
          <div class="gcard__sub">${esc(card.subtitle || '')}</div>
          ${Array.isArray(card.tags) && card.tags.length ? `<div class="gcard__sub">${esc(card.tags.join(' · '))}</div>` : ''}
          <div class="gcard__price">${esc(yuanText(card, 'price'))}</div>
        </div>
      </a>`;
  }
  if (card.type === 'order') {
    return `
      <a class="gcard gcard--plain" href="#/order/${encodeURIComponent(card.orderNo || '')}">
        <div class="gcard__head"><span>订单 ${esc(card.orderNo || '')}</span><span>${esc(card.statusText || ORDER_STATUS[card.status] || card.status || '')}</span></div>
        <div class="gcard__kv mt4"><span class="muted">金额</span><span class="price">${esc(yuanText(card, 'total'))}</span></div>
        ${card.payExpireAt ? `<div class="gcard__kv mt4"><span class="muted">请在</span><span>${esc(dateText(card.payExpireAt))} 前支付</span></div>` : ''}
      </a>`;
  }
  if (card.type === 'pay') {
    return `
      <div class="gcard gcard--plain">
        <div class="gcard__head"><span>收银台</span><span>${esc(card.provider === 'mock' || card.mock ? '模拟支付' : '微信支付')}</span></div>
        <div class="gcard__kv mt4"><span class="muted">应付</span><span class="price">${esc(yuanText(card, 'amount'))}</span></div>
        ${card.orderNo ? `<a class="btn btn--accent btn--sm btn--block mt8" href="#/cashier/${encodeURIComponent(card.orderNo)}">去收银台</a>` : ''}
      </div>`;
  }
  if (card.type === 'refund') {
    return `
      <div class="gcard gcard--plain">
        <div class="gcard__head"><span>退款单 ${esc(card.refundNo || '')}</span><span>${esc(card.statusText || REFUND_STATUS[card.status] || card.status || '')}</span></div>
        <div class="gcard__kv mt4"><span class="muted">金额</span><span class="price">${esc(yuanText(card, 'amount'))}</span></div>
        ${card.message ? `<div class="gcard__sub mt4">${esc(card.message)}</div>` : ''}
      </div>`;
  }
  if (card.type === 'entitlement') {
    return `
      <div class="gcard gcard--plain">
        <div class="gcard__head"><span>已开通</span><span>${esc(card.title || '')}</span></div>
        <div class="gcard__kv mt4"><span class="muted">核销码</span><span class="mono">${esc(card.verifyCode || '—')}</span></div>
        <a class="btn btn--ghost btn--sm btn--block mt8" href="#/courses">查看我的课程</a>
      </div>`;
  }
  return `<div class="gcard gcard--plain"><div class="gcard__sub">${esc(card.text || card.content || '')}</div></div>`;
}

function aiMessageHtml(msg) {
  const isUser = msg.role === 'user';
  const cards = Array.isArray(msg.cards) ? msg.cards : [];
  const actions = Array.isArray(msg.actions) ? msg.actions : [];
  return `
    <div class="msg ${isUser ? 'msg--me' : 'msg--ai'}">
      <div class="msg__who">${isUser ? '我' : 'AI 顾问'}</div>
      ${msg.content ? `<div class="msg__bubble">${esc(msg.content)}</div>` : ''}
      ${cards.length ? `<div class="msg__attach">${cards.map(aiCardHtml).join('')}</div>` : ''}
      ${
        actions.length
          ? `<div class="acts">${actions
              .map(
                (a, i) =>
                  `<button class="act${/pay|order/i.test(a.action || '') ? ' act--accent' : ''}" type="button"
                    data-ai-action="${esc(a.action || '')}" data-ai-payload="${esc(JSON.stringify(a.payload || {}))}"
                    data-ai-label="${esc(a.label || '')}" data-idx="${i}">${esc(a.label || a.action || '执行')}</button>`
              )
              .join('')}</div>`
          : ''
      }
      <div class="msg__time">${esc(timeText(msg.createdAt))}</div>
    </div>`;
}

async function viewAi({ host }) {
  if (!ensureLogin('/ai')) return;

  host.innerHTML = chatShell({
    icon: '✨',
    title: 'AI 课程顾问',
    sub: AI_INTENT_HINT,
    tools: '<button class="btn btn--ghost btn--xs" type="button" id="ai-reset">新会话</button>',
  });

  const inner = $('#chat-inner');
  const foot = $('#chat-foot');
  inner.innerHTML = '<div class="inline-loading"><span class="spin"></span>正在唤醒 AI 顾问…</div>';
  foot.innerHTML = '<div class="composer"><textarea class="composer__input" disabled placeholder="AI 服务连接中…"></textarea><button class="composer__send" disabled>发送</button></div>';

  const boot = await withBusy(null, () => api('POST', '/api/ai/session', {}));
  if (!boot.ok) {
    inner.innerHTML = errorBox(boot.error, '/api/ai/session 尚未就绪，AI 商城上线后自动可用');
    bindRetries(inner);
    return;
  }
  const session = boot.value || {};
  const sessionId = session.sessionId || session.id || '';
  let messages = Array.isArray(session.messages) ? session.messages : [];
  let aiState = session.state || {};
  let pending = false;

  const suggestionPayload = await api('GET', '/api/ai/suggestions').catch(() => null);
  const suggestionList = Array.isArray(suggestionPayload)
    ? suggestionPayload
    : (suggestionPayload && Array.isArray(suggestionPayload.suggestions) ? suggestionPayload.suggestions : []);
  const quickList = suggestionList.length
    ? suggestionList.slice(0, 6)
    : ['我想减脂，推荐课程', '我的订单在哪', '怎么退款', '怎么赚佣金'];

  const paint = () => {
    inner.innerHTML = messages.length
      ? messages.map(aiMessageHtml).join('')
      : `<div class="msg msg--ai"><div class="msg__who">AI 顾问</div><div class="msg__bubble">你好，我是瑜伽馆的 AI 顾问 🧘\n告诉我你的目标（减脂 / 塑形 / 肩颈不舒服 / 孕产），我来推荐课程，也可以直接下单和退款。</div></div>`;
    scrollChat();
  };

  foot.innerHTML = `
    <div class="quick" id="ai-quick">${quickList.map((q) => `<button class="quick__item" type="button" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>
    <div class="composer">
      <textarea class="composer__input" id="ai-input" rows="1" placeholder="说点什么，比如「我想减脂」"></textarea>
      <button class="composer__send" type="button" id="ai-send">发送</button>
    </div>`;

  const input = $('#ai-input');
  const sendBtn = $('#ai-send');

  paint();

  const showTyping = () => {
    inner.insertAdjacentHTML(
      'beforeend',
      '<div class="msg msg--ai" id="ai-typing"><div class="typing"><i></i><i></i><i></i></div></div>'
    );
    scrollChat();
  };
  const hideTyping = () => {
    const node = $('#ai-typing');
    if (node) node.remove();
  };

  const appendMessage = (msg) => {
    if (!msg) return;
    messages.push(msg);
    const html = aiMessageHtml(msg);
    hideTyping();
    inner.insertAdjacentHTML('beforeend', html);
    scrollChat();
  };

  async function send(text) {
    const content = String(text || '').trim();
    if (!content || pending) return;
    pending = true;
    sendBtn.disabled = true;
    const userMsg = { role: 'user', content, createdAt: new Date().toISOString() };
    appendMessage(userMsg);
    input.value = '';
    showTyping();
    try {
      const reply = await api('POST', '/api/ai/chat', { sessionId, text: content });
      hideTyping();
      const replyData = reply || {};
      const botMsg = replyData.reply || {};
      const assistant = {
        role: 'assistant',
        content: botMsg.content || '',
        cards: Array.isArray(botMsg.cards) ? botMsg.cards : [],
        actions: Array.isArray(botMsg.actions) ? botMsg.actions : [],
        createdAt: new Date().toISOString(),
      };
      if (!assistant.content && !assistant.cards.length) assistant.content = '我还在学习中，可以换个说法试试～';
      appendMessage(assistant);
      if (replyData.state) aiState = replyData.state;
    } catch (err) {
      hideTyping();
      inner.insertAdjacentHTML(
        'beforeend',
        `<div class="msg msg--ai"><div class="msg__bubble">${esc((err && err.message) || 'AI 暂时不可用')}</div></div>`
      );
      scrollChat();
    } finally {
      pending = false;
      sendBtn.disabled = false;
    }
  }

  sendBtn.addEventListener('click', () => send(input.value));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send(input.value);
    }
  });
  $('#ai-quick').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-q]');
    if (btn) send(btn.dataset.q);
  });

  $('#ai-reset').addEventListener('click', () => render());

  inner.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-ai-action]');
    if (!btn) return;
    const action = btn.dataset.aiAction || '';
    let payload = {};
    try {
      payload = JSON.parse(btn.dataset.aiPayload || '{}');
    } catch {
      payload = {};
    }

    if (action === 'open_product' && payload.productId) {
      go(`/product/${encodeURIComponent(payload.productId)}`);
      return;
    }
    if (action === 'open_orders') {
      go('/orders');
      return;
    }
    if (action === 'open_service') {
      go('/service');
      return;
    }
    if (action === 'open_dist') {
      go('/dist');
      return;
    }
    if (action === 'bind_invite') {
      if (!payload.inviteCode) {
        toast('缺少邀请码');
        return;
      }
    }

    if (pending) return;
    pending = true;
    btn.disabled = true;
    showTyping();
    try {
      const raw = await api('POST', '/api/ai/action', { sessionId, action, payload });
      hideTyping();
      const data = raw || {};
      if (data.ok === false) {
        appendMessage({ role: 'assistant', content: data.message || '这个动作暂时不可用', createdAt: new Date().toISOString() });
        return;
      }
      const cards = Array.isArray(data.cards) ? data.cards : [];
      const actions = Array.isArray(data.actions) ? data.actions : [];
      const text = data.message || (data.result && (data.result.message || data.result.title)) || '已完成';
      appendMessage({ role: 'assistant', content: text, cards, actions, createdAt: new Date().toISOString() });
      if (data.state) aiState = data.state;
      if (action === 'mock_pay' || action === 'pay_order' || action === 'create_order' || action === 'refund_order') {
        const ref = data.result || {};
        if (ref.orderNo && action !== 'refund_order') {
          appendMessage({
            role: 'assistant',
            content: `订单已生成：${ref.orderNo}`,
            cards: [{ type: 'order', orderNo: ref.orderNo, status: ref.status, statusText: ref.statusText, totalText: ref.totalText, payExpireAt: ref.payExpireAt }],
            actions: [{ label: '去收银台支付', action: 'open_orders', payload: {} }],
            createdAt: new Date().toISOString(),
          });
        }
      }
    } catch (err) {
      hideTyping();
      const raw = err && err.details;
      if (raw && raw.needConfirm) {
        appendMessage({ role: 'assistant', content: (err && err.message) || '需要确认后继续', createdAt: new Date().toISOString() });
      } else if (err && err.code === 'FORBIDDEN' && action === 'bind_invite') {
        appendMessage({ role: 'assistant', content: '邀请码绑定失败：可能已绑定过上级或邀请码无效。', createdAt: new Date().toISOString() });
      } else {
        appendMessage({
          role: 'assistant',
          content: (err && err.message) || '该功能暂未开放',
          createdAt: new Date().toISOString(),
        });
      }
    } finally {
      pending = false;
      btn.disabled = false;
    }
  });

  if (aiState && aiState.intent && !messages.length) paint();
}

/* ------------------------------------------------------------------ *
 * 视图 · 我的
 * ------------------------------------------------------------------ */
async function viewMe({ host }) {
  if (!hasToken()) {
    host.innerHTML = `
      <div class="login">
        <div class="login__brand">🧘</div>
        <div class="login__title">悦己瑜伽</div>
        <div class="login__sub">登录后查看订单、课程与分销佣金</div>
      </div>
      <a class="btn btn--primary btn--block mt16" href="#/login?next=%2Fme">去登录</a>
      <a class="btn btn--ghost btn--block mt8" href="#/products">先逛逛课程</a>`;
    return;
  }

  const result = await withBusy(null, () => api('GET', '/api/me'));
  if (!result.ok) {
    host.innerHTML = errorBox(result.error, '/api/me 尚未就绪');
    bindRetry(host);
    return;
  }
  const data = result.value || {};
  const user = data.user || {};
  state.me = user;
  const inviteCode = user.inviteCode || data.inviteCode || '';

  host.innerHTML = `
    <div class="profile">
      <div class="profile__avatar">${esc(String(user.nickname || '我').slice(0, 1))}</div>
      <div class="grow">
        <div class="profile__name">${esc(user.nickname || '未命名用户')}</div>
        <div class="profile__meta">${inviteCode ? `邀请码 ${esc(inviteCode)} · ` : ''}${user.distEnabled ? '分销已开通' : '未开通分销'}</div>
      </div>
      <span class="tag" style="background:rgba(255,255,255,.22);color:#fff">${esc(user.role === 'admin' ? '管理员' : '学员')}</span>
    </div>
    <div class="menu mt12">
      <a class="menu__item" href="#/orders"><span class="menu__ico">🧾</span><span class="grow">我的订单</span><span class="menu__arrow">›</span></a>
      <a class="menu__item" href="#/courses"><span class="menu__ico">📚</span><span class="grow">我的课程</span><span class="menu__arrow">›</span></a>
      <a class="menu__item" href="#/dist"><span class="menu__ico">💰</span><span class="grow">分销中心</span><span class="menu__arrow">›</span></a>
      <a class="menu__item" href="#/service"><span class="menu__ico">🎧</span><span class="grow">在线客服</span><span class="menu__arrow">›</span></a>
      <a class="menu__item" href="#/ai"><span class="menu__ico">✨</span><span class="grow">AI 课程顾问</span><span class="menu__arrow">›</span></a>
      <a class="menu__item" href="/admin" target="_blank" rel="noopener"><span class="menu__ico">🛠</span><span class="grow">后台管理</span><span class="menu__arrow">↗</span></a>
    </div>
    <div class="card mt12">
      <div class="strong small">切换演示账号</div>
      <p class="muted small mt4">本地环境使用 dev-login，可随时切换身份验证分销链路（A→B→C）。</p>
      <div class="demo-list mt8">
        ${[
          { openid: 'dev_demo_a', name: '馆主·林梵', desc: 'DEMOA · 顶级分销员' },
          { openid: 'dev_demo_b', name: '学员·小满', desc: 'DEMOB · 上级是 A' },
          { openid: 'dev_demo_c', name: '学员·阿橘', desc: 'DEMOC · 上级是 B' },
        ]
          .map(
            (d) => `
          <button class="demo-btn" type="button" data-openid="${esc(d.openid)}">
            <span class="avatar">${esc(d.name.slice(-1))}</span>
            <span class="grow"><span class="demo-btn__name">${esc(d.name)}</span><span class="demo-btn__desc">${esc(d.desc)}</span></span>
            <span class="demo-btn__arrow">›</span>
          </button>`
          )
          .join('')}
      </div>
    </div>
    <button class="btn btn--line btn--block mt12" type="button" id="logout">退出登录</button>
    <p class="muted small center mt16">本机演示环境 · 支付为 mock 模拟 · 无真实扣款</p>`;

  host.addEventListener('click', async (event) => {
    const demo = event.target.closest('[data-openid]');
    if (demo) {
      const result2 = await withBusy(demo, () => api('POST', '/api/auth/dev-login', { openid: demo.dataset.openid }));
      if (!result2.ok) return;
      const payload = result2.value || {};
      if (payload.token) localStorage.setItem(TOKEN_KEY, payload.token);
      localStorage.setItem(OPENID_KEY, demo.dataset.openid);
      state.me = payload.user || null;
      toast(`已切换为 ${(payload.user && payload.user.nickname) || demo.dataset.openid}`, 'ok');
      render();
      return;
    }
    if (event.target.closest('#logout')) {
      localStorage.removeItem(TOKEN_KEY);
      state.me = null;
      toast('已退出登录', 'ok');
      go('/login');
    }
  });
}

/* ------------------------------------------------------------------ *
 * 视图 · 登录
 * ------------------------------------------------------------------ */
async function viewLogin({ host, query }) {
  const next = query.get('next') || '';
  host.innerHTML = `
    <div class="login">
      <div class="login__brand">🧘</div>
      <div class="login__title">悦己瑜伽 · 课程商城</div>
      <div class="login__sub">本机演示环境，用下面任一演示账号即可进入</div>
    </div>
    <div class="login__hint center">选择演示账号（自动生成 token，无需微信）</div>
    <div class="demo-list">
      <button class="demo-btn" type="button" data-openid="dev_demo_a">
        <span class="avatar">梵</span>
        <span class="grow"><span class="demo-btn__name">馆主·林梵</span><span class="demo-btn__desc">DEMOA · 有下级团队，可看分销佣金</span></span>
        <span class="demo-btn__arrow">›</span>
      </button>
      <button class="demo-btn" type="button" data-openid="dev_demo_b">
        <span class="avatar">满</span>
        <span class="grow"><span class="demo-btn__name">学员·小满</span><span class="demo-btn__desc">DEMOB · 上级是馆主林梵</span></span>
        <span class="demo-btn__arrow">›</span>
      </button>
      <button class="demo-btn" type="button" data-openid="dev_demo_c">
        <span class="avatar">橘</span>
        <span class="grow"><span class="demo-btn__name">学员·阿橘</span><span class="demo-btn__desc">DEMOC · 上级是小满，可验证二级佣金</span></span>
        <span class="demo-btn__arrow">›</span>
      </button>
    </div>
    <div class="login__hint center">或者用随机游客身份体验</div>
    <button class="btn btn--primary btn--block" type="button" id="guest-login">游客登录（自动生成 openid）</button>
    <p class="muted small center mt12">openid：<span class="mono">${esc(randomOpenid())}</span></p>
    <p class="muted small center mt16">登录即表示同意本机演示环境的全部行为（仅本地数据）</p>`;

  async function doLogin(openid, btn) {
    const result = await withBusy(btn, () => api('POST', '/api/auth/dev-login', { openid }));
    if (!result.ok) {
      toast('登录失败：演示登录可能已被关闭', 'error');
      return;
    }
    const payload = result.value || {};
    if (payload.token) localStorage.setItem(TOKEN_KEY, payload.token);
    localStorage.setItem(OPENID_KEY, openid);
    state.me = payload.user || null;
    toast(`欢迎，${(payload.user && payload.user.nickname) || '同学'}`, 'ok');
    await afterLogin(next);
  }

  host.addEventListener('click', async (event) => {
    const demo = event.target.closest('[data-openid]');
    const guest = event.target.closest('#guest-login');
    if (!demo && !guest) return;
    const btn = demo || guest;
    const openid = demo ? demo.dataset.openid : randomOpenid();
    await doLogin(openid, btn);
  });

  /* /#/login?demo=dev_demo_b 可直接进入指定演示账号（分享用） */
  const autoDemo = query.get('demo');
  if (autoDemo && /^dev_demo_[abc]$/.test(autoDemo)) {
    const autoBtn = host.querySelector(`[data-openid="${autoDemo}"]`);
    if (autoBtn) doLogin(autoDemo, autoBtn);
  }
}

async function afterLogin(next) {
  const pendingInvite = sessionStorage.getItem(PENDING_INVITE_KEY);
  if (pendingInvite) {
    sessionStorage.removeItem(PENDING_INVITE_KEY);
    const bound = await api('POST', '/api/dist/bind', { inviteCode: pendingInvite }).catch((err) => ({ __error: err }));
    if (bound && !bound.__error) toast('已绑定邀请关系', 'ok');
    else if (bound && bound.__error) toast(bound.__error.message || '绑定邀请码失败', 'error');
    go('/dist');
    return;
  }
  if (next) go(next);
  else go('/home');
}

/* ------------------------------------------------------------------ *
 * 视图 · 接受邀请
 * ------------------------------------------------------------------ */
async function viewJoin({ host, query }) {
  const code = (query.get('code') || '').trim();
  if (!code) {
    host.innerHTML = errorBox(new ApiError(400, 'BAD_REQUEST', '邀请链接缺少邀请码'), '请向好友索要完整链接');
    bindRetry(host);
    return;
  }
  if (!hasToken()) {
    sessionStorage.setItem(PENDING_INVITE_KEY, code);
    host.innerHTML = emptyBox('🎁', `好友邀请你加入（邀请码 ${code}）`, '登录后自动完成绑定', '<a class="btn btn--primary btn--sm mt8" href="#/login?next=%2Fdist">去登录并绑定</a>');
    return;
  }
  const result = await withBusy(null, () => api('POST', '/api/dist/bind', { inviteCode: code }));
  if (!result.ok) {
    host.innerHTML = errorBox(result.error, '绑定接口尚未就绪');
    bindRetry(host);
    return;
  }
  host.innerHTML = `
    <div class="card center">
      <div class="success-mark">✓</div>
      <div class="strong">已绑定邀请关系</div>
      <p class="muted small mt4">邀请码 ${esc(code)}</p>
      <a class="btn btn--primary btn--block mt12" href="#/dist">进入分销中心</a>
      <a class="btn btn--ghost btn--block mt8" href="#/products">去选课</a>
    </div>`;
}

/* ------------------------------------------------------------------ *
 * 视图 · 404
 * ------------------------------------------------------------------ */
function viewNotFound({ host }) {
  host.innerHTML = `
    <div class="empty">
      <div class="empty__ico">🧭</div>
      <div class="empty__title">页面不存在</div>
      <div class="empty__desc">链接可能已失效，回首页重新开始吧</div>
      <a class="btn btn--primary btn--sm mt12" href="#/home">回到首页</a>
    </div>`;
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */
function boot() {
  if (!location.hash) {
    history.replaceState(null, '', `${location.pathname}${location.search}#/home`);
  }
  window.addEventListener('hashchange', () => {
    render().catch(() => toast('页面渲染失败，请重试', 'error'));
  });
  const back = $('#appbar-back');
  if (back) {
    back.addEventListener('click', () => {
      if (history.length > 1) history.back();
      else go('/home');
    });
  }
  render().catch(() => toast('页面渲染失败，请重试', 'error'));
}

boot();
