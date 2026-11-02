'use strict';
/**
 * 二级分销服务（纯函数式：第一个参数是 db，便于 AI 模块与测试直接调用）。
 *
 * 账本约定：
 *   1) commission_entries 是唯一佣金账本，金额整数分；
 *   2) 两级返佣：一级（直接上级）commission_l1_bps，二级（上级的上级）commission_l2_bps；
 *      上级未开通分销（dist_enabled=0）时跳过该级，不补发；
 *   3) 冲正条目 type='reverse'、amount_cents 为负、status 恒为 'cancelled'：
 *      它只作审计留痕，不参与余额计算；余额变化由「原条目被 cancelled」或
 *      「原条目金额被折减」体现，因此永不重复扣减、可完整回溯：
 *      Σ|reverse| == 原始佣金 − 当前佣金金额；
 *   4) 可提现余额 = Σ(status='available' 条目)
 *                   − Σ(提现 status in pending/approved)   ← 占用
 *                   − Σ(提现 status = paid)                  ← 已出款
 *      提现被驳回后自动从「占用」里消失，余额自然回滚，无需反向记账；
 *   5) 所有比例/冻结天数/提现门槛都从 settings 读，后台改完即生效。
 */
const config = require('../../config');
const { errors } = require('../../http/errors');
const { newId, inviteCode: randomInviteCode } = require('../../utils/id');
const { nowIso } = require('../../utils/time');
const { bpsOf, prorate, centsToYuanString } = require('../../utils/money');
const { writeAudit } = require('../../utils/audit');

/** 沿 parent 链向上最多走多少层（契约要求至少校验 2 层，这里取全链上限防历史脏数据成环） */
const MAX_CHAIN_DEPTH = 32;

const LEVEL_TEXT = { 0: '无', 1: '一级', 2: '二级', 3: '三级' };
const STATUS_TEXT = { pending: '冻结中', available: '可提现', cancelled: '已冲正' };
const TYPE_TEXT = { commission: '佣金', reverse: '冲正', adjust: '手工调整' };
const WITHDRAW_STATUS_TEXT = { pending: '待审核', approved: '已通过待打款', paid: '已打款', rejected: '已驳回' };
/** 计入「团队贡献」的订单状态（全额退款的不算贡献） */
const COUNTED_ORDER_STATUSES = ['paid', 'completed', 'refunding', 'partial_refunded'];

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function shiftDays(iso, days) {
  const t = Date.parse(String(iso || ''));
  const base = Number.isNaN(t) ? Date.now() : t;
  return new Date(base + Math.max(0, num(days, 0)) * 86400000).toISOString();
}

/** 万分比 -> "15%" / "12.5%" */
function bpsText(bps) {
  const n = num(bps, 0) / 100;
  return `${String(n).replace(/\.0+$/, '')}%`;
}

function maskNickname(name) {
  const chars = [...String(name || '瑜伽学员').trim()] || ['瑜'];
  if (chars.length === 1) return `${chars[0]}*`;
  if (chars.length === 2) return `${chars[0]}*`;
  return `${chars[0]}${'*'.repeat(Math.min(3, chars.length - 2))}${chars[chars.length - 1]}`;
}

/** 当前业务参数（全部来自 settings，不写死） */
function settingsOf(db) {
  const l1Bps = Math.max(0, Math.trunc(num(db.getSettingNumber('commission_l1_bps', 1500), 1500)));
  const l2Bps = Math.max(0, Math.trunc(num(db.getSettingNumber('commission_l2_bps', 500), 500)));
  const freezeDays = Math.max(0, Math.trunc(num(db.getSettingNumber('freeze_days', 7), 7)));
  const minWithdrawCents = Math.max(1, Math.trunc(num(db.getSettingNumber('min_withdraw_cents', 1000), 1000)));
  return { l1Bps, l2Bps, freezeDays, minWithdrawCents };
}

