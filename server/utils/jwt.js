'use strict';
/** 无依赖 HS256 JWT */
const crypto = require('node:crypto');

function b64urlEncode(input) {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function b64urlDecode(input) {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function hmac(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

/**
 * @param {object} payload  业务载荷（勿放敏感信息）
 * @param {string} secret
 * @param {number} ttlSeconds
 */
function sign(payload, secret, ttlSeconds = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const head = b64urlEncode(JSON.stringify(header));
  const data = b64urlEncode(JSON.stringify(body));
  const content = `${head}.${data}`;
  return `${content}.${hmac(secret, content)}`;
}

/** 校验并返回 payload；失败返回 null */
function verify(token, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, data, sig] = parts;
  const expected = hmac(secret, `${head}.${data}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(data));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) return null;
  return payload;
}

/** 从 Authorization / x-admin-token 提取裸 token */
function extractBearer(headerValue) {
  if (!headerValue) return '';
  const s = String(headerValue).trim();
  if (/^bearer\s+/i.test(s)) return s.replace(/^bearer\s+/i, '').trim();
  return s;
}

module.exports = { sign, verify, extractBearer };
