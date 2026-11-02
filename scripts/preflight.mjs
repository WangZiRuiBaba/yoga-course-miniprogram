#!/usr/bin/env node
/**
 * 上线前自检（preflight）。
 *
 *   node scripts/preflight.mjs              # 读 .env（或 .env.production.example 提示缺失）
 *   node scripts/preflight.mjs --env .env.prod
 *
 * 退出码：0 = 可以提交审核；1 = 有 FAIL 项必须处理（WARN 不阻塞但要看）。
 * 本脚本只读：不写数据库、不发请求、不改配置。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const envArgIdx = argv.indexOf('--env');
const envFile = envArgIdx >= 0 ? argv[envArgIdx + 1] : '.env';

const results = [];
const add = (level, name, detail) => results.push({ level, name, detail });
const pass = (name, detail = '') => add('PASS', name, detail);
const warn = (name, detail) => add('WARN', name, detail);
const fail = (name, detail) => add('FAIL', name, detail);

/* ---------- 读 .env（不覆盖已存在的 process.env） ---------- */
function parseEnvFile(file) {
  const abs = path.isAbsolute(file) ? file : path.join(ROOT, file);
  if (!fs.existsSync(abs)) return { found: false, abs, values: {} };
  const values = {};
  for (const raw of fs.readFileSync(abs, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return { found: true, abs, values };
}

const envInfo = parseEnvFile(envFile);
const env = { ...envInfo.values, ...process.env };
const get = (k) => String(env[k] ?? '').trim();
const isPlaceholder = (v) => !v || /CHANGE_ME|xxx|your-domain|^wx0+$/.test(v);

console.log('瑜伽卖课小程序 · 上线前自检');
console.log(`  配置文件：${envInfo.found ? envInfo.abs : `(未找到 ${envFile}，将只检查环境变量)`}`);
console.log('');

/* ---------- 1. 运行环境 ---------- */
const nodeEnv = get('NODE_ENV') || '(未设置)';
if (nodeEnv === 'production') pass('NODE_ENV=production');
else fail('NODE_ENV 不是 production', `当前 ${nodeEnv}：开发模式下 dev-login 默认开启、错误更详细`);

/* ---------- 2. 密钥与账号 ---------- */
const jwt = get('JWT_SECRET');
if (!jwt) fail('JWT_SECRET 未设置', '生产必须随机 32 字节以上');
else if (jwt.length < 32) fail('JWT_SECRET 太短', `长度 ${jwt.length}，建议 openssl rand -hex 32`);
else if (/dev-only|change[-_ ]?me/i.test(jwt)) fail('JWT_SECRET 仍是示例值', '换成随机串，否则 token 可被伪造');
else pass('JWT_SECRET 已设置', `长度 ${jwt.length}`);

if (get('ALLOW_DEV_LOGIN').toLowerCase() === 'true') {
  fail('ALLOW_DEV_LOGIN=true', '上线必须关闭，否则任何人可直接登录任意演示账号');
} else {
  pass('dev-login 已关闭');
}

const adminPass = get('ADMIN_PASS');
if (isPlaceholder(adminPass)) fail('ADMIN_PASS 未设置或仍是占位符', '后台弱口令 = 全站被接管');
else if (['admin123', '123456', 'admin'].includes(adminPass)) warn('ADMIN_PASS 是常见弱口令', '建议至少 12 位混合字符');
else pass('ADMIN_PASS 已设置');

/* ---------- 3. 微信登录 ---------- */
const appid = get('WX_APPID');
if (!appid || appid === 'touristappid') fail('WX_APPID 未配置', '游客 appid 不能上架，需企业主体小程序 appid');
else if (!/^wx[0-9a-f]{16}$/i.test(appid)) warn('WX_APPID 格式可疑', `当前 ${appid}`);
else pass('WX_APPID 已配置');

if (isPlaceholder(get('WX_SECRET'))) fail('WX_SECRET 未配置', 'wx.login → code2session 需要 AppSecret');
else pass('WX_SECRET 已配置');

/* ---------- 4. 支付 ---------- */
const payProvider = get('PAY_PROVIDER') || 'mock';
if (payProvider !== 'wxpay') {
  fail('PAY_PROVIDER 不是 wxpay', `当前 ${payProvider}：mock 支付只能自测，上架收款必须接微信支付`);
} else {
  const need = {
    WXPAY_MCHID: '商户号',
    WXPAY_SERIAL_NO: '商户证书序列号',
    WXPAY_PRIVATE_KEY_PATH: 'apiclient_key.pem 路径',
    WXPAY_API_V3_KEY: 'APIv3 密钥（32 位）',
    WXPAY_NOTIFY_URL: '支付回调地址',
    WXPAY_PLATFORM_CERT_PATH: '平台证书路径',
  };
  let ok = true;
  for (const [key, label] of Object.entries(need)) {
    if (isPlaceholder(get(key))) {
      fail(`支付配置缺失：${key}`, label);
      ok = false;
    }
  }
  if (ok) pass('微信支付配置齐全');

  const notify = get('WXPAY_NOTIFY_URL');
  if (notify && !notify.startsWith('https://')) fail('WXPAY_NOTIFY_URL 不是 https', '微信支付回调必须 https 且公网可达');

  for (const key of ['WXPAY_PRIVATE_KEY_PATH', 'WXPAY_PLATFORM_CERT_PATH']) {
    const p = get(key);
    if (!p) continue;
    const abs = path.isAbsolute(p) ? p : path.join(ROOT, p);
    if (!fs.existsSync(abs)) fail(`${key} 指向的文件不存在`, abs);
  }

  if (get('MOCK_AUTO_PAY').toLowerCase() === 'true') {
    fail('MOCK_AUTO_PAY=true', '真环境开启会导致「发起即成功」，务必关闭');
  }
}

/* ---------- 5. AI ---------- */
const aiProvider = get('AI_PROVIDER') || 'rule';
if (aiProvider === 'llm' && isPlaceholder(get('AI_API_KEY'))) {
  warn('AI_PROVIDER=llm 但没有 AI_API_KEY', '会自动降级到离线规则引擎（功能可用，文案偏模板）');
} else if (aiProvider === 'rule') {
  warn('AI 商城使用离线规则引擎', '零成本可控；想更像真人对话可改 llm');
} else {
  pass('AI provider 配置正常', aiProvider);
}

/* ---------- 6. 前端与小程序 ---------- */
const mpConfig = path.join(ROOT, 'miniprogram', 'utils', 'config.js');
if (!fs.existsSync(mpConfig)) {
  warn('未找到 miniprogram/utils/config.js', '跳过小程序地址检查');
} else {
  const text = fs.readFileSync(mpConfig, 'utf8');
  const m = text.match(/DEFAULT_BASE_URL\s*=\s*['"]([^'"]+)['"]/);
  const url = m ? m[1] : '';
  if (!url) warn('未解析到 DEFAULT_BASE_URL');
  else if (url.startsWith('https://')) pass('小程序默认服务地址是 https', url);
  else fail('小程序默认服务地址不是 https', `当前 ${url}：上架后必须改成已备案 https 域名（小程序后台配置 request 合法域名）`);
}

/* ---------- 7. 数据与目录 ---------- */
const dbPath = get('DB_PATH') || './data/app.db';
const dbAbs = path.isAbsolute(dbPath) ? dbPath : path.join(ROOT, dbPath);
if (fs.existsSync(dbAbs)) {
  const mb = (fs.statSync(dbAbs).size / 1024 / 1024).toFixed(2);
  pass('数据库文件存在', `${path.relative(ROOT, dbAbs)} (${mb} MB)`);
} else {
  warn('数据库文件还不存在', `${dbAbs}（首次启动会自动建库并灌种子数据）`);
}
const dataDir = path.dirname(dbAbs);
try {
  fs.accessSync(dataDir, fs.constants.W_OK);
  pass('data 目录可写');
} catch {
  fail('data 目录不可写', dataDir);
}

/* ---------- 8. 业务参数（读库，只读打开） ---------- */
if (fs.existsSync(dbAbs)) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbAbs, { readOnly: true });
    const read = (key, fallback) => {
      try {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
        return row ? JSON.parse(row.value) : fallback;
      } catch {
        return fallback;
      }
    };
    const l1 = Number(read('commission_l1_bps', 1500));
    const l2 = Number(read('commission_l2_bps', 500));
    const window = Number(read('refund_window_days', 7));
    const autoMax = Number(read('auto_refund_max_cents', 20000));
    const freeze = Number(read('freeze_days', 7));

    if (l1 > 0 && l2 > 0) {
      warn(
        '存在二级返佣（一级 ' + l1 / 100 + '%、二级 ' + l2 / 100 + '%）',
        '微信平台规则对多级分销敏感，建议上线版本只保留一级（后台参数把二级设为 0），或改为「推广员」单层奖励'
      );
    } else {
      pass('佣金层级合规', `一级 ${l1 / 100}% / 二级 ${l2 / 100}%`);
    }
    pass('业务参数快照', `退款窗口 ${window} 天 / 自动退款上限 ${(autoMax / 100).toFixed(2)} 元 / 佣金冻结 ${freeze} 天`);
    db.close();
  } catch (err) {
    warn('读取业务参数失败', err.message);
  }
}

