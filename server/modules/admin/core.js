'use strict';
/** 后台基础：登录、看板、设置、快捷话术、用户查询、审计日志 */
const config = require('../../config');
const validate = require('../../http/validate');
const { signAdminToken } = require('../../http/auth');
const { errors } = require('../../http/errors');
const { createLimiter } = require('../../http/ratelimit');
const { verifyPassword } = require('../../utils/crypto');
const { writeAudit } = require('../../utils/audit');
const { newId } = require('../../utils/id');
const { nowIso } = require('../../utils/time');
const { fmtYuan } = require('../../utils/money');

const loginLimiter = createLimiter({ windowMs: 60000, max: 10, label: '后台登录' });

/** 可通过后台修改的配置键及类型 */
const EDITABLE_SETTINGS = {
  commission_l1_bps: 'int',
  commission_l2_bps: 'int',
  freeze_days: 'int',
  refund_window_days: 'int',
  auto_refund_max_cents: 'int',
  auto_refund_enabled: 'bool',
  min_withdraw_cents: 'int',
  order_timeout_minutes: 'int',
  allow_partial_refund: 'bool',
  service_welcome: 'string',
  ai_provider: 'string',
};

module.exports = {
  EDITABLE_SETTINGS,

  mount(router) {
    /* 登录 */
    router.post('/api/admin/login', (ctx) => {
      loginLimiter(`admin:${ctx.ip}`);
      const { username, password } = validate.object(ctx.body, {
        username: { type: 'string', required: true, min: 1, max: 40, label: '账号' },
        password: { type: 'string', required: true, min: 1, max: 64, label: '密码' },
      });
      const admin = ctx.db.get('SELECT * FROM admin_users WHERE username = ?', username);
      if (!admin || !verifyPassword(password, admin.pass_salt, admin.pass_hash)) {
        throw errors.unauthorized('账号或密码错误');
      }
      ctx.db.run('UPDATE admin_users SET last_login_at = ? WHERE id = ?', nowIso(), admin.id);
      writeAudit(ctx.db, { actorType: 'admin', actorId: admin.id, action: 'admin.login' });
      return {
        token: signAdminToken(admin, config),
        admin: { id: admin.id, username: admin.username, role: admin.role },
      };
    });

    router.get('/api/admin/me', { auth: 'admin' }, (ctx) => {
      const admin = ctx.adminAuth();
      return { admin };
    });

    /* 看板 */
    router.get('/api/admin/stats', { auth: 'admin' }, (ctx) => {
      const db = ctx.db;
      const statusRows = db.all('SELECT status, COUNT(*) AS c, SUM(paid_cents) AS paid, SUM(refunded_cents) AS refunded FROM orders GROUP BY status');
      const byStatus = {};
      let orderCount = 0;
      let paidCount = 0;
      let gmvCents = 0;
      let refundedCents = 0;
      for (const r of statusRows) {
        byStatus[r.status] = r.c;
        orderCount += r.c;
        if (['paid', 'completed', 'refunding', 'refunded', 'partial_refunded'].includes(r.status)) {
          paidCount += r.c;
          gmvCents += Number(r.paid || 0);
          refundedCents += Number(r.refunded || 0);
        }
      }
      const commissionRows = db.all(
        'SELECT status, type, SUM(amount_cents) AS s, COUNT(*) AS c FROM commission_entries GROUP BY status, type'
      );
      const commission = { pendingCents: 0, availableCents: 0, reversedCents: 0, totalCount: 0 };
      for (const r of commissionRows) {
        commission.totalCount += r.c;
        if (r.status === 'pending') commission.pendingCents += Number(r.s || 0);
        if (r.status === 'available') commission.availableCents += Number(r.s || 0);
        if (r.type === 'reverse') commission.reversedCents += Number(r.s || 0);
      }
      const today = new Date().toISOString().slice(0, 10);
      const todayRow = db.get(
        `SELECT COUNT(*) AS c, IFNULL(SUM(paid_cents), 0) AS paid FROM orders
         WHERE paid_at IS NOT NULL AND substr(paid_at, 1, 10) = ?`,
        today
      );
      const series = db.all(
        `SELECT substr(paid_at, 1, 10) AS d, COUNT(*) AS c, IFNULL(SUM(paid_cents), 0) AS paid
         FROM orders WHERE paid_at IS NOT NULL GROUP BY d ORDER BY d DESC LIMIT 14`
      );

      return {
        orders: {
          total: orderCount,
          paid: paidCount,
          byStatus,
          gmvCents,
          gmvText: fmtYuan(gmvCents),
          refundedCents,
          refundedText: fmtYuan(refundedCents),
          netCents: gmvCents - refundedCents,
          netText: fmtYuan(gmvCents - refundedCents),
          refundRate: gmvCents > 0 ? Number(((refundedCents / gmvCents) * 100).toFixed(2)) : 0,
        },
        today: { paidOrders: todayRow ? todayRow.c : 0, gmvCents: todayRow ? Number(todayRow.paid) : 0 },
        pending: {
          refunds: db.pluck("SELECT COUNT(*) FROM refunds WHERE status IN ('pending','approved','processing')") || 0,
          withdrawals: db.pluck("SELECT COUNT(*) FROM withdrawals WHERE status IN ('pending','approved')") || 0,
          conversations: db.pluck("SELECT COUNT(*) FROM conversations WHERE status = 'open'") || 0,
        },
        commission,
        users: {
          total: db.pluck('SELECT COUNT(*) FROM users') || 0,
          distributors: db.pluck('SELECT COUNT(*) FROM users WHERE dist_enabled = 1') || 0,
        },
        series: series.reverse().map((s) => ({ date: s.d, orders: s.c, paidCents: Number(s.paid) })),
      };
    });

    /* 设置 */
    router.get('/api/admin/settings', { auth: 'admin' }, (ctx) => ({
      settings: ctx.db.allSettings(),
      editable: EDITABLE_SETTINGS,
      defaults: config.bizDefaults,
    }));

    router.put('/api/admin/settings', { auth: 'admin' }, (ctx) => {
      const admin = ctx.adminAuth();
      const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
      const patch = {};
      for (const [key, value] of Object.entries(body)) {
        const type = EDITABLE_SETTINGS[key];
        if (!type) continue;
        if (type === 'int') {
          const n = Number(value);
          if (!Number.isFinite(n) || n < 0) throw errors.validation(`设置 ${key} 必须是非负数字`);
          patch[key] = Math.trunc(n);
        } else if (type === 'bool') {
          patch[key] = value === true || value === 1 || String(value) === 'true';
        } else {
          patch[key] = String(value).slice(0, 500);
        }
      }
      if (Object.keys(patch).length === 0) throw errors.validation('没有可更新的设置项');
      for (const [k, v] of Object.entries(patch)) ctx.db.setSetting(k, v);
      writeAudit(ctx.db, { actorType: 'admin', actorId: admin.id, action: 'settings.update', detail: patch });
      return { settings: ctx.db.allSettings() };
    });

    /* 快捷话术 */
    router.get('/api/admin/quick-replies', { auth: 'admin' }, (ctx) =>
      ctx.db.all('SELECT * FROM quick_replies ORDER BY sort ASC, id ASC')
    );

    router.post('/api/admin/quick-replies', { auth: 'admin' }, (ctx) => {
      const admin = ctx.adminAuth();
      const { title, content } = validate.object(ctx.body, {
        title: { type: 'string', required: true, min: 1, max: 40, label: '标题' },
        content: { type: 'string', required: true, min: 1, max: 1000, label: '内容' },
      });
      const id = newId('qr_');
      const sort = (ctx.db.pluck('SELECT IFNULL(MAX(sort), 0) FROM quick_replies') || 0) + 1;
      ctx.db.run('INSERT INTO quick_replies (id, title, content, sort) VALUES (?, ?, ?, ?)', id, title, content, sort);
      writeAudit(ctx.db, { actorType: 'admin', actorId: admin.id, action: 'quick_reply.create', targetType: 'quick_reply', targetId: id });
      return ctx.db.get('SELECT * FROM quick_replies WHERE id = ?', id);
    });

    router.delete('/api/admin/quick-replies/:id', { auth: 'admin' }, (ctx) => {
      const admin = ctx.adminAuth();
      const row = ctx.db.get('SELECT * FROM quick_replies WHERE id = ?', ctx.params.id);
      if (!row) throw errors.notFound('话术不存在');
      ctx.db.run('DELETE FROM quick_replies WHERE id = ?', row.id);
      writeAudit(ctx.db, { actorType: 'admin', actorId: admin.id, action: 'quick_reply.delete', targetType: 'quick_reply', targetId: row.id });
      return { deleted: true };
    });

    /* 用户查询（分销/客服用） */
    router.get('/api/admin/users', { auth: 'admin' }, (ctx) => {
      const paging = validate.paging(ctx.query, { defaultSize: 20 });
      const keyword = String(ctx.query.keyword || '').trim();
      const where = keyword ? "WHERE (u.nickname LIKE ? OR u.id LIKE ? OR u.invite_code LIKE ?)" : '';
      const like = `%${keyword}%`;
      const args = keyword ? [like, like, like] : [];
      const total = ctx.db.pluck(`SELECT COUNT(*) FROM users u ${where}`, ...args) || 0;
      const rows = ctx.db.all(
        `SELECT u.id, u.nickname, u.avatar, u.invite_code, u.parent_id, u.dist_enabled, u.created_at,
                p.nickname AS parent_nickname,
                (SELECT COUNT(*) FROM users c WHERE c.parent_id = u.id) AS team_size
         FROM users u LEFT JOIN users p ON p.id = u.parent_id
         ${where}
         ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
        ...args,
        paging.limit,
        paging.offset
      );
      return validate.pageResult(rows, total, paging);
    });

    /* 审计日志 */
    router.get('/api/admin/audit-logs', { auth: 'admin' }, (ctx) => {
      const paging = validate.paging(ctx.query, { defaultSize: 50 });
      const rows = ctx.db.all('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ? OFFSET ?', paging.limit, paging.offset);
      const total = ctx.db.pluck('SELECT COUNT(*) FROM audit_logs') || 0;
      return validate.pageResult(rows, total, paging);
    });
  },
};
