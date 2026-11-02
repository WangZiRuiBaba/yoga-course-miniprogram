'use strict';
/**
 * 后台路由汇总。
 * 子文件由不同负责人维护，缺失时跳过（便于分阶段开发）。
 */
const fs = require('node:fs');
const path = require('node:path');

const SUBMODULES = ['core', 'products', 'orders', 'refunds', 'dist', 'service'];

module.exports = {
  mount(router) {
    for (const name of SUBMODULES) {
      const file = path.join(__dirname, `${name}.js`);
      if (!fs.existsSync(file)) {
        console.warn(`[admin] 跳过未就绪的子模块 admin/${name}.js`);
        continue;
      }
      const mod = require(file);
      if (mod && typeof mod.mount === 'function') mod.mount(router);
    }
  },
};
