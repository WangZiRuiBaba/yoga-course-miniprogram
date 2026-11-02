'use strict';
/**
 * 商品服务（契约第 3 章）。
 * 出参 camelCase，金额整数「分」+ xxxText（fmtYuan），时间 ISO-8601。
 * HTTP 层（index.js / admin/products.js）只做参数适配，业务规则都在这里。
 */
const validate = require('../../http/validate');
const { errors } = require('../../http/errors');
const { newId } = require('../../utils/id');
const { nowIso } = require('../../utils/time');
const { fmtYuan, centsToYuanString, yuanToCents } = require('../../utils/money');

const PRODUCT_TYPES = ['online', 'offline', 'membership'];
const PRODUCT_STATUS = ['on', 'off'];
const GOALS = [
  { key: '减脂', label: '减脂', icon: '🔥' },
  { key: '塑形', label: '塑形', icon: '💃' },
  { key: '孕产', label: '孕产', icon: '🤰' },
  { key: '舒缓', label: '舒缓', icon: '🌿' },
  { key: '入门', label: '入门', icon: '🌱' },
  { key: '进阶', label: '进阶', icon: '🚀' },
];

/* ------------------------------------------------------------------ *
 * 映射
 * ------------------------------------------------------------------ */
function splitTags(value) {
  if (Array.isArray(value)) {
    return value.map((v) => String(v == null ? '' : v).trim()).filter((v) => v.length > 0);
  }
  return String(value == null ? '' : value)
    .split(/[,，、|\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function discountTextOf(priceCents, originalPriceCents) {
  const price = Number(priceCents || 0);
  const original = Number(originalPriceCents || 0);
  if (!(original > price) || price < 0) return '';
  if (price === 0) return '免费';
  const discount = Math.round((price / original) * 100) / 10;
  return `${discount.toFixed(1)} 折`;
}

function badgesOf(row) {
  const out = [];
  if (Number(row.sales || 0) >= 80) out.push('热卖');
  if (Number(row.original_price_cents || 0) > Number(row.price_cents || 0)) out.push('限时折扣');
  if (row.type === 'membership') out.push('会员专享');
  if (!out.length) out.push('新课上架');
  return out.slice(0, 2);
}

/** 商品卡（前端列表/首页统一结构） */
function publicProduct(row) {
  if (!row) return null;
  const priceCents = Number(row.price_cents || 0);
  const originalPriceCents = Number(row.original_price_cents || 0);
  return {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle || '',
    cover: row.cover || `/api/media/cover/${row.id}`,
    type: row.type || 'online',
    goalTags: splitTags(row.goal_tags),
    priceCents,
    priceText: centsToYuanString(priceCents),
    priceLabel: fmtYuan(priceCents),
    originalPriceCents,
    originalPriceText: centsToYuanString(originalPriceCents),
    originalPriceLabel: fmtYuan(originalPriceCents),
    discountText: discountTextOf(priceCents, originalPriceCents),
    stock: Number(row.stock || 0),
    sales: Number(row.sales || 0),
    teacher: row.teacher || '',
    durationMin: Number(row.duration_min || 0),
    schedule: row.schedule || '',
    badges: badgesOf(row),
  };
}

function publicSku(row) {
  const priceCents = Number(row.price_cents || 0);
  return {
    id: row.id,
    productId: row.product_id,
    name: row.name,
    spec: row.spec || '',
    priceCents,
    priceText: centsToYuanString(priceCents),
    priceLabel: fmtYuan(priceCents),
    stock: Number(row.stock || 0),
    status: row.status || 'on',
  };
}

/** 后台视角：商品卡 + 上下架状态 + sku 明细 */
function adminProduct(db, row) {
  if (!row) return null;
  const skus = db.all('SELECT * FROM skus WHERE product_id = ? ORDER BY sort ASC, created_at ASC', row.id);
  return {
    ...publicProduct(row),
    status: row.status,
    sort: Number(row.sort || 0),
    detailHtml: row.detail_html || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    skus: skus.map(publicSku),
  };
}

function firstTag(value) {
  const tags = splitTags(value);
  return tags.length ? tags[0] : '';
}

function faqOf(db, row) {
  const windowDays = db.getSettingNumber('refund_window_days', 7);
  const tags = splitTags(row.goal_tags);
  return [
    {
      q: '怎么上课？',
      a:
        row.type === 'offline'
          ? '到店前请提前 4 小时在订单里预约，到前台出示 8 位核销码签到。'
          : '支付成功后立即可见：在「我的课程」凭 8 位核销码进入直播或回放。',
    },
    {
      q: '可以退款吗？',
      a: `支付后 ${windowDays} 天内、课程未核销可申请退款，原路退回；部分退款保留已购权益。`,
    },
    {
      q: '有效期多久？',
      a: row.type === 'membership' ? '自支付成功起 365 天，期内不限次上课。' : '长期有效，可反复回看。',
    },
    {
      q: '零基础能练吗？',
      a: tags.includes('入门')
        ? '可以，本课按零基础设计，每个动作都有替代方案。'
        : '建议先完成「零基础瑜伽入门」再进入本课，避免代偿。',
    },
  ];
}

function sanitizeHtml(html) {
  let out = String(html == null ? '' : html);
  out = out.replace(/<\s*(script|style|iframe|object|embed|link|meta)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  out = out.replace(/<\s*(script|style|iframe|object|embed|link|meta)[^>]*\/?>/gi, '');
  out = out.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  out = out.replace(/javascript:/gi, '');
  return out.trim();
}

/* ------------------------------------------------------------------ *
 * 查询
 * ------------------------------------------------------------------ */
const SORTS = {
  hot: 'p.sales DESC, p.sort ASC, p.created_at DESC',
  new: 'p.created_at DESC, p.sort ASC',
  price_asc: 'p.price_cents ASC, p.sort ASC',
  price_desc: 'p.price_cents DESC, p.sort ASC',
};

function listProducts(db, query = {}) {
  const paging = validate.paging(query);
  const where = ["p.status = 'on'"];
  const args = [];

  const type = String(query.type || '').trim();
  if (type && PRODUCT_TYPES.includes(type)) {
    where.push('p.type = ?');
    args.push(type);
  }
  const goal = String(query.goal || '').trim();
  if (goal) {
    where.push('p.goal_tags LIKE ?');
    args.push(`%${goal}%`);
  }
  const keyword = String(query.keyword || '').trim();
  if (keyword) {
    where.push('(p.title LIKE ? OR p.subtitle LIKE ? OR p.goal_tags LIKE ? OR p.teacher LIKE ?)');
    const like = `%${keyword}%`;
    args.push(like, like, like, like);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const orderSql = SORTS[String(query.sort || '')] || SORTS.hot;
  const total = db.pluck(`SELECT COUNT(*) FROM products p ${whereSql}`, ...args) || 0;
  const rows = db.all(
    `SELECT p.* FROM products p ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`,
    ...args,
    paging.limit,
    paging.offset
  );
  return validate.pageResult(rows.map(publicProduct), total, paging);
}

function getProductDetail(db, id) {
  const row = db.get('SELECT * FROM products WHERE id = ?', String(id == null ? '' : id));
  if (!row || row.status !== 'on') throw errors.notFound('课程不存在或已下架');
  const skus = db
    .all("SELECT * FROM skus WHERE product_id = ? AND status = 'on' ORDER BY sort ASC, created_at ASC", row.id)
    .map(publicSku);
  const faq = faqOf(db, row);
  const related = db
    .all(
      `SELECT * FROM products
       WHERE status = 'on' AND id <> ?
         AND (type = ? OR goal_tags LIKE ?)
       ORDER BY sales DESC, sort ASC LIMIT 4`,
      row.id,
      row.type,
      `%${firstTag(row.goal_tags)}%`
    )
    .map(publicProduct);
  return {
    product: { ...publicProduct(row), detailHtml: sanitizeHtml(row.detail_html) },
    skus,
    faq,
    related,
  };
}

function homeData(db) {
  const rows = db.all("SELECT * FROM products WHERE status = 'on' ORDER BY sort ASC, sales DESC");
  const cards = rows.map(publicProduct);
  const bySales = [...cards].sort((a, b) => b.sales - a.sales);

  const banners = cards.slice(0, 3).map((c, i) => ({
    id: `bn_${i + 1}`,
    productId: c.id,
    title: c.title,
    subtitle: c.subtitle,
    cover: c.cover,
    link: `/#/product/${c.id}`,
    priceText: c.priceText,
  }));

  const sections = [
    { key: 'hot', title: '热门课程', subtitle: '学员都在练', products: bySales.slice(0, 4) },
    {
      key: 'beginner',
      title: '零基础入门',
      subtitle: '从呼吸和站姿开始',
      products: cards.filter((c) => c.goalTags.includes('入门')).slice(0, 4),
    },
    {
      key: 'membership',
      title: '会员专享',
      subtitle: '一年内不限次上课',
      products: cards.filter((c) => c.type === 'membership').slice(0, 4),
    },
    {
      key: 'discount',
      title: '限时折扣',
      subtitle: '手慢无',
      products: [...cards]
        .filter((c) => c.originalPriceCents > c.priceCents)
        .sort((a, b) => b.originalPriceCents - b.priceCents - (a.originalPriceCents - a.priceCents))
        .slice(0, 4),
    },
  ].filter((s) => s.products.length > 0);

  return {
    banners,
    sections,
    notice: db.getSetting('home_notice', '新学员首单专享价，未核销课程 7 天内可退。'),
  };
}

function goals(db) {
  const rows = db.all("SELECT goal_tags FROM products WHERE status = 'on'");
  const counts = new Map();
  for (const row of rows) {
    for (const tag of splitTags(row.goal_tags)) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return GOALS.map((g) => ({ ...g, count: counts.get(g.key) || 0 }));
}

/* ------------------------------------------------------------------ *
 * 后台 CRUD
 * ------------------------------------------------------------------ */
function resolveCents(input, centsKey, yuanKey, label) {
  if (input[centsKey] !== undefined && input[centsKey] !== null && input[centsKey] !== '') {
    const n = Number(input[centsKey]);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      throw errors.validation(`${label}必须是大于等于 0 的整数（单位：分）`);
    }
    return n;
  }
  if (input[yuanKey] !== undefined && input[yuanKey] !== null && input[yuanKey] !== '') {
    try {
      const cents = yuanToCents(input[yuanKey]);
      if (cents < 0) throw new Error('negative');
      return cents;
    } catch {
      throw errors.validation(`${label}格式不正确（最多两位小数）`);
    }
  }
  return null;
}

function adminList(db, query = {}) {
  const paging = validate.paging(query);
  const where = [];
  const args = [];
  const keyword = String(query.keyword || '').trim();
  if (keyword) {
    where.push('(p.title LIKE ? OR p.subtitle LIKE ? OR p.teacher LIKE ? OR p.id LIKE ?)');
    const like = `%${keyword}%`;
    args.push(like, like, like, like);
  }
  const status = String(query.status || '').trim();
  if (PRODUCT_STATUS.includes(status)) {
    where.push('p.status = ?');
    args.push(status);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.pluck(`SELECT COUNT(*) FROM products p ${whereSql}`, ...args) || 0;
  const rows = db.all(
    `SELECT p.* FROM products p ${whereSql} ORDER BY p.sort ASC, p.created_at DESC LIMIT ? OFFSET ?`,
    ...args,
    paging.limit,
    paging.offset
  );
  return validate.pageResult(rows.map((row) => adminProduct(db, row)), total, paging);
}

function normalizeType(value) {
  const type = String(value == null ? '' : value).trim();
  if (!type) return 'online';
  if (!PRODUCT_TYPES.includes(type)) throw errors.validation(`课程类型只能是 ${PRODUCT_TYPES.join('/')}`);
  return type;
}

function normalizeStatus(value) {
  const status = String(value == null ? '' : value).trim();
  if (!status) return 'on';
  if (!PRODUCT_STATUS.includes(status)) throw errors.validation('上下架状态只能是 on/off');
  return status;
}

function readSkus(input) {
  if (input.skus === undefined || input.skus === null) return null;
  if (!Array.isArray(input.skus)) throw errors.validation('skus 必须是数组');
  if (input.skus.length > 50) throw errors.validation('最多 50 个规格');
  return input.skus.map((raw, i) => {
    const sku = raw && typeof raw === 'object' ? raw : {};
    const name = String(sku.name == null ? '' : sku.name).trim() || `规格${i + 1}`;
    const priceCents = resolveCents(sku, 'priceCents', 'price', `规格「${name}」价格`);
    if (priceCents === null) throw errors.validation(`规格「${name}」缺少价格`);
    const stockRaw = Number(sku.stock);
    const stock = sku.stock === undefined || sku.stock === '' || sku.stock === null ? 999 : stockRaw;
    if (!Number.isInteger(stock) || stock < 0) throw errors.validation(`规格「${name}」库存必须是非负整数`);
    return {
      id: sku.id ? String(sku.id) : '',
      name,
      spec: String(sku.spec == null ? '' : sku.spec).slice(0, 120),
      priceCents,
      stock,
      status: sku.status === 'off' ? 'off' : 'on',
      sort: Number.isFinite(Number(sku.sort)) ? Number(sku.sort) : i,
    };
  });
}

function createProduct(db, input = {}) {
  const title = String(input.title == null ? '' : input.title).trim();
  if (!title) throw errors.validation('请填写课程标题');
  if (title.length > 80) throw errors.validation('课程标题最多 80 个字');
  const type = normalizeType(input.type);
  const status = normalizeStatus(input.status);
  const priceCents = resolveCents(input, 'priceCents', 'price', '售价');
  if (priceCents === null) throw errors.validation('请填写课程售价');
  const originalPriceCents = resolveCents(input, 'originalPriceCents', 'originalPrice', '划线价');
  const stockRaw = Number(input.stock);
  const stock = input.stock === undefined || input.stock === '' || input.stock === null ? 999 : stockRaw;
  if (!Number.isInteger(stock) || stock < 0) throw errors.validation('库存必须是非负整数');
  const durationMin = Number(input.durationMin === undefined || input.durationMin === '' ? 60 : input.durationMin);
  if (!Number.isInteger(durationMin) || durationMin < 0) throw errors.validation('课程时长必须是非负整数');
  const sort = Number(input.sort === undefined || input.sort === '' ? 0 : input.sort);
  if (!Number.isFinite(sort)) throw errors.validation('排序值必须是数字');
  const skus = readSkus(input) || [];

  const id = newId('prd_');
  const ts = nowIso();
  db.tx(() => {
    db.run(
      `INSERT INTO products
        (id, title, subtitle, cover, type, goal_tags, price_cents, original_price_cents,
         stock, sales, status, teacher, duration_min, schedule, detail_html, sort, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      title,
      String(input.subtitle == null ? '' : input.subtitle).slice(0, 120),
      String(input.cover == null ? '' : input.cover).slice(0, 512) || `/api/media/cover/${id}`,
      type,
      splitTags(input.goalTags != null ? input.goalTags : input.goal_tags).join(','),
      priceCents,
      originalPriceCents === null ? priceCents : originalPriceCents,
      stock,
      status,
      String(input.teacher == null ? '' : input.teacher).slice(0, 40),
      durationMin,
      String(input.schedule == null ? '' : input.schedule).slice(0, 200),
      sanitizeHtml(input.detailHtml != null ? input.detailHtml : input.detail_html),
      Math.trunc(sort),
      ts,
      ts
    );
    for (const sku of skus) {
      db.run(
        `INSERT INTO skus (id, product_id, name, spec, price_cents, stock, status, sort, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId('sku_'),
        id,
        sku.name,
        sku.spec,
        sku.priceCents,
        sku.stock,
        sku.status,
        sku.sort,
        ts
      );
    }
  });
  return adminProduct(db, db.get('SELECT * FROM products WHERE id = ?', id));
}

const UPDATABLE_COLUMNS = {
  title: 'title',
  subtitle: 'subtitle',
  cover: 'cover',
  type: 'type',
  price_cents: 'price_cents',
  original_price_cents: 'original_price_cents',
  stock: 'stock',
  teacher: 'teacher',
  duration_min: 'duration_min',
  schedule: 'schedule',
  detail_html: 'detail_html',
  sort: 'sort',
  status: 'status',
  goal_tags: 'goal_tags',
};

function updateProduct(db, id, input = {}) {
  const row = db.get('SELECT * FROM products WHERE id = ?', String(id == null ? '' : id));
  if (!row) throw errors.notFound('课程不存在');
  const sets = [];
  const args = [];
  const put = (column, value) => {
    if (!UPDATABLE_COLUMNS[column]) throw errors.internal(`不允许更新字段 ${column}`);
    sets.push(`${column} = ?`);
    args.push(value);
  };

  if (input.title !== undefined) {
    const title = String(input.title).trim();
    if (!title) throw errors.validation('课程标题不能为空');
    if (title.length > 80) throw errors.validation('课程标题最多 80 个字');
    put('title', title);
  }
  if (input.subtitle !== undefined) put('subtitle', String(input.subtitle).slice(0, 120));
  if (input.cover !== undefined) put('cover', String(input.cover).slice(0, 512) || `/api/media/cover/${row.id}`);
  if (input.type !== undefined) put('type', normalizeType(input.type));
  if (input.status !== undefined) put('status', normalizeStatus(input.status));
  if (input.goalTags !== undefined || input.goal_tags !== undefined) {
    put('goal_tags', splitTags(input.goalTags !== undefined ? input.goalTags : input.goal_tags).join(','));
  }
  const priceCents = resolveCents(input, 'priceCents', 'price', '售价');
  if (priceCents !== null) put('price_cents', priceCents);
  const originalPriceCents = resolveCents(input, 'originalPriceCents', 'originalPrice', '划线价');
  if (originalPriceCents !== null) put('original_price_cents', originalPriceCents);
  if (input.stock !== undefined) {
    const stock = Number(input.stock);
    if (!Number.isInteger(stock) || stock < 0) throw errors.validation('库存必须是非负整数');
    put('stock', stock);
  }
  if (input.teacher !== undefined) put('teacher', String(input.teacher).slice(0, 40));
  if (input.durationMin !== undefined) {
    const durationMin = Number(input.durationMin);
    if (!Number.isInteger(durationMin) || durationMin < 0) throw errors.validation('课程时长必须是非负整数');
    put('duration_min', durationMin);
  }
  if (input.schedule !== undefined) put('schedule', String(input.schedule).slice(0, 200));
  if (input.detailHtml !== undefined || input.detail_html !== undefined) {
    put('detail_html', sanitizeHtml(input.detailHtml !== undefined ? input.detailHtml : input.detail_html));
  }
  if (input.sort !== undefined) {
    const sort = Number(input.sort);
    if (!Number.isFinite(sort)) throw errors.validation('排序值必须是数字');
    put('sort', Math.trunc(sort));
  }
  const skus = readSkus(input);

  db.tx(() => {
    if (sets.length) {
      /* updated_at 不在白名单里，直接拼进 SET 子句 */
      sets.push('updated_at = ?');
      args.push(nowIso());
      db.run(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`, ...args, row.id);
    }
    if (skus) {
      const keep = new Set();
      const ts = nowIso();
      for (const sku of skus) {
        const exists = sku.id
          ? db.get('SELECT id FROM skus WHERE id = ? AND product_id = ?', sku.id, row.id)
          : null;
        if (exists) {
          db.run(
            'UPDATE skus SET name = ?, spec = ?, price_cents = ?, stock = ?, status = ?, sort = ? WHERE id = ?',
            sku.name,
            sku.spec,
            sku.priceCents,
            sku.stock,
            sku.status,
            sku.sort,
            exists.id
          );
          keep.add(exists.id);
        } else {
          const skuId = newId('sku_');
          db.run(
            `INSERT INTO skus (id, product_id, name, spec, price_cents, stock, status, sort, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            skuId,
            row.id,
            sku.name,
            sku.spec,
            sku.priceCents,
            sku.stock,
            sku.status,
            sku.sort,
            ts
          );
          keep.add(skuId);
        }
      }
      for (const old of db.all('SELECT id FROM skus WHERE product_id = ?', row.id)) {
        if (!keep.has(old.id)) db.run("UPDATE skus SET status = 'off' WHERE id = ?", old.id);
      }
    }
  });
  return adminProduct(db, db.get('SELECT * FROM products WHERE id = ?', row.id));
}

function setProductStatus(db, id, status) {
  const row = db.get('SELECT * FROM products WHERE id = ?', String(id == null ? '' : id));
  if (!row) throw errors.notFound('课程不存在');
  const next = normalizeStatus(status);
  db.run('UPDATE products SET status = ?, updated_at = ? WHERE id = ?', next, nowIso(), row.id);
  return adminProduct(db, db.get('SELECT * FROM products WHERE id = ?', row.id));
}

function listSkus(db, query = {}) {
  const productId = String(query.productId || '').trim();
  const rows = productId
    ? db.all('SELECT * FROM skus WHERE product_id = ? ORDER BY sort ASC', productId)
    : db.all('SELECT * FROM skus ORDER BY product_id ASC, sort ASC LIMIT 500');
  return rows.map(publicSku);
}

function createSku(db, input = {}) {
  const productId = String(input.productId == null ? '' : input.productId).trim();
  const product = productId ? db.get('SELECT id FROM products WHERE id = ?', productId) : null;
  if (!product) throw errors.notFound('课程不存在');
  const [sku] = readSkus({ skus: [{ ...input, name: input.name }] });
  const id = newId('sku_');
  db.run(
    `INSERT INTO skus (id, product_id, name, spec, price_cents, stock, status, sort, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    product.id,
    sku.name,
    sku.spec,
    sku.priceCents,
    sku.stock,
    sku.status,
    sku.sort,
    nowIso()
  );
  return publicSku(db.get('SELECT * FROM skus WHERE id = ?', id));
}

function updateSku(db, id, input = {}) {
  const row = db.get('SELECT * FROM skus WHERE id = ?', String(id == null ? '' : id));
  if (!row) throw errors.notFound('规格不存在');
  const name = input.name !== undefined ? String(input.name).trim() || row.name : row.name;
  const priceCents = resolveCents(input, 'priceCents', 'price', '规格价格');
  const stock = input.stock === undefined ? Number(row.stock || 0) : Number(input.stock);
  if (!Number.isInteger(stock) || stock < 0) throw errors.validation('库存必须是非负整数');
  db.run(
    'UPDATE skus SET name = ?, spec = ?, price_cents = ?, stock = ?, status = ? WHERE id = ?',
    name,
    input.spec === undefined ? row.spec : String(input.spec).slice(0, 120),
    priceCents === null ? row.price_cents : priceCents,
    stock,
    input.status === 'off' ? 'off' : input.status === 'on' ? 'on' : row.status,
    row.id
  );
  return publicSku(db.get('SELECT * FROM skus WHERE id = ?', row.id));
}

module.exports = {
  PRODUCT_TYPES,
  GOALS,
  splitTags,
  publicProduct,
  publicSku,
  adminProduct,
  listProducts,
  getProductDetail,
  homeData,
  goals,
  adminList,
  createProduct,
  updateProduct,
  setProductStatus,
  listSkus,
  createSku,
  updateSku,
  sanitizeHtml,
};
