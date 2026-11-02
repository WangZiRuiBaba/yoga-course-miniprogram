'use strict';
/**
 * 商品模块 HTTP 适配（契约第 3 章）。
 * 业务逻辑全在 ./service.js，这里只做参数提取与响应。
 */
const { getDb } = require('../../db');
const service = require('./service');

module.exports = {
  mount(router) {
    /* 课程列表：?type=&goal=&keyword=&sort=&page=&size= */
    router.get('/api/products', (ctx) => {
      const db = getDb();
      return service.listProducts(db, ctx.query);
    });

    /* 首页：banner + 楼层 + 公告 */
    router.get('/api/home', () => {
      const db = getDb();
      return service.homeData(db);
    });

    /* 目标标签（含课程数） */
    router.get('/api/goals', () => {
      const db = getDb();
      return service.goals(db);
    });

    /* 课程详情：{product, skus, faq, related} */
    router.get('/api/products/:id', (ctx) => {
      const db = getDb();
      return service.getProductDetail(db, ctx.params.id);
    });
  },
};