/* ---------- 9. 合规材料 ---------- */
const wanted = [
  ['docs/上线清单.md', '上线清单（资质/备案/支付/审核）'],
  ['docs/隐私政策.md', '隐私政策（小程序后台需填写《用户隐私保护指引》）'],
  ['docs/用户协议.md', '用户协议'],
];
for (const [rel, label] of wanted) {
  if (fs.existsSync(path.join(ROOT, rel))) pass(`${label} 已存在`);
  else warn(`${label} 缺失`, `建议放 ${rel}，审核阶段常被要求`);
}

/* ---------- 输出 ---------- */
const order = { FAIL: 0, WARN: 1, PASS: 2 };
results.sort((a, b) => order[a.level] - order[b.level]);
const icon = { FAIL: '✗', WARN: '!', PASS: '✓' };
console.log('【检查结果】');
for (const r of results) {
  console.log(`  ${icon[r.level]} ${r.name}${r.detail ? '  —  ' + r.detail : ''}`);
}
const fails = results.filter((r) => r.level === 'FAIL').length;
const warns = results.filter((r) => r.level === 'WARN').length;
console.log('');
console.log(`${'─'.repeat(52)}`);
console.log(`FAIL ${fails} · WARN ${warns} · PASS ${results.length - fails - warns}`);
if (fails > 0) {
  console.log('结论：还不能提审，先处理上面 ✗ 的项。');
  process.exit(1);
}
console.log(warns > 0 ? '结论：硬性项已过，WARN 项按需处理即可提审。' : '结论：可以提审 ✅');
process.exit(0);
