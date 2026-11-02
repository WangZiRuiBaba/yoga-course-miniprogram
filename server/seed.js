'use strict';
/**
 * 种子数据：settings 默认值、后台账号、6 门瑜伽课、快捷话术、三级演示用户（A→B→C）。
 * 幂等：重复执行不会产生重复数据。
 */
const config = require('./config');
const { newId, inviteCode } = require('./utils/id');
const { nowIso } = require('./utils/time');
const { hashPassword } = require('./utils/crypto');

const PRODUCTS = [
  {
    title: '21 天燃脂塑形训练营',
    subtitle: '每天 30 分钟，跟练不掉队',
    type: 'online',
    goal_tags: '减脂,塑形,入门',
    price_cents: 19900,
    original_price_cents: 39900,
    teacher: '林梵',
    duration_min: 30,
    schedule: '每日 1 节 · 共 21 天 · 永久回看',
    sort: 10,
    detail_html:
      '<p>为久坐人群设计的 21 天燃脂计划：</p><ul><li>每天 30 分钟，动作全部可替代，零基础友好</li><li>含 21 天训练日历 + 饮食建议卡</li><li>直播回放永久有效，随时补练</li></ul><p>适合：想减脂、想要陪伴式打卡的学员。</p>',
    skus: [
      { name: '标准版', spec: '21 天跟练营', price_cents: 19900 },
      { name: '陪练版', spec: '含 1 次 1v1 体态评估', price_cents: 29900 },
    ],
  },
  {
    title: '零基础瑜伽入门 12 讲',
    subtitle: '从呼吸开始，让身体先安全',
    type: 'online',
    goal_tags: '入门,舒缓',
    price_cents: 12900,
    original_price_cents: 19900,
    teacher: '周雨禾',
    duration_min: 45,
    schedule: '每周 3 讲 · 共 4 周',
    sort: 20,
    detail_html:
      '<p>12 节系统入门课：呼吸法、站姿、前屈、后弯、扭转、倒立准备。</p><ul><li>每节课附「常见错误」对照</li><li>含 6 套 15 分钟晨间序列</li></ul><p>适合：从没练过瑜伽、或练过但不知道自己在练什么的人。</p>',
    skus: [{ name: '标准版', spec: '12 讲全课程', price_cents: 12900 }],
  },
  {
    title: '私教 1v1 体验课（到店）',
    subtitle: '体态评估 + 定制练习方案',
    type: 'offline',
    goal_tags: '入门,塑形,舒缓',
    price_cents: 9900,
    original_price_cents: 29900,
    teacher: '馆内教练团队',
    duration_min: 60,
    schedule: '预约制 · 到店 60 分钟',
    sort: 30,
    detail_html:
      '<p>60 分钟一对一体态评估课：</p><ul><li>肩颈/骨盆/足弓三点评估</li><li>现场调整 3 个关键动作</li><li>带走一份 30 天定制练习方案</li></ul><p>到店前请提前 4 小时预约；开课前 24 小时可免费退。</p>',
    skus: [
      { name: '单人体验', spec: '1 人 · 60 分钟', price_cents: 9900 },
      { name: '双人同行', spec: '2 人 · 60 分钟', price_cents: 15900 },
    ],
  },
  {
    title: '孕产恢复期温和练习',
    subtitle: '产后复查通过后，循序渐进',
    type: 'online',
    goal_tags: '孕产,舒缓',
    price_cents: 29900,
    original_price_cents: 49900,
    teacher: '苏敏',
    duration_min: 40,
    schedule: '共 16 节 · 永久回看',
    sort: 40,
    detail_html:
      '<p>由孕产方向教练带练，温和循序渐进：</p><ul><li>呼吸与核心激活的基础练习</li><li>骨盆底肌友好序列</li><li>抱娃体态与腰背舒缓</li></ul><p>建议产后复查通过后再开始；本课程为运动练习，不构成医疗建议，有特殊情况请先咨询医生。</p>',
    skus: [{ name: '标准版', spec: '16 节温和练习', price_cents: 29900 }],
  },
  {
    title: '肩颈舒缓放松课',
    subtitle: '办公室人群的 15 分钟放松',
    type: 'online',
    goal_tags: '舒缓,入门',
    price_cents: 6900,
    original_price_cents: 9900,
    teacher: '陈砚',
    duration_min: 15,
    schedule: '共 10 节 · 永久回看',
    sort: 50,
    detail_html:
      '<p>为久坐低头族准备的 10 节放松练习：</p><ul><li>每节 15 分钟，工位/居家皆可练</li><li>含颈部放松、胸椎打开、肩胛稳定</li></ul><p>适合：长期伏案、肩颈紧张、想在工作间隙动一动的人。练习不能替代诊疗，如持续不适请就医。</p>',
    skus: [{ name: '标准版', spec: '10 节放松课', price_cents: 6900 }],
  },
  {
    title: '流瑜伽年卡会员',
    subtitle: '全年不限次直播 + 回放库',
    type: 'membership',
    goal_tags: '减脂,塑形,入门',
    price_cents: 99900,
    original_price_cents: 159900,
    teacher: '林梵',
    duration_min: 60,
    schedule: '365 天有效 · 每日直播',
    sort: 5,
    detail_html:
      '<p>年卡会员权益：</p><ul><li>每日 2 场直播，随时进</li><li>1200+ 节回放课库无限看</li><li>每月 1 次线上答疑</li></ul><p>购买后立即生效，有效期 365 天。</p>',
    skus: [{ name: '年卡', spec: '365 天不限次', price_cents: 99900 }],
  },
];

