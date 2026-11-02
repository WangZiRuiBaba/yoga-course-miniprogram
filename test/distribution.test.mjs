/**
 * 二级分销 / 佣金 / 提现 集成测试（node:test）。
 *
 *   node --test test/distribution.test.mjs
 *
 * 不依赖 commerce 模块：订单直接写库，再用 events.emit('order.paid' / 'refund.succeeded')
 * 模拟支付成功与退款成功（payload 见 docs/API.md 5.1 / 6.2）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, startServer, api, demoLogin, adminLogin, assertOk } from './helpers.mjs';

const cjsRequire = createRequire(import.meta.url);
const events = cjsRequire(path.join(ROOT, 'server', 'events.js'));
const sweep = cjsRequire(path.join(ROOT, 'server', 'sweep.js'));

test('二级分销：绑定 / 两级佣金 / 冲正 / 解冻 / 提现', async (t) => {
  const app = await startServer();
  const db = app.db;
  t.after(() => app.close());

  const user = (openid) => db.get('SELECT * FROM users WHERE openid = ?', openid);
  const entryCount = (orderId, extra = '') =>
    Number(db.pluck(`SELECT COUNT(*) FROM commission_entries WHERE order_id = ? ${extra}`, orderId));

  /** 直接插一条 paid 订单并广播 order.paid（commerce 未就绪也能测） */
  async function payOrder({ id, no, userId, cents = 19900 }) {
    const ts = new Date().toISOString();
    db.run(
      `INSERT INTO orders
         (id, order_no, user_id, status, total_cents, paid_cents, refunded_cents, commission_base_cents,
          source, remark, cancel_reason, expire_at, paid_at, closed_at, created_at, updated_at)
       VALUES (?, ?, ?, 'paid', ?, ?, 0, ?, 'h5', '', '', NULL, ?, NULL, ?, ?)`,
      id,
      no,
      userId,
      cents,
      cents,
      cents,
      ts,
      ts,
      ts
    );
    return events.emit('order.paid', {
      orderId: id,
      orderNo: no,
      userId,
      paidCents: cents,
      commissionBaseCents: cents,
      paidAt: ts,
      items: [{ productId: 'prd_demo', title: '演示课程', quantity: 1, priceCents: cents }],
    });
  }

  /** 直接插一条退款单并广播 refund.succeeded */
  async function refundOrder({ orderId, orderNo, userId, refundId, refundNo, amountCents, fullRefund }) {
    const ts = new Date().toISOString();
    db.run(
      `INSERT INTO refunds (id, refund_no, order_id, user_id, amount_cents, reason, status, refunded_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '测试退款', 'succeeded', ?, ?, ?)`,
      refundId,
      refundNo,
      orderId,
      userId,
      amountCents,
      ts,
      ts,
      ts
    );
    if (fullRefund) {
      db.run("UPDATE orders SET status = 'refunded', refunded_cents = paid_cents, updated_at = ? WHERE id = ?", ts, orderId);
    }
    return events.emit('refund.succeeded', {
      refundId,
      refundNo,
      orderId,
      orderNo,
      userId,
      amountCents,
      refundedAt: ts,
      fullRefund,
    });
  }

  const tokenA = await demoLogin(app.base, 'dev_demo_a');
  const tokenB = await demoLogin(app.base, 'dev_demo_b');
  const tokenC = await demoLogin(app.base, 'dev_demo_c');
  const adminToken = await adminLogin(app.base);
  const A = user('dev_demo_a');
  const B = user('dev_demo_b');
  const C = user('dev_demo_c');

  const L1_BPS = db.getSettingNumber('commission_l1_bps', 1500);
  const L2_BPS = db.getSettingNumber('commission_l2_bps', 500);
  const FREEZE_DAYS = db.getSettingNumber('freeze_days', 7);
  const MIN_WD = db.getSettingNumber('min_withdraw_cents', 1000);
  const BASE = 19900;
  const C_L1 = Math.floor((BASE * L1_BPS) / 10000); // C 的一级佣金 = B 得
  const C_L2 = Math.floor((BASE * L2_BPS) / 10000); // C 的二级佣金 = A 得

  await t.test('未登录访问分销接口返回 401', async () => {
    const r = await api(app.base, 'GET', '/api/dist/overview');
    assert.equal(r.status, 401);
    assert.equal(r.code, 'UNAUTHORIZED');
  });

  await t.test('绑定：A 邀请新用户成功，重复绑定 / 自绑 / 无效码 / 成环全被拦住', async () => {
    const tokenX = await demoLogin(app.base, 'dist_x');
    const r1 = await api(app.base, 'POST', '/api/dist/bind', {
      token: tokenX,
      body: { inviteCode: 'DEMOA' },
    });
    const d1 = assertOk(r1, '绑定邀请码');
    assert.equal(d1.parentId, A.id);
    assert.equal(d1.inviteCode, 'DEMOA');
    assert.ok(d1.parentNickname.includes('*'), '上级昵称应脱敏');
    assert.equal(user('dist_x').parent_id, A.id);

    // 绑定日志 + 审计
    assert.ok(Number(db.pluck("SELECT COUNT(*) FROM bind_logs WHERE user_id = ?", user('dist_x').id)) >= 1);

    const r2 = await api(app.base, 'POST', '/api/dist/bind', { token: tokenX, body: { inviteCode: 'DEMOB' } });
    assert.equal(r2.status, 409);
    assert.equal(r2.code, 'DUPLICATE');

    // 自绑
    const tokenZ = await demoLogin(app.base, 'dist_z');
    const zCode = user('dist_z').invite_code;
    const r3 = await api(app.base, 'POST', '/api/dist/bind', { token: tokenZ, body: { inviteCode: zCode } });
    assert.equal(r3.status, 422);
    assert.equal(r3.code, 'VALIDATION_ERROR');
    assert.match(r3.message, /自己/);

    // 无效邀请码
    const r4 = await api(app.base, 'POST', '/api/dist/bind', { token: tokenZ, body: { inviteCode: 'NOPE99' } });
    assert.equal(r4.status, 404);
    assert.equal(r4.code, 'NOT_FOUND');

    // 成环：A（无上级）用 C 的码 → C→B→A 命中自己
    const r5 = await api(app.base, 'POST', '/api/dist/bind', { token: tokenA, body: { inviteCode: 'DEMOC' } });
    assert.equal(r5.status, 422);
    assert.match(r5.message, /闭环/);
    assert.equal(user('dev_demo_a').parent_id, null);
  });

  await t.test('两级佣金：C 支付后 B 得 15%、A 得 5%，重复投递不重复发钱', async () => {
    await payOrder({ id: 'ord_dist_1', no: 'YODIST0001', userId: C.id });

    const e1 = db.get("SELECT * FROM commission_entries WHERE order_id = 'ord_dist_1' AND level = 1");
    const e2 = db.get("SELECT * FROM commission_entries WHERE order_id = 'ord_dist_1' AND level = 2");
    assert.ok(e1 && e2, '两个层级都应生成佣金');
    assert.equal(e1.user_id, B.id, '一级佣金归直接上级 B');
    assert.equal(e2.user_id, A.id, '二级佣金归 B 的上级 A');
    assert.equal(e1.amount_cents, C_L1);
    assert.equal(e2.amount_cents, C_L2);
    assert.equal(e1.rate_bps, L1_BPS);
    assert.equal(e2.rate_bps, L2_BPS);
    assert.equal(e1.status, 'pending');
    assert.equal(e2.status, 'pending');
    assert.equal(e1.type, 'commission');

    // 冻结天数来自 settings
    const paidAt = new Date(db.get("SELECT paid_at FROM orders WHERE id = 'ord_dist_1'").paid_at).getTime();
    const availableAt = new Date(e1.available_at).getTime();
    assert.equal(availableAt - paidAt, FREEZE_DAYS * 86400000);

    // 余额：全部冻结
    const ov = assertOk(await api(app.base, 'GET', '/api/dist/overview', { token: tokenB }), 'B 概览');
    assert.equal(ov.balance.pendingCents, C_L1);
    assert.equal(ov.balance.availableCents, 0);

    // 重复投递（同一订单再发一次）
    await events.emit('order.paid', {
      orderId: 'ord_dist_1',
      orderNo: 'YODIST0001',
      userId: C.id,
      paidCents: BASE,
      commissionBaseCents: BASE,
      paidAt: new Date().toISOString(),
    });
    assert.equal(entryCount('ord_dist_1'), 2, '重复投递不能重复发佣金');
  });

  await t.test('退款冲正：两条佣金置 cancelled + 两条负数反向条目，重复投递只冲一次', async () => {
    await refundOrder({
      orderId: 'ord_dist_1',
      orderNo: 'YODIST0001',
      userId: C.id,
      refundId: 'rfd_dist_1',
      refundNo: 'RFDIST0001',
      amountCents: BASE,
      fullRefund: true,
    });

    const rows = db.all("SELECT * FROM commission_entries WHERE order_id = 'ord_dist_1' ORDER BY type, level");
    const reverse = rows.filter((r) => r.type === 'reverse');
    const commission = rows.filter((r) => r.type === 'commission');
    assert.equal(reverse.length, 2);
    assert.equal(commission.length, 2);
    assert.ok(commission.every((r) => r.status === 'cancelled'), '原条目应置 cancelled');
    assert.ok(reverse.every((r) => r.amount_cents < 0), '反向条目金额为负');
    assert.ok(reverse.every((r) => r.refund_id === 'rfd_dist_1'));
    assert.equal(reverse.find((r) => r.level === 1).amount_cents, -C_L1);
    assert.equal(reverse.find((r) => r.level === 2).amount_cents, -C_L2);

    // 余额归零（不再有可提现/冻结）
    const ovB = assertOk(await api(app.base, 'GET', '/api/dist/overview', { token: tokenB }), 'B 概览');
    assert.equal(ovB.balance.pendingCents, 0);
    assert.equal(ovB.balance.availableCents, 0);

    // 重复投递退款事件：不能重复冲正
    await events.emit('refund.succeeded', {
      refundId: 'rfd_dist_1',
      refundNo: 'RFDIST0001',
      orderId: 'ord_dist_1',
      orderNo: 'YODIST0001',
      userId: C.id,
      amountCents: BASE,
      refundedAt: new Date().toISOString(),
      fullRefund: true,
    });
    assert.equal(entryCount('ord_dist_1', "AND type = 'reverse'"), 2, '同一退款只能冲正一次');
    assert.equal(entryCount('ord_dist_1'), 4);
  });

  await t.test('解冻：pending -> available（available_at 置为过去后 sweep.tick）', async () => {
    // 新人绑定到 B 后下单 → B 一级、A 二级
    const tokenBuyer = await demoLogin(app.base, 'dist_buyer_1');
    assertOk(
      await api(app.base, 'POST', '/api/dist/bind', { token: tokenBuyer, body: { inviteCode: 'DEMOB' } }),
      '买家绑定 B'
    );
    await payOrder({ id: 'ord_dist_2', no: 'YODIST0002', userId: user('dist_buyer_1').id });

    assert.equal(entryCount('ord_dist_2'), 2);
    const before = assertOk(await api(app.base, 'GET', '/api/dist/overview', { token: tokenB }), 'B 概览');
    assert.equal(before.balance.availableCents, 0);
    assert.equal(before.balance.pendingCents, C_L1);

    // 把解冻时间改到过去，跑一次 sweeper
    const past = new Date(Date.now() - 60000).toISOString();
    db.run("UPDATE commission_entries SET available_at = ? WHERE order_id = 'ord_dist_2'", past);
    sweep.tick();

    const after = assertOk(await api(app.base, 'GET', '/api/dist/overview', { token: tokenB }), 'B 概览');
    assert.equal(after.balance.pendingCents, 0);
    assert.equal(after.balance.availableCents, C_L1);
    assert.equal(
      Number(db.pluck("SELECT COUNT(*) FROM commission_entries WHERE order_id = 'ord_dist_2' AND status = 'available'")),
      2
    );

    const ovA = assertOk(await api(app.base, 'GET', '/api/dist/overview', { token: tokenA }), 'A 概览');
    assert.equal(ovA.balance.availableCents, C_L2);
  });

  await t.test('提现：低门槛被拒 / 超余额被拒 / 正常扣减 / 驳回退回 / 打款结算', async () => {
    const low = await api(app.base, 'POST', '/api/dist/withdrawals', {
      token: tokenB,
      body: { amountCents: MIN_WD - 1 },
    });
    assert.equal(low.status, 422);
    assert.equal(low.code, 'VALIDATION_ERROR');
    assert.match(low.message, /不能低于/);

    const tooMuch = await api(app.base, 'POST', '/api/dist/withdrawals', {
      token: tokenB,
      body: { amountCents: C_L1 + 1000 },
    });
    assert.equal(tooMuch.status, 409);
    assert.equal(tooMuch.code, 'INSUFFICIENT_BALANCE');

    // 正常提现 → 占用余额
    const ok1 = assertOk(
      await api(app.base, 'POST', '/api/dist/withdrawals', {
        token: tokenB,
        body: { amountCents: 2000, channel: 'wechat', account: 'wx_demo' },
      }),
      '申请提现'
    );
    assert.equal(ok1.withdrawal.status, 'pending');
    assert.equal(ok1.withdrawal.amountCents, 2000);
    assert.equal(ok1.withdrawal.amountText, '20.00');
    assert.equal(ok1.balance.availableCents, C_L1 - 2000);

    const ovAfter = assertOk(await api(app.base, 'GET', '/api/dist/overview', { token: tokenB }), 'B 概览');
    assert.equal(ovAfter.balance.availableCents, C_L1 - 2000);

    // 占用后再提超余额被拒
    const blocked = await api(app.base, 'POST', '/api/dist/withdrawals', {
      token: tokenB,
      body: { amountCents: C_L1 },
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.code, 'INSUFFICIENT_BALANCE');

    // 后台驳回 → 余额退回
    const rejected = assertOk(
      await api(app.base, 'POST', `/api/admin/withdrawals/${ok1.withdrawal.id}/reject`, {
        adminToken,
        body: { reason: '账号信息不完整' },
      }),
      '驳回提现'
    );
    assert.equal(rejected.withdrawal.status, 'rejected');
    assert.equal(rejected.withdrawal.reviewNote, '账号信息不完整');
    assert.equal(rejected.balance.availableCents, C_L1);

    // 驳回后不能重复审核
    const again = await api(app.base, 'POST', `/api/admin/withdrawals/${ok1.withdrawal.id}/approve`, { adminToken });
    assert.equal(again.status, 409);
    assert.equal(again.code, 'INVALID_STATE');

    // 全额提现 → 通过 → 打款
    const full = assertOk(
      await api(app.base, 'POST', '/api/dist/withdrawals', { token: tokenB, body: { amountCents: C_L1 } }),
      '全额提现'
    );
    assert.equal(full.balance.availableCents, 0);

    const approved = assertOk(
      await api(app.base, 'POST', `/api/admin/withdrawals/${full.withdrawal.id}/approve`, { adminToken }),
      '通过提现'
    );
    assert.equal(approved.withdrawal.status, 'approved');

    const paid = assertOk(
      await api(app.base, 'POST', `/api/admin/withdrawals/${full.withdrawal.id}/paid`, { adminToken }),
      '标记打款'
    );
    assert.equal(paid.withdrawal.status, 'paid');
    assert.ok(paid.withdrawal.paidAt);
    assert.equal(paid.balance.availableCents, 0);
    assert.equal(paid.balance.settledCents, C_L1);

    const list = assertOk(await api(app.base, 'GET', '/api/dist/withdrawals', { token: tokenB }), '提现记录');
    assert.equal(list.total, 2);
    assert.ok(list.list.every((w) => w.amountText && w.statusText));

    // 审计留痕
    assert.ok(Number(db.pluck("SELECT COUNT(*) FROM audit_logs WHERE action = 'dist.withdraw.paid'")) >= 1);
    assert.ok(Number(db.pluck("SELECT COUNT(*) FROM audit_logs WHERE action = 'dist.withdraw.reject'")) >= 1);
  });

  await t.test('上级未开通分销时跳过该级，开通后恢复发放', async () => {
    const tokenP = await demoLogin(app.base, 'dist_parent_p');
    const P = user('dist_parent_p');
    db.run('UPDATE users SET dist_enabled = 0 WHERE id = ?', P.id);

    const tokenQ = await demoLogin(app.base, 'dist_child_q');
    assertOk(
      await api(app.base, 'POST', '/api/dist/bind', { token: tokenQ, body: { inviteCode: P.invite_code } }),
      'Q 绑定 P'
    );

    await payOrder({ id: 'ord_dist_3', no: 'YODIST0003', userId: user('dist_child_q').id });
    assert.equal(entryCount('ord_dist_3'), 0, '未开通分销的上级不发佣金');

    const enabled = assertOk(await api(app.base, 'POST', '/api/dist/enable', { token: tokenP }), '开通分销');
    assert.equal(enabled.isDistributor, true);
    assert.equal(enabled.inviteCode, P.invite_code);
    assert.match(enabled.inviteUrl, /#\/join\?code=/);

    await payOrder({ id: 'ord_dist_4', no: 'YODIST0004', userId: user('dist_child_q').id });
    const rows = db.all("SELECT * FROM commission_entries WHERE order_id = 'ord_dist_4'");
    assert.equal(rows.length, 1, '开通后只发一级（P 没有上级）');
    assert.equal(rows[0].user_id, P.id);
    assert.equal(rows[0].level, 1);
    assert.equal(rows[0].amount_cents, C_L1);
  });

  await t.test('用户端接口形态：overview / invite / team / commissions 出参 camelCase', async () => {
    const ov = assertOk(await api(app.base, 'GET', '/api/dist/overview', { token: tokenA }), 'A 概览');
    assert.equal(ov.isDistributor, true);
    assert.equal(ov.inviteCode, 'DEMOA');
    assert.match(ov.inviteUrl, /#\/join\?code=DEMOA$/);
    assert.equal(ov.level, 1);
    assert.equal(ov.teamSize, 2); // B + dist_x
    assert.equal(typeof ov.balance.availableCents, 'number');
    assert.equal(ov.balance.availableText, (ov.balance.availableCents / 100).toFixed(2));
    assert.equal(ov.balance.minWithdrawCents, MIN_WD);
    assert.equal(ov.balance.minWithdrawText, (MIN_WD / 100).toFixed(2));
    assert.equal(ov.rules.l1Text, '15%');
    assert.equal(ov.rules.l2Text, '5%');
    assert.ok(Array.isArray(ov.recent));
    assert.ok(ov.recent.length <= 5);

    const invite = assertOk(await api(app.base, 'GET', '/api/dist/invite', { token: tokenA }), '邀请信息');
    assert.equal(invite.inviteCode, 'DEMOA');
    assert.ok(Array.isArray(invite.tips) && invite.tips.length >= 2);

    const team1 = assertOk(await api(app.base, 'GET', '/api/dist/team?level=1&page=1&size=20', { token: tokenA }), '一级团队');
    assert.ok(team1.list.length >= 2);
    assert.ok(team1.list.every((m) => m.nickname.includes('*')), '团队成员昵称脱敏');
    assert.ok(team1.list.every((m) => typeof m.orderCount === 'number'));

    const team2 = assertOk(await api(app.base, 'GET', '/api/dist/team?level=2', { token: tokenA }), '二级团队');
    assert.equal(team2.level, 2);
    assert.ok(team2.list.some((m) => m.userId === C.id), 'C 应在 A 的二级团队里');

    const badLevel = await api(app.base, 'GET', '/api/dist/team?level=3', { token: tokenA });
    assert.equal(badLevel.status, 422);

    const commissions = assertOk(
      await api(app.base, 'GET', '/api/dist/commissions?status=available', { token: tokenA }),
      '佣金流水'
    );
    assert.ok(commissions.list.every((e) => e.status === 'available'));
    assert.ok(commissions.list.every((e) => typeof e.amountText === 'string' && e.rateText));

    const reversed = assertOk(
      await api(app.base, 'GET', '/api/dist/commissions?status=reversed', { token: tokenA }),
      '冲正流水'
    );
    assert.ok(reversed.list.some((e) => e.type === 'reverse' && e.amountCents < 0));
  });

  await t.test('后台接口：分销员排行 / 提现列表 / 手工调整', async () => {
    const dist = assertOk(await api(app.base, 'GET', '/api/admin/dist?page=1&size=50', { adminToken }), '分销员列表');
    assert.ok(dist.total >= 3);
    assert.ok(dist.list.some((d) => d.userId === A.id));
    const aRow = dist.list.find((d) => d.userId === A.id);
    assert.equal(aRow.inviteCode, 'DEMOA');
    assert.equal(aRow.teamSize, 2);
    assert.equal(typeof aRow.availableCents, 'number');
    assert.equal(typeof aRow.earnedText, 'string');

    const wd = assertOk(await api(app.base, 'GET', '/api/admin/withdrawals?status=paid', { adminToken }), '提现列表');
    assert.ok(wd.list.some((w) => w.user && w.user.id === B.id));
    assert.equal(typeof wd.summary.paidText, 'string');

    const before = assertOk(await api(app.base, 'GET', '/api/dist/overview', { token: tokenA }), 'A 概览');
    const adj = assertOk(
      await api(app.base, 'POST', '/api/admin/dist/adjust', {
        adminToken,
        body: { userId: A.id, amountCents: 500, note: '双十一活动奖励' },
      }),
      '手工调整'
    );
    assert.equal(adj.entry.type, 'adjust');
    assert.equal(adj.entry.amountCents, 500);
    assert.equal(adj.entry.status, 'available');
    assert.equal(adj.balance.availableCents, before.balance.availableCents + 500);

    const after = assertOk(await api(app.base, 'GET', '/api/dist/overview', { token: tokenA }), 'A 概览');
    assert.equal(after.balance.availableCents, before.balance.availableCents + 500);

    // 调整必须写审计
    assert.ok(Number(db.pluck("SELECT COUNT(*) FROM audit_logs WHERE action = 'dist.adjust'")) >= 1);

    // 参数校验：金额为 0 被拒
    const zero = await api(app.base, 'POST', '/api/admin/dist/adjust', {
      adminToken,
      body: { userId: A.id, amountCents: 0, note: '零' },
    });
    assert.equal(zero.status, 422);

    // 非管理员不能访问后台接口
    const forbidden = await api(app.base, 'GET', '/api/admin/dist', { token: tokenA });
    assert.equal(forbidden.status, 401);
  });
});
