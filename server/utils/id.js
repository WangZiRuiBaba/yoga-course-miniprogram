'use strict';
const crypto = require('node:crypto');

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const UPPER = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function randomBytes(n) {
  return crypto.randomBytes(n);
}

function randomHex(bytes = 8) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** 有序 ID：时间前缀 + 随机后缀，便于按创建顺序检索 */
function newId(prefix = '') {
  const ts = Date.now().toString(36).padStart(9, '0');
  let rand = '';
  const buf = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) rand += ALPHABET[buf[i] % ALPHABET.length];
  return `${prefix}${ts}${rand}`;
}

/** 订单号：YO + yyyymmddHHMMSS + 4 位随机 */
function orderNo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const time = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const rand = String(crypto.randomInt(10000)).padStart(4, '0');
  return `YO${time}${rand}`;
}

/** 退款单号：RF + ... */
function refundNo() {
  return orderNo().replace(/^YO/, 'RF');
}

/** 支付商户单号：PY + ... */
function outTradeNo() {
  return orderNo().replace(/^YO/, 'PY');
}

/** 邀请码：6 位大写（去掉易混字符 0/O/1/I） */
function inviteCode() {
  let s = '';
  const buf = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) s += UPPER[buf[i] % UPPER.length];
  return s;
}

/** 课程核销码：8 位数字 */
function verifyCode() {
  return String(crypto.randomInt(100000000)).padStart(8, '0');
}

module.exports = { randomHex, newId, orderNo, refundNo, outTradeNo, inviteCode, verifyCode };
