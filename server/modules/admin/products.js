'use strict';
/** 后台商品管理（契约第 3 章·admin） */
const { getDb } = require('../../db');
const { errors } = require('../../http/errors');
const validate = require('../../http/validate');
const { writeAudit } = require('../../utils/audit');
const service = require('../product/service');

function adminOf(ctx) {
  return (ctx.admin && ctx.admin.id) || 'admin';
}

module.exports = {
  mount(router) {
    /* 列表 */
    router.get('/api/admin/products', { auth: 'admin' }, (ctx) => {
      const db = getDb();
      return service.adminList(db, ctx.query);
    });

    /* 单个商品（编辑回填，含 skus） */
    router.get('/api/admin/products/:id', { auth: 'admin' }, (ctx) => {
      const db = getDb();
      const row = db.get('SELECT * FROM products WHERE id = ?', ctx.params.id);
      if (!row) throw errors.notFound('课程不存在');
      return { product: service.adminProduct(db, row) };
    });

    /* 新建 */
    router.post('/api/admin/products', { auth: 'admin' }, (ctx) => {
      const db = getDb();
      const created = service.createProduct(db, ctx.body);
      writeAudit(db, {
        actorType: 'admin',
        actorId: adminOf(ctx),
        action: 'product.create',
        targetType: 'product',
        targetId: created.id,
        detail: { title: created.title, priceCents: created.priceCents },
      });
      return { product: created };
    });

    /* 全量更新（含 skus：缺失的旧 sku 自动下架） */
    router.put('/api/admin/products/:id', { auth: 'admin' }, (ctx) => {
      const db = getDb();
      const updated = service.updateProduct(db, ctx.params.id, ctx.body);
      writeAudit(db, {
        actorType: 'admin',
        actorId: adminOf(ctx),
        action: 'product.update',
        targetType: 'product',
        targetId: ctx.params.id,
        detail: { title: updated.title, priceCents: updated.priceCents },
      });
      return { product: updated };
    });

    /* 上下架 */
    router.patch('/api/admin/products/:id/status', { auth: 'admin' }, (ctx) => {
      const db = getDb();
      const body = validate.object(ctx.body, {
        status: { type: 'enum', required: true, values: ['on', 'off'], label: '上下架状态' },
      });
      const result = service.setProductStatus(db, ctx.params.id, body.status);
      writeAudit(db, {
        actorType: 'admin',
        actorId: adminOf(ctx),
        action: 'product.status',
        targetType: 'product',
        targetId: ctx.params.id,
        detail: { status: body.status },
      });
      return { product: result };
    });

    /* 规格（sku） */
    router.get('/api/admin/skus', { auth: 'admin' }, (ctx) => {
      const db = getDb();
      return service.listSkus(db, ctx.query);
    });

    router.post('/api/admin/skus', { auth: 'admin' }, (ctx) => {
      const db = getDb();
      const created = service.createSku(db, ctx.body);
      writeAudit(db, {
        actorType: 'admin',
        actorId: adminOf(ctx),
        action: 'sku.create',
        targetType: 'sku',
        targetId: created.id,
        detail: { productId: ctx.body && ctx.body.productId },
      });
      return { sku: created };
    });

    router.put('/api/admin/skus/:id', { auth: 'admin' }, (ctx) => {
      const db = getDb();
      const updated = service.updateSku(db, ctx.params.id, ctx.body);
      writeAudit(db, {
        actorType: 'admin',
        actorId: adminOf(ctx),
        action: 'sku.update',
        targetType: 'sku',
        targetId: ctx.params.id,
      });
      return { sku: updated };
    });
  },
};
