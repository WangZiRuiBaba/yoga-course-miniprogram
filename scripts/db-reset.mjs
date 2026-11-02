#!/usr/bin/env node
/**
 * 重置本地数据库：删掉 data/*.db（保留 test-*.db）后重新建库并灌种子数据。
 *
 *   node scripts/db-reset.mjs          # 只重置 data/app.db（默认库）
 *   node scripts/db-reset.mjs --all    # 清掉 data 下所有 .db（含测试库）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const dataDir = path.join(ROOT, 'data');
const all = process.argv.includes('--all');

fs.mkdirSync(dataDir, { recursive: true });

const targets = fs
  .readdirSync(dataDir)
  .filter((f) => f.endsWith('.db') || f.endsWith('.db-wal') || f.endsWith('.db-shm'))
  .filter((f) => (all ? true : !f.startsWith('test-')));

for (const f of targets) {
  fs.rmSync(path.join(dataDir, f), { force: true });
  console.log(`  删除 data/${f}`);
}

const { openDb } = require(path.join(ROOT, 'server', 'db.js'));
const { seed, ensureInviteCodes } = require(path.join(ROOT, 'server', 'seed.js'));

const dbPath = path.join(dataDir, 'app.db');
const db = openDb(dbPath);
seed(db);
ensureInviteCodes(db);
const counts = {
  商品: db.pluck('SELECT COUNT(*) FROM products'),
  课程SKU: db.pluck('SELECT COUNT(*) FROM skus'),
  演示用户: db.pluck('SELECT COUNT(*) FROM users'),
  快捷话术: db.pluck('SELECT COUNT(*) FROM quick_replies'),
  后台账号: db.pluck('SELECT COUNT(*) FROM admin_users'),
};
db.close();

console.log('');
console.log('  数据库已重置:', dbPath);
for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);
console.log('');
