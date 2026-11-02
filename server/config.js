'use strict';
/**
 * 配置加载器：读 .env（不覆盖既有 process.env），给出带类型的默认值。
 * 不依赖 dotenv。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.join(ROOT, '.env'));

function str(key, fallback = '') {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function num(key, fallback) {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? v : fallback;
}

function bool(key, fallback) {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function resolvePath(p, fallback) {
  const value = p || fallback;
  return path.isAbsolute(value) ? value : path.join(ROOT, value);
}

const nodeEnv = str('NODE_ENV', 'development');
const isProd = nodeEnv === 'production';

const wxAppid = str('WX_APPID');
const payProviderRaw = str('PAY_PROVIDER', 'mock').toLowerCase();

const config = {
  root: ROOT,
  env: nodeEnv,
  isProd,
  port: num('PORT', 3100),
  host: str('HOST', '127.0.0.1'),

  dbPath: resolvePath(str('DB_PATH'), 'data/app.db'),

  jwtSecret: str('JWT_SECRET', 'dev-only-secret-change-me-please-32bytes'),
  userTokenTtl: num('USER_TOKEN_TTL_SECONDS', 7 * 24 * 3600),
  adminTokenTtl: num('ADMIN_TOKEN_TTL_SECONDS', 12 * 3600),
  allowDevLogin: isProd ? bool('ALLOW_DEV_LOGIN', false) : bool('ALLOW_DEV_LOGIN', true),

  wx: {
    appid: wxAppid,
    secret: str('WX_SECRET'),
    // 缺 appid/secret 时无法真实 code2session，用 code 哈希派生稳定 openid
    mock: !wxAppid || !str('WX_SECRET'),
  },

  pay: {
    provider: payProviderRaw === 'wxpay' ? 'wxpay' : 'mock',
    mockAutoPay: bool('MOCK_AUTO_PAY', true),
    mockPayDelayMs: num('MOCK_PAY_DELAY_MS', 200),
    wxpay: {
      mchid: str('WXPAY_MCHID'),
      serialNo: str('WXPAY_SERIAL_NO'),
      privateKeyPath: resolvePath(str('WXPAY_PRIVATE_KEY_PATH'), 'certs/apiclient_key.pem'),
      apiV3Key: str('WXPAY_APIV3_KEY'),
      notifyUrl: str('WXPAY_NOTIFY_URL'),
      platformCertPath: resolvePath(str('WXPAY_PLATFORM_CERT_PATH'), 'certs/wechatpay_platform_cert.pem'),
      platformSerialNo: str('WXPAY_PLATFORM_SERIAL_NO'),
    },
  },

  ai: {
    provider: str('AI_PROVIDER', 'rule').toLowerCase() === 'llm' ? 'llm' : 'rule',
    baseUrl: str('AI_BASE_URL', 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    apiKey: str('AI_API_KEY'),
    model: str('AI_MODEL', 'deepseek-chat'),
    timeoutMs: num('AI_TIMEOUT_MS', 20000),
    maxRounds: num('AI_MAX_ROUNDS', 4),
  },

  admin: {
    username: str('ADMIN_USER', 'admin'),
    password: str('ADMIN_PASS', 'admin123'),
  },

  /** 业务默认值：首次启动写入 settings 表，之后以数据库为准（后台可改） */
  bizDefaults: {
    commission_l1_bps: 1500, // 一级 15%
    commission_l2_bps: 500,  // 二级 5%
    freeze_days: 7,          // 佣金冻结天数
    refund_window_days: 7,   // 下单后可申请退款的天数
    auto_refund_max_cents: 20000, // ≤¥200 自动审核通过
    auto_refund_enabled: true,
    min_withdraw_cents: 1000, // 最低提现 ¥10
    order_timeout_minutes: 15,
    allow_partial_refund: true,
    service_welcome: '你好，我是瑜伽馆客服，课程/订单/退款问题都可以问我～',
  },
};

module.exports = config;