function inviteUrl(code) {
  const base = String(process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${config.port}`).replace(/\/+$/, '');
  return `${base}/#/join?code=${encodeURIComponent(String(code || ''))}`;
}

/** 模块自建索引（幂等，不依赖中央 schema 变更） */
function ensureSchema(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS ix_comm_user_created ON commission_entries(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS ix_comm_refund ON commission_entries(refund_id);
    CREATE INDEX IF NOT EXISTS ix_comm_buyer ON commission_entries(buyer_id);
    CREATE INDEX IF NOT EXISTS ix_wd_user_status ON withdrawals(user_id, status);
  `);
}

/* ------------------------------------------------------------------ *
 * 视图映射（出参 camelCase）
 * ------------------------------------------------------------------ */

function publicEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    buyerId: row.buyer_id || null,
    buyerNickname: row.buyer_nickname ? maskNickname(row.buyer_nickname) : '',
    orderId: row.order_id,
    orderNo: row.order_no || '',
    refundId: row.refund_id || null,
    refundNo: row.refund_no || '',
    level: row.level,
    levelText: LEVEL_TEXT[row.level] || `L${row.level}`,
    type: row.type,
    typeText: TYPE_TEXT[row.type] || row.type,
    amountCents: num(row.amount_cents),
    amountText: centsToYuanString(num(row.amount_cents)),
    rateBps: num(row.rate_bps),
    rateText: bpsText(row.rate_bps),
    status: row.status,
    statusText: STATUS_TEXT[row.status] || row.status,
    availableAt: row.available_at || null,
    settledAt: row.settled_at || null,
    remark: row.remark || '',
    createdAt: row.created_at,
  };
}

function publicWithdrawal(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    amountCents: num(row.amount_cents),
    amountText: centsToYuanString(num(row.amount_cents)),
    status: row.status,
    statusText: WITHDRAW_STATUS_TEXT[row.status] || row.status,
    channel: row.channel,
    account: row.account || '',
    reviewNote: row.review_note || '',
    reviewedBy: row.reviewed_by || null,
    reviewedAt: row.reviewed_at || null,
    paidAt: row.paid_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    user: row.user_nickname
      ? { id: row.user_id, nickname: row.user_nickname, inviteCode: row.user_invite_code || '' }
      : undefined,
  };
}

/* ------------------------------------------------------------------ *
 * 关系与层级
 * ------------------------------------------------------------------ */

/** 向上取 n 级上级：[{level:1, user}, {level:2, user}] */
function parentChain(db, userId, depth = 2) {
  const out = [];
  let cur = db.get('SELECT * FROM users WHERE id = ?', userId);
  for (let level = 1; level <= depth; level++) {
    const pid = cur ? cur.parent_id : null;
    if (!pid) break;
    const up = db.get('SELECT * FROM users WHERE id = ?', pid);
    if (!up) break;
    out.push({ level, user: up });
    cur = up;
  }
  return out;
}

/** 自身层级：1=无上级，2=有直接上级，3=有二级上级（返佣最多计两级） */
function selfLevel(db, user) {
  let depth = 0;
  let cur = user;
  const seen = new Set();
  while (cur && cur.parent_id && depth < MAX_CHAIN_DEPTH) {
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    const up = db.get('SELECT id, parent_id FROM users WHERE id = ?', cur.parent_id);
    if (!up) break;
    depth += 1;
    cur = up;
  }
  return Math.min(depth + 1, 3);
}

/** 防环：从待绑定上级向上走，遇到自己即闭环 */
function assertNoCycle(db, userId, startParentId) {
  let cur = startParentId;
  let depth = 0;
  const seen = new Set();
  while (cur && depth < MAX_CHAIN_DEPTH) {
    if (cur === userId) throw errors.validation('不能绑定自己的下级，会形成邀请闭环');
    if (seen.has(cur)) break; // 历史脏数据已存在环，止步即可
    seen.add(cur);
    const row = db.get('SELECT parent_id FROM users WHERE id = ?', cur);
    cur = row ? row.parent_id : null;
    depth += 1;
  }
}

/* ------------------------------------------------------------------ *
 * 余额
 * ------------------------------------------------------------------ */

function balanceOf(db, userId) {
  const entriesAvailable = num(
    db.pluck("SELECT IFNULL(SUM(amount_cents), 0) FROM commission_entries WHERE user_id = ? AND status = 'available'", userId)
  );
  const entriesPending = num(
    db.pluck("SELECT IFNULL(SUM(amount_cents), 0) FROM commission_entries WHERE user_id = ? AND status = 'pending'", userId)
  );
  const occupied = num(
    db.pluck(
      "SELECT IFNULL(SUM(amount_cents), 0) FROM withdrawals WHERE user_id = ? AND status IN ('pending','approved')",
      userId
    )
  );
  const paidOut = num(
    db.pluck("SELECT IFNULL(SUM(amount_cents), 0) FROM withdrawals WHERE user_id = ? AND status = 'paid'", userId)
  );
  const totalCents = num(
    db.pluck(
      `SELECT IFNULL(SUM(amount_cents), 0) FROM commission_entries
        WHERE user_id = ? AND status IN ('pending','available') AND type IN ('commission','adjust','reverse')`,
      userId
    )
  );
  const availableCents = entriesAvailable - occupied - paidOut;
  const s = settingsOf(db);
  return {
    availableCents,
    pendingCents: entriesPending,
    settledCents: paidOut,
    totalCents,
    occupiedCents: occupied,
    minWithdrawCents: s.minWithdrawCents,
    minWithdrawText: centsToYuanString(s.minWithdrawCents),
    availableText: centsToYuanString(availableCents),
    pendingText: centsToYuanString(entriesPending),
    settledText: centsToYuanString(paidOut),
    totalText: centsToYuanString(totalCents),
  };
}

/* ------------------------------------------------------------------ *
 * 开通 / 邀请 / 绑定
 * ------------------------------------------------------------------ */

function genUniqueInviteCode(db) {
  for (let i = 0; i < 12; i++) {
    const code = randomInviteCode();
    if (!db.get('SELECT 1 AS x FROM users WHERE invite_code = ?', code)) return code;
  }
  // 极端兜底：加时间后缀保证唯一
  return `${randomInviteCode()}${String(Date.now()).slice(-3)}`;
}

function enableDist(db, userId) {
  return db.tx(() => {
    const me = db.get('SELECT * FROM users WHERE id = ?', userId);
    if (!me) throw errors.notFound('用户不存在');
    let code = me.invite_code;
    if (!code) {
      code = genUniqueInviteCode(db);
      db.run('UPDATE users SET invite_code = ?, updated_at = ? WHERE id = ?', code, nowIso(), me.id);
    }
    if (!me.dist_enabled) {
      db.run('UPDATE users SET dist_enabled = 1, updated_at = ? WHERE id = ?', nowIso(), me.id);
    }
    writeAudit(db, {
      actorType: 'user',
      actorId: me.id,
      action: 'dist.enable',
      targetType: 'user',
      targetId: me.id,
      detail: { inviteCode: code, alreadyEnabled: !!me.dist_enabled },
    });
    return { isDistributor: true, inviteCode: code, inviteUrl: inviteUrl(code), enabledAt: nowIso() };
  });
}

function inviteInfo(db, userId) {
  const me = db.get('SELECT * FROM users WHERE id = ?', userId);
  if (!me) throw errors.notFound('用户不存在');
  const code = me.invite_code || '';
  const s = settingsOf(db);
  return {
    isDistributor: !!me.dist_enabled,
    inviteCode: code,
    inviteUrl: inviteUrl(code),
    channelCode: code,
    tips: [
      `把邀请链接或邀请码发给好友，好友下单后你得 ${bpsText(s.l1Bps)} 佣金`,
      `好友再邀请的人下单，你还能得 ${bpsText(s.l2Bps)} 二级佣金`,
      `佣金冻结 ${s.freezeDays} 天后可提现，单次提现不低于 ${centsToYuanString(s.minWithdrawCents)} 元`,
    ],
    rules: {
      l1Bps: s.l1Bps,
      l2Bps: s.l2Bps,
      l1Text: bpsText(s.l1Bps),
      l2Text: bpsText(s.l2Bps),
      freezeDays: s.freezeDays,
      minWithdrawCents: s.minWithdrawCents,
      minWithdrawText: centsToYuanString(s.minWithdrawCents),
    },
  };
}

/**
 * 绑定上级：只能用一次、不能自绑、不能成环。
 * @param {{userId:string, inviteCode:string, source?:string}} input
 */
function bindInviter(db, { userId, inviteCode: rawCode, source = 'link' }) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) throw errors.badRequest('请填写邀请码');

  return db.tx(() => {
    const me = db.get('SELECT * FROM users WHERE id = ?', userId);
    if (!me) throw errors.notFound('用户不存在');
    const inviter = db.get('SELECT * FROM users WHERE invite_code = ?', code);
    if (!inviter) throw errors.notFound('邀请码不存在，请确认后重试');
    if (inviter.id === me.id) throw errors.validation('不能绑定自己的邀请码');
    if (me.parent_id) throw errors.duplicate('已经绑定过邀请人，不能重复绑定');
    assertNoCycle(db, me.id, inviter.id);

    const ts = nowIso();
    const r = db.run('UPDATE users SET parent_id = ?, updated_at = ? WHERE id = ? AND parent_id IS NULL', inviter.id, ts, me.id);
    if (!r.changes) throw errors.duplicate('已经绑定过邀请人，不能重复绑定');

    db.run(
      'INSERT INTO bind_logs (id, user_id, inviter_id, source, created_at) VALUES (?, ?, ?, ?, ?)',
      newId('bl_'),
      me.id,
      inviter.id,
      String(source || 'link').slice(0, 32),
      ts
    );
    writeAudit(db, {
      actorType: 'user',
      actorId: me.id,
      action: 'dist.bind',
      targetType: 'user',
      targetId: inviter.id,
      detail: { inviteCode: code, source: String(source || 'link').slice(0, 32) },
    });

    return {
      bound: true,
      parentId: inviter.id,
      parentNickname: maskNickname(inviter.nickname),
      inviteCode: code,
      boundAt: ts,
    };
  });
}

/* ------------------------------------------------------------------ *
 * 概览 / 团队 / 流水
 * ------------------------------------------------------------------ */

function entryRowsSql(whereSql) {
  return `SELECT e.*, o.order_no AS order_no, r.refund_no AS refund_no, b.nickname AS buyer_nickname
            FROM commission_entries e
            LEFT JOIN orders o ON o.id = e.order_id
            LEFT JOIN refunds r ON r.id = e.refund_id
            LEFT JOIN users b ON b.id = e.buyer_id
           ${whereSql}`;
}

function overview(db, userId) {
  const me = db.get('SELECT * FROM users WHERE id = ?', userId);
  if (!me) throw errors.unauthorized('用户不存在');
  const s = settingsOf(db);
  const balance = balanceOf(db, userId);
  const teamSize = num(db.pluck('SELECT COUNT(*) FROM users WHERE parent_id = ?', userId));
  const teamSizeL2 = num(
    db.pluck('SELECT COUNT(*) FROM users WHERE parent_id IN (SELECT id FROM users WHERE parent_id = ?)', userId)
  );
  const today = nowIso().slice(0, 10);
  const todayRow =
    db.get(
      `SELECT IFNULL(SUM(amount_cents), 0) AS cents, COUNT(DISTINCT order_id) AS orders
         FROM commission_entries
        WHERE user_id = ? AND type = 'commission' AND status != 'cancelled' AND substr(created_at, 1, 10) = ?`,
      userId,
      today
    ) || { cents: 0, orders: 0 };
  const recent = db.all(entryRowsSql('WHERE e.user_id = ? ORDER BY e.created_at DESC, e.id DESC LIMIT 5'), userId);

  return {
    isDistributor: !!me.dist_enabled,
    inviteCode: me.invite_code || '',
    inviteUrl: inviteUrl(me.invite_code || ''),
    level: selfLevel(db, me),
    levelText: LEVEL_TEXT[selfLevel(db, me)] || '',
    teamSize,
    teamSizeL2,
    hasParent: !!me.parent_id,
    balance,
    today: {
      commissionCents: num(todayRow.cents),
      commissionText: centsToYuanString(num(todayRow.cents)),
      orders: num(todayRow.orders),
    },
    recent: recent.map(publicEntry),
    rules: {
      l1Bps: s.l1Bps,
      l2Bps: s.l2Bps,
      l1Text: bpsText(s.l1Bps),
      l2Text: bpsText(s.l2Bps),
      freezeDays: s.freezeDays,
      minWithdrawCents: s.minWithdrawCents,
      minWithdrawText: centsToYuanString(s.minWithdrawCents),
    },
  };
}

function team(db, userId, level, paging) {
  const me = db.get('SELECT * FROM users WHERE id = ?', userId);
  if (!me) throw errors.notFound('用户不存在');
  const lv = Number(level) === 2 ? 2 : 1;
  const whereSql =
    lv === 1
      ? 'WHERE u.parent_id = ?'
      : 'WHERE u.parent_id IN (SELECT c.id FROM users c WHERE c.parent_id = ?)';
  const total = num(
    db.pluck(`SELECT COUNT(*) FROM users u ${whereSql}`, userId)
  );
  const rows = db.all(
    `SELECT u.id, u.nickname, u.avatar, u.invite_code, u.dist_enabled, u.created_at,
            (SELECT COUNT(*) FROM orders o
              WHERE o.user_id = u.id AND o.status IN (${COUNTED_ORDER_STATUSES.map(() => '?').join(',')})) AS order_count,
            (SELECT IFNULL(SUM(e.amount_cents), 0) FROM commission_entries e
              WHERE e.buyer_id = u.id AND e.user_id = ? AND e.type = 'commission' AND e.status != 'cancelled') AS contribution
       FROM users u
       ${whereSql}
      ORDER BY u.created_at DESC, u.id DESC
      LIMIT ? OFFSET ?`,
    ...COUNTED_ORDER_STATUSES,
    userId,
    userId,
    paging.limit,
    paging.offset
  );
  const list = rows.map((r) => ({
    userId: r.id,
    nickname: maskNickname(r.nickname),
    avatar: r.avatar || '',
    level: lv,
    orderCount: num(r.order_count),
    contributionCents: num(r.contribution),
    contributionText: centsToYuanString(num(r.contribution)),
    isDistributor: !!r.dist_enabled,
    joinedAt: r.created_at,
  }));
  return { list, total, page: paging.page, size: paging.size, pages: paging.size > 0 ? Math.ceil(total / paging.size) : 0, hasMore: paging.page * paging.size < total, level: lv };
}

function listCommissions(db, userId, { status, paging }) {
  let where = 'WHERE e.user_id = ?';
  const args = [userId];
  const raw = String(status || '').trim();
  if (raw === 'reversed') {
    where += " AND (e.status = 'cancelled' OR e.type = 'reverse')";
  } else if (raw === 'cancelled') {
    where += " AND e.status = 'cancelled'";
  } else if (['pending', 'available'].includes(raw)) {
    where += ' AND e.status = ?';
    args.push(raw);
  }
  const total = num(
    db.pluck(
      `SELECT COUNT(*) FROM commission_entries e LEFT JOIN orders o ON o.id = e.order_id ${where}`,
      ...args
    )
  );
  const rows = db.all(
    entryRowsSql(`${where} ORDER BY e.created_at DESC, e.id DESC LIMIT ? OFFSET ?`),
    ...args,
    paging.limit,
    paging.offset
  );
  return {
    list: rows.map(publicEntry),
    total,
    page: paging.page,
    size: paging.size,
    pages: paging.size > 0 ? Math.ceil(total / paging.size) : 0,
    hasMore: paging.page * paging.size < total,
  };
}

/* ------------------------------------------------------------------ *
 * 提现
 * ------------------------------------------------------------------ */

function withdrawalView(db, id) {
  const row = db.get(
    `SELECT w.*, u.nickname AS user_nickname, u.invite_code AS user_invite_code
       FROM withdrawals w LEFT JOIN users u ON u.id = w.user_id
      WHERE w.id = ?`,
    id
  );
  return publicWithdrawal(row);
}

function listWithdrawals(db, userId, paging) {
  const total = num(db.pluck('SELECT COUNT(*) FROM withdrawals WHERE user_id = ?', userId));
  const rows = db.all(
    `SELECT w.*, u.nickname AS user_nickname, u.invite_code AS user_invite_code
       FROM withdrawals w LEFT JOIN users u ON u.id = w.user_id
      WHERE w.user_id = ?
      ORDER BY w.created_at DESC, w.id DESC LIMIT ? OFFSET ?`,
    userId,
    paging.limit,
    paging.offset
  );
  return {
    list: rows.map(publicWithdrawal),
    total,
    page: paging.page,
    size: paging.size,
    pages: paging.size > 0 ? Math.ceil(total / paging.size) : 0,
    hasMore: paging.page * paging.size < total,
  };
}

/**
 * 申请提现：≥ min_withdraw_cents 且 ≤ 可提现余额。
 * 金额校验与占用写入同一事务，避免并发超提。
 */
function createWithdrawal(db, userId, { amountCents, channel = 'wechat', account = '' }) {
  const s = settingsOf(db);
  const amount = Math.trunc(num(amountCents));
  if (!Number.isInteger(amount) || amount <= 0) throw errors.validation('提现金额必须是正整数（单位：分）');
  if (amount < s.minWithdrawCents) {
    throw errors.validation(`单次提现不能低于 ${centsToYuanString(s.minWithdrawCents)} 元`);
  }

  return db.tx(() => {
    const me = db.get('SELECT * FROM users WHERE id = ?', userId);
    if (!me) throw errors.notFound('用户不存在');
    if (!me.dist_enabled) throw errors.forbidden('请先开通分销');

    const balance = balanceOf(db, userId);
    if (amount > balance.availableCents) {
      throw errors.insufficientBalance(`可提现余额不足，当前可提 ${centsToYuanString(Math.max(0, balance.availableCents))} 元`);
    }

    const id = newId('wd_');
    const ts = nowIso();
    db.run(
      `INSERT INTO withdrawals
         (id, user_id, amount_cents, status, channel, account, review_note, reviewed_by, reviewed_at, paid_at, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?, '', NULL, NULL, NULL, ?, ?)`,
      id,
      me.id,
      amount,
      String(channel || 'wechat').slice(0, 16),
      String(account || '').slice(0, 64),
      ts,
      ts
    );
    writeAudit(db, {
      actorType: 'user',
      actorId: me.id,
      action: 'dist.withdraw.apply',
      targetType: 'withdrawal',
      targetId: id,
      detail: { amountCents: amount, channel, availableBefore: balance.availableCents },
    });
    return { withdrawal: withdrawalView(db, id), balance: balanceOf(db, userId) };
  });
}

const WD_TRANSITIONS = {
  approve: { from: ['pending'], to: 'approved', label: '通过' },
  reject: { from: ['pending', 'approved'], to: 'rejected', label: '驳回' },
  paid: { from: ['pending', 'approved'], to: 'paid', label: '标记已打款' },
};

/** 后台审核：approve / reject / paid（reject 自动退回余额） */
function reviewWithdrawal(db, withdrawalId, action, { note = '', adminId = null } = {}) {
  const rule = WD_TRANSITIONS[action];
  if (!rule) throw errors.badRequest('未知的审核动作');
  const trimmed = String(note || '').trim();
  if (action === 'reject' && !trimmed) throw errors.validation('请填写驳回原因');

  return db.tx(() => {
    const row = db.get('SELECT * FROM withdrawals WHERE id = ?', withdrawalId);
    if (!row) throw errors.notFound('提现申请不存在');
    if (!rule.from.includes(row.status)) {
      throw errors.invalidState(`当前状态（${WITHDRAW_STATUS_TEXT[row.status] || row.status}）不能${rule.label}`);
    }
    const ts = nowIso();
    const r = db.run(
      `UPDATE withdrawals
          SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ?, paid_at = ?, updated_at = ?
        WHERE id = ? AND status = ?`,
      rule.to,
      trimmed.slice(0, 200),
      adminId,
      ts,
      rule.to === 'paid' ? ts : null,
      ts,
      row.id,
      row.status
    );
    if (!r.changes) throw errors.invalidState('提现状态已变化，请刷新后重试');

    writeAudit(db, {
      actorType: 'admin',
      actorId: adminId,
      action: `dist.withdraw.${action}`,
      targetType: 'withdrawal',
      targetId: row.id,
      detail: { from: row.status, to: rule.to, amountCents: num(row.amount_cents), note: trimmed, userId: row.user_id },
    });
    return { withdrawal: withdrawalView(db, row.id), balance: balanceOf(db, row.user_id) };
  });
}

/* ------------------------------------------------------------------ *
 * 后台：分销员 / 提现列表 / 手工调整
 * ------------------------------------------------------------------ */

function adminDistributors(db, { keyword = '', paging }) {
  const kw = String(keyword || '').trim();
  const where = kw
    ? "WHERE u.dist_enabled = 1 AND (u.nickname LIKE ? OR u.id LIKE ? OR u.invite_code LIKE ?)"
    : 'WHERE u.dist_enabled = 1';
  const args = kw ? [`%${kw}%`, `%${kw}%`, `%${kw}%`] : [];
  const total = num(db.pluck(`SELECT COUNT(*) FROM users u ${where}`, ...args));
  const rows = db.all(
    `SELECT u.id, u.nickname, u.avatar, u.invite_code, u.parent_id, u.dist_enabled, u.created_at,
            p.nickname AS parent_nickname,
            (SELECT COUNT(*) FROM users c WHERE c.parent_id = u.id) AS team_size,
            (SELECT COUNT(*) FROM users c WHERE c.parent_id IN (SELECT c2.id FROM users c2 WHERE c2.parent_id = u.id)) AS team_size_l2,
            (SELECT IFNULL(SUM(e.amount_cents), 0) FROM commission_entries e
              WHERE e.user_id = u.id AND e.type = 'commission' AND e.status != 'cancelled') AS earned
       FROM users u LEFT JOIN users p ON p.id = u.parent_id
       ${where}
      ORDER BY earned DESC, u.created_at DESC
      LIMIT ? OFFSET ?`,
    ...args,
    paging.limit,
    paging.offset
  );
  const list = rows.map((r) => {
    const balance = balanceOf(db, r.id);
    return {
      userId: r.id,
      nickname: r.nickname,
      avatar: r.avatar || '',
      inviteCode: r.invite_code || '',
      parentId: r.parent_id || null,
      parentNickname: r.parent_nickname || '',
      level: selfLevel(db, { id: r.id, parent_id: r.parent_id }),
      teamSize: num(r.team_size),
      teamSizeL2: num(r.team_size_l2),
      earnedCents: num(r.earned),
      earnedText: centsToYuanString(num(r.earned)),
      availableCents: balance.availableCents,
      availableText: balance.availableText,
      pendingCents: balance.pendingCents,
      pendingText: balance.pendingText,
      withdrawnCents: balance.settledCents,
      withdrawnText: balance.settledText,
      distEnabled: !!r.dist_enabled,
      createdAt: r.created_at,
    };
  });
  return {
    list,
    total,
    page: paging.page,
    size: paging.size,
    pages: paging.size > 0 ? Math.ceil(total / paging.size) : 0,
    hasMore: paging.page * paging.size < total,
  };
}

function adminWithdrawals(db, { status = '', paging }) {
  const raw = String(status || '').trim();
  const valid = ['pending', 'approved', 'paid', 'rejected'];
  const where = valid.includes(raw) ? 'WHERE w.status = ?' : '';
  const args = valid.includes(raw) ? [raw] : [];
  const total = num(db.pluck(`SELECT COUNT(*) FROM withdrawals w ${where}`, ...args));
  const rows = db.all(
    `SELECT w.*, u.nickname AS user_nickname, u.invite_code AS user_invite_code
       FROM withdrawals w LEFT JOIN users u ON u.id = w.user_id
       ${where}
      ORDER BY w.created_at DESC, w.id DESC
      LIMIT ? OFFSET ?`,
    ...args,
    paging.limit,
    paging.offset
  );
  const summary = {
    pendingCents: num(
      db.pluck("SELECT IFNULL(SUM(amount_cents), 0) FROM withdrawals WHERE status IN ('pending','approved')")
    ),
    paidCents: num(db.pluck("SELECT IFNULL(SUM(amount_cents), 0) FROM withdrawals WHERE status = 'paid'")),
    pendingCount: num(db.pluck("SELECT COUNT(*) FROM withdrawals WHERE status IN ('pending','approved')")),
  };
  return {
    list: rows.map(publicWithdrawal),
    total,
    page: paging.page,
    size: paging.size,
    pages: paging.size > 0 ? Math.ceil(total / paging.size) : 0,
    hasMore: paging.page * paging.size < total,
    summary: {
      ...summary,
      pendingText: centsToYuanString(summary.pendingCents),
      paidText: centsToYuanString(summary.paidCents),
    },
  };
}

/** 手工调整佣金（正=补发，负=扣回），立即可提现 */
function adminAdjust(db, { userId, amountCents, note, adminId = null }) {
  const amount = Math.trunc(num(amountCents));
  if (!Number.isInteger(amount) || amount === 0) throw errors.validation('调整金额必须是非 0 整数（单位：分）');
  const reason = String(note || '').trim();
  if (!reason) throw errors.validation('请填写调整原因');

  return db.tx(() => {
    const user = db.get('SELECT * FROM users WHERE id = ?', userId);
    if (!user) throw errors.notFound('用户不存在');
    const id = newId('cm_');
    const ts = nowIso();
    // 手工调整没有订单号，用条目 id 占位（保持 order_id NOT NULL 与唯一索引可用）
    db.run(
      `INSERT INTO commission_entries
         (id, user_id, buyer_id, order_id, refund_id, level, type, amount_cents, rate_bps, status, available_at, settled_at, remark, created_at)
       VALUES (?, ?, NULL, ?, NULL, 0, 'adjust', ?, 0, 'available', ?, NULL, ?, ?)`,
      id,
      user.id,
      `manual_${id}`,
      amount,
      ts,
      `手工调整：${reason}`.slice(0, 200),
      ts
    );
    writeAudit(db, {
      actorType: 'admin',
      actorId: adminId,
      action: 'dist.adjust',
      targetType: 'user',
      targetId: user.id,
      detail: { amountCents: amount, note: reason, entryId: id },
    });
    return { entry: publicEntry({ ...db.get('SELECT * FROM commission_entries WHERE id = ?', id), order_no: '', refund_no: '' }), balance: balanceOf(db, user.id) };
  });
}

/* ------------------------------------------------------------------ *
 * 事件：订单支付 -> 发佣金；退款成功 -> 冲正
 * ------------------------------------------------------------------ */

/**
 * order.paid：两级佣金。
 * 幂等靠 commission_entries 唯一索引 ux_comm_once(order_id, level, type, ifnull(refund_id,'')).
 * @returns {{created:number, entries:Array}}
 */
function handleOrderPaid(payload) {
  const { getDb } = require('../../db');
  const db = getDb();
  const p = payload || {};
  if (!p.orderId || !p.userId) return { created: 0, reason: 'payload-invalid' };

  const s = settingsOf(db);
  const order = db.get('SELECT * FROM orders WHERE id = ?', p.orderId);
  const orderNo = p.orderNo || (order ? order.order_no : '') || '';
  const rawBase = p.commissionBaseCents !== undefined && p.commissionBaseCents !== null
    ? p.commissionBaseCents
    : order
      ? order.commission_base_cents || order.paid_cents
      : p.paidCents;
  const baseCents = Math.max(0, Math.trunc(num(rawBase, 0)));
  if (baseCents <= 0) return { created: 0, reason: 'zero-base' };

  const paidAt = p.paidAt || (order ? order.paid_at : null) || nowIso();
  const availableAt = shiftDays(paidAt, s.freezeDays);
  const now = nowIso();

  return db.tx(() => {
    const created = [];
    for (const { level, user: upline } of parentChain(db, p.userId, 2)) {
      if (!upline || upline.id === p.userId) continue;
      if (!upline.dist_enabled) continue; // 未开通分销：跳过该级，不补发
      const rateBps = level === 1 ? s.l1Bps : s.l2Bps;
      if (rateBps <= 0) continue;
      const amountCents = bpsOf(baseCents, rateBps);
      if (amountCents <= 0) continue;

      const id = newId('cm_');
      const r = db.run(
        `INSERT OR IGNORE INTO commission_entries
           (id, user_id, buyer_id, order_id, refund_id, level, type, amount_cents, rate_bps, status, available_at, settled_at, remark, created_at)
         VALUES (?, ?, ?, ?, NULL, ?, 'commission', ?, ?, 'pending', ?, NULL, ?, ?)`,
        id,
        upline.id,
        p.userId,
        p.orderId,
        level,
        amountCents,
        rateBps,
        availableAt,
        `订单 ${orderNo} · ${LEVEL_TEXT[level]}佣金`.trim(),
        now
      );
      if (r.changes > 0) {
        created.push({ id, userId: upline.id, level, amountCents, rateBps });
      }
    }
    if (created.length) {
      writeAudit(db, {
        actorType: 'system',
        actorId: null,
        action: 'dist.commission.create',
        targetType: 'order',
        targetId: p.orderId,
        detail: { orderNo, baseCents, freezeDays: s.freezeDays, availableAt, created },
      });
    }
    return { created: created.length, entries: created };
  });
}

/**
 * refund.succeeded：按比例冲正（全额退款把原条目置 cancelled）。
 * 冲正条目 status 恒为 'cancelled'（纯审计），余额只由原条目状态/金额体现，
 * 因此重复投递（同一 refund_id）不会重复扣钱：唯一索引 + changes 判定保证。
 * @returns {{reversed:number, cancelled:number}}
 */
function handleRefundSucceeded(payload) {
  const { getDb } = require('../../db');
  const db = getDb();
  const p = payload || {};
  if (!p.orderId) return { reversed: 0, reason: 'payload-invalid' };

  const order = db.get('SELECT * FROM orders WHERE id = ?', p.orderId);
  const orderNo = p.orderNo || (order ? order.order_no : '') || '';
  const fullRefund = p.fullRefund === true || (order ? order.status === 'refunded' : false);
  const refundCents = Math.max(0, Math.trunc(num(p.amountCents, 0)));
  const baseCents = Math.max(
    0,
    Math.trunc(num(order ? order.commission_base_cents || order.paid_cents : 0, 0))
  );
  const refundId = p.refundId || `rfd_${p.refundNo || p.orderId}`;
  const refundNo = p.refundNo || '';
  const now = nowIso();

  return db.tx(() => {
    const originals = db.all(
      `SELECT * FROM commission_entries
        WHERE order_id = ? AND type = 'commission' AND status != 'cancelled'
        ORDER BY level ASC`,
      p.orderId
    );
    let reversed = 0;
    let cancelled = 0;

    for (const entry of originals) {
      const remainCents = num(entry.amount_cents);
      if (remainCents <= 0) {
        db.run("UPDATE commission_entries SET status = 'cancelled', settled_at = ? WHERE id = ?", now, entry.id);
        cancelled += 1;
        continue;
      }
      const target = fullRefund
        ? remainCents
        : Math.min(remainCents, prorate(baseCents, refundCents, remainCents));
      if (target <= 0 && !fullRefund) continue;

      const reverseId = newId('cm_');
      const ins = db.run(
        `INSERT OR IGNORE INTO commission_entries
           (id, user_id, buyer_id, order_id, refund_id, level, type, amount_cents, rate_bps, status, available_at, settled_at, remark, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'reverse', ?, ?, 'cancelled', NULL, ?, ?, ?)`,
        reverseId,
        entry.user_id,
        entry.buyer_id,
        p.orderId,
        refundId,
        entry.level,
        -target,
        num(entry.rate_bps),
        now,
        `订单 ${orderNo} 退款冲正${refundNo ? ` ${refundNo}` : ''}${fullRefund ? '（全额）' : '（部分）'}`.slice(0, 200),
        now
      );
      if (!ins.changes) continue; // 同一退款已冲正过：幂等退出

      reversed += 1;
      if (fullRefund || target >= remainCents) {
        db.run("UPDATE commission_entries SET status = 'cancelled', settled_at = ? WHERE id = ?", now, entry.id);
        cancelled += 1;
      } else {
        db.run(
          `UPDATE commission_entries
              SET amount_cents = amount_cents - ?, remark = substr(remark || '｜部分冲正 -' || ?, 1, 200)
            WHERE id = ?`,
          target,
          String(target),
          entry.id
        );
      }
    }

    if (reversed) {
      writeAudit(db, {
        actorType: 'system',
        actorId: null,
        action: 'dist.commission.reverse',
        targetType: 'order',
        targetId: p.orderId,
        detail: { orderNo, refundNo, fullRefund, refundCents, reversed, cancelled },
      });
    }
    return { reversed, cancelled };
  });
}

/* ------------------------------------------------------------------ *
 * 解冻 sweeper：pending 且 available_at < now -> available
 * ------------------------------------------------------------------ */
function unfreezeTick(db) {
  const target = db || require('../../db').getDb();
  const now = nowIso();
  const r = target.run(
    `UPDATE commission_entries
        SET status = 'available', settled_at = ?
      WHERE status = 'pending' AND available_at IS NOT NULL AND available_at < ?`,
    now,
    now
  );
  return { unfrozen: r.changes };
}

/* ------------------------------------------------------------------ *
 * 给 AI / 客服用的规则文案（「怎么赚佣金」场景）
 * ------------------------------------------------------------------ */
function rulesText(db) {
  const s = settingsOf(db);
  const l1 = bpsText(s.l1Bps);
  const l2 = bpsText(s.l2Bps);
  return {
    l1Bps: s.l1Bps,
    l2Bps: s.l2Bps,
    l1Text: l1,
    l2Text: l2,
    freezeDays: s.freezeDays,
    minWithdrawCents: s.minWithdrawCents,
    minWithdrawText: centsToYuanString(s.minWithdrawCents),
    text: `二级分销：把邀请码发给好友，好友（一级）下单付多少你就拿 ${l1}，好友再邀请的人（二级）下单你拿 ${l2}；佣金冻结 ${s.freezeDays} 天后自动变成可提现，单次提现不低于 ${centsToYuanString(s.minWithdrawCents)} 元，在「分销中心」提交、后台审核后到账。`,
  };
}

module.exports = {
  // 常量与工具
  settingsOf,
  ensureSchema,
  inviteUrl,
  bpsText,
  maskNickname,
  publicEntry,
  publicWithdrawal,
  // 用户侧
  enableDist,
  inviteInfo,
  bindInviter,
  overview,
  team,
  listCommissions,
  balanceOf,
  listWithdrawals,
  createWithdrawal,
  // 后台
  reviewWithdrawal,
  adminDistributors,
  adminWithdrawals,
  adminAdjust,
  // 事件与定时
  handleOrderPaid,
  handleRefundSucceeded,
  unfreezeTick,
  // AI 复用
  rulesText,
};
