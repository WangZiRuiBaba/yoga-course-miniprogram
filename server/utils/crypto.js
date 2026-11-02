'use strict';
/** 加密工具：口令哈希、AES-256-GCM 解密（微信支付回调）、微信支付签名 */
const crypto = require('node:crypto');
const fs = require('node:fs');

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function hmacSha256Hex(text, key) {
  return crypto.createHmac('sha256', key).update(text).digest('hex');
}

/** scrypt 口令哈希：返回 { salt, hash } */
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  if (!salt || !expectedHash) return false;
  const actual = crypto.scryptSync(String(password), salt, 32).toString('hex');
  const a = Buffer.from(actual);
  const b = Buffer.from(expectedHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * AES-256-GCM 解密（微信支付 APIv3 回调 resource 解密）
 * @param {string} apiV3Key 32 字节
 * @param {string} nonce 12 字节
 * @param {string} associatedData
 * @param {string} ciphertext base64
 */
function aesGcmDecrypt(apiV3Key, nonce, associatedData, ciphertext) {
  const key = Buffer.from(apiV3Key, 'utf8');
  if (key.length !== 32) throw new Error('apiV3 key must be 32 bytes');
  const data = Buffer.from(ciphertext, 'base64');
  const tag = data.subarray(data.length - 16);
  const body = data.subarray(0, data.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'utf8'));
  decipher.setAuthTag(tag);
  if (associatedData) decipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const plain = Buffer.concat([decipher.update(body), decipher.final()]);
  return plain.toString('utf8');
}

let privateKeyCache = null;
/** 读取微信支付商户私钥（PKCS8 PEM） */
function loadWxpayPrivateKey(keyPath) {
  if (privateKeyCache && privateKeyCache.path === keyPath) return privateKeyCache.key;
  const key = fs.readFileSync(keyPath, 'utf8');
  privateKeyCache = { path: keyPath, key };
  return key;
}

/** 微信支付 APIv3 请求签名：RSA-SHA256 */
function wxpaySign(message, privateKeyPem) {
  return crypto.createSign('RSA-SHA256').update(message, 'utf8').sign(privateKeyPem, 'base64');
}

/** 微信支付回调验签 */
function wxpayVerify(message, signatureBase64, platformCertPem) {
  return crypto.createVerify('RSA-SHA256').update(message, 'utf8').verify(platformCertPem, signatureBase64, 'base64');
}

module.exports = {
  sha256Hex,
  hmacSha256Hex,
  hashPassword,
  verifyPassword,
  aesGcmDecrypt,
  loadWxpayPrivateKey,
  wxpaySign,
  wxpayVerify,
};