const QUICK_REPLIES = [
  { title: '课程怎么选', content: '想先了解你的目标：减脂 / 塑形 / 缓解肩颈 / 产后恢复期？我按目标推 1-2 门给你，不用一次买太多。' },
  { title: '怎么上课', content: '线上下单后立即在「我的课程」里可见，直播按课表进，回放永久有效。' },
  { title: '退款政策', content: '未开课/未观看的课程 7 天内可申请退款；到店私教课开课前 24 小时可免费退。' },
  { title: '到店地址', content: '门店地址：城市中心馆 3 层（示例地址）。到店前请提前 4 小时在订单里预约。' },
  { title: '分销怎么玩', content: '在小程序「分销中心」生成专属邀请码，好友下单你可获得佣金，二级好友下单还有二级佣金，佣金 7 天后可提现。' },
  { title: '已付款没到账', content: '支付偶有延迟，通常 1 分钟内到账；超过 5 分钟请联系我，我这边帮你查单号。' },
];

function seed(db, { quiet = false } = {}) {
  const log = quiet ? () => {} : (...a) => console.log(...a);
  const ts = nowIso();

  db.tx(() => {
    /* ---- settings ---- */
    for (const [key, value] of Object.entries(config.bizDefaults)) {
      db.run(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING',
        key,
        JSON.stringify(value),
        ts
      );
    }

    /* ---- 后台账号 ---- */
    const adminCount = db.pluck('SELECT COUNT(*) FROM admin_users');
    if (!adminCount) {
      const { salt, hash } = hashPassword(config.admin.password);
      db.run(
        'INSERT INTO admin_users (id, username, pass_salt, pass_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        newId('adm_'),
        config.admin.username,
        salt,
        hash,
        'admin',
        ts
      );
      log(`  · 后台账号 ${config.admin.username} / ${config.admin.password}`);
    }

    /* ---- 商品 ---- */
    const productCount = db.pluck('SELECT COUNT(*) FROM products');
    if (!productCount) {
      for (const p of PRODUCTS) {
        const id = newId('p_');
        db.run(
          `INSERT INTO products
            (id, title, subtitle, cover, type, goal_tags, price_cents, original_price_cents,
             stock, sales, status, teacher, duration_min, schedule, detail_html, sort, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'on', ?, ?, ?, ?, ?, ?, ?)`,
          id,
          p.title,
          p.subtitle,
          `/api/media/cover/${id}`,
          p.type,
          p.goal_tags,
          p.price_cents,
          p.original_price_cents,
          999,
          Math.floor(Math.random() * 120) + 8,
          p.teacher,
          p.duration_min,
          p.schedule,
          p.detail_html,
          p.sort,
          ts,
          ts
        );
        for (const [i, s] of (p.skus || []).entries()) {
          db.run(
            `INSERT INTO skus (id, product_id, name, spec, price_cents, stock, status, sort, created_at)
             VALUES (?, ?, ?, ?, ?, 999, 'on', ?, ?)`,
            newId('sku_'),
            id,
            s.name,
            s.spec,
            s.price_cents,
            i,
            ts
          );
        }
      }
      log(`  · 商品 ${PRODUCTS.length} 门`);
    }

    /* ---- 快捷话术 ---- */
    const qrCount = db.pluck('SELECT COUNT(*) FROM quick_replies');
    if (!qrCount) {
      QUICK_REPLIES.forEach((q, i) => {
        db.run(
          'INSERT INTO quick_replies (id, title, content, sort) VALUES (?, ?, ?, ?)',
          newId('qr_'),
          q.title,
          q.content,
          i
        );
      });
      log(`  · 快捷话术 ${QUICK_REPLIES.length} 条`);
    }

    /* ---- 演示用户：A 邀 B、B 邀 C ---- */
    const demos = [
      { openid: 'dev_demo_a', nickname: '馆主·林梵', code: 'DEMOA', parent: null },
      { openid: 'dev_demo_b', nickname: '学员·小满', code: 'DEMOB', parent: 'dev_demo_a' },
      { openid: 'dev_demo_c', nickname: '学员·阿橘', code: 'DEMOC', parent: 'dev_demo_b' },
    ];
    const ids = {};
    for (const d of demos) {
      const exist = db.get('SELECT id FROM users WHERE openid = ?', d.openid);
      if (exist) {
        ids[d.openid] = exist.id;
        continue;
      }
      const id = newId('u_');
      ids[d.openid] = id;
      db.run(
        `INSERT INTO users (id, openid, nickname, avatar, role, parent_id, invite_code, dist_enabled, created_at, updated_at)
         VALUES (?, ?, ?, '', 'user', ?, ?, 1, ?, ?)`,
        id,
        d.openid,
        d.nickname,
        d.parent ? ids[d.parent] || null : null,
        d.code,
        ts,
        ts
      );
    }
    log('  · 演示用户 A/B/C（dev_demo_a / dev_demo_b / dev_demo_c）');
  });

  return db;
}

function ensureInviteCodes(db) {
  const rows = db.all('SELECT id FROM users WHERE invite_code IS NULL OR invite_code = \'\'');
  for (const r of rows) {
    let code = inviteCode();
    for (let i = 0; i < 5; i++) {
      if (!db.get('SELECT 1 AS x FROM users WHERE invite_code = ?', code)) break;
      code = inviteCode();
    }
    db.run('UPDATE users SET invite_code = ? WHERE id = ?', code, r.id);
  }
}

module.exports = { seed, ensureInviteCodes, PRODUCTS };

if (require.main === module) {
  const { openDb } = require('./db');
  const db = openDb(config.dbPath);
  seed(db);
  ensureInviteCodes(db);
  console.log(`[seed] 完成 -> ${config.dbPath}`);
  db.close();
}
