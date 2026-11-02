'use strict';
/**
 * 微信支付 v3 最小实现（零依赖，只用 node:crypto + node:https）。
 * 仅在 config.pay.provider === 'wxpay' 时被调用；mock 模式不会走这里。
 *
 * 需要的配置（server/config.js）：
 *   pay.wxpay.mchid / serialNo / privateKeyPath / apiV3Key / notifyUrl
 *   pay.wxpay.platformCertPath / platformSerialNo（回调验签）
 *   wx.appid
 */
const fs = require('node:fs');
const https = require('node:https');
const crypto = require('node:crypto');

const config = require('../../config');
const { errors } = require('../../http/errors');

const API_HOST = 'api.mch.weixin.qq.com';

function wxpayConfig() {
  return (config.pay && config.pay.wxpay) || {};
}

function isConfigured() {
  const c = wxpayConfig();
  if (!c.mchid || !c.serialNo || !c.apiV3Key) return false;
  try {
    return !!c.privateKeyPath && fs.existsSync(c.privateKeyPath);
  } catch {
    return false;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw errors.internal(`微信支付证书读取失败：${err && err.message ? err.message : err}`);
  }
}

function privateKey() {
  const c = wxpayConfig();
  if (!c.privateKeyPath) throw errors.internal('微信支付未配置商户私钥');
  return readText(c.privateKeyPath);
}

function nonce() {
  return crypto.randomBytes(16).toString('hex');
}

function signRsa(message, key) {
  return crypto.sign('RSA-SHA256', Buffer.from(message, 'utf8'), key).toString('base64');
}

function authorization(method, urlPath, body) {
  const c = wxpayConfig();
  const timestamp = Math.floor(Date.now() / 1000);
  const nonceStr = nonce();
  const message = `${method}\n${urlPath}\n${timestamp}\n${nonceStr}\n${body}\n`;
  const signature = signRsa(message, privateKey());
  return (
    `WECHATPAY2-SHA256-RSA2048 mchid="${c.mchid}",nonce_str="${nonceStr}",` +
    `signature="${signature}",timestamp="${timestamp}",serial_no="${c.serialNo}"`
  );
}

function request(method, urlPath, bodyObject) {
  const c = wxpayConfig();
  const body = bodyObject === undefined ? '' : JSON.stringify(bodyObject);
  const headers = {
    Authorization: authorization(method, urlPath, body),
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'yoga-shop/1.0 (node)',
  };
  if (body) headers['Content-Length'] = Buffer.byteLength(body);

  return new Promise((resolve, reject) => {
    const req = https.request({ host: API_HOST, method, path: urlPath, headers, timeout: 10000 }, (res) => {
      const chunks = [];
      res.on('data', (ch) => chunks.push(ch));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = { raw: text };
        }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(errors.internal(`微信支付下单失败(${res.statusCode})：${(data && data.message) || text || '未知错误'}`));
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (err) => {
      reject(errors.internal(`微信支付网络异常：${err && err.message ? err.message : err}`));
    });
    if (body) req.write(body);
    req.end();
    void c;
  });
}

/** 统一下单 → 小程序 wx.requestPayment 参数 */
async function createPayParams({ outTradeNo, amountCents, description, openid }) {
  const c = wxpayConfig();
  const appid = config.wx && config.wx.appid;
  if (!appid) throw errors.internal('微信支付未配置 appid');
  const prepay = await request('POST', '/v3/pay/transactions/jsapi', {
    appid,
    mchid: c.mchid,
    description: String(description || '瑜伽课程').slice(0, 120),
    out_trade_no: outTradeNo,
    notify_url: c.notifyUrl || '',
    amount: { total: Number(amountCents || 0), currency: 'CNY' },
    ...(openid ? { payer: { openid } } : {}),
  });
  const prepayId = prepay && prepay.prepay_id;
  if (!prepayId) throw errors.internal('微信支付未返回 prepay_id');
  const timeStamp = String(Math.floor(Date.now() / 1000));
  const nonceStr = nonce();
  const packageStr = `prepay_id=${prepayId}`;
  const paySign = signRsa(`${appid}\n${timeStamp}\n${nonceStr}\n${packageStr}\n`, privateKey());
  return { timeStamp, nonceStr, package: packageStr, signType: 'RSA', paySign, prepayId };
}

/** 回调验签：Wechatpay-Timestamp/Nonce/Signature/Serial 与平台证书 */
function verifyNotify(headers, rawBody) {
  const c = wxpayConfig();
  const get = (name) => headers[String(name).toLowerCase()] || headers[name] || '';
  const timestamp = get('wechatpay-timestamp');
  const nonceStr = get('wechatpay-nonce');
  const signature = get('wechatpay-signature');
  const serial = get('wechatpay-serial');
  if (!timestamp || !nonceStr || !signature) throw errors.badRequest('微信回调缺少验签头');
  if (c.platformSerialNo && serial && serial !== c.platformSerialNo) throw errors.badRequest('微信回调证书序列号不匹配');
  if (!c.platformCertPath || !fs.existsSync(c.platformCertPath)) throw errors.internal('未配置微信支付平台证书');
  const message = `${timestamp}\n${nonceStr}\n${rawBody}\n`;
  const ok = crypto.verify('RSA-SHA256', Buffer.from(message, 'utf8'), readText(c.platformCertPath), Buffer.from(signature, 'base64'));
  if (!ok) throw errors.badRequest('微信回调验签失败');
  // 防重放：5 分钟窗口
  const ts = Number(timestamp);
  if (Number.isFinite(ts) && Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) {
    throw errors.badRequest('微信回调已过期');
  }
  return true;
}

/** 解密回调 resource（AEAD_AES_256_GCM） */
function decryptResource(resource) {
  const c = wxpayConfig();
  if (!c.apiV3Key) throw errors.internal('未配置微信支付 apiV3Key');
  if (!resource || !resource.ciphertext) throw errors.badRequest('微信回调解密数据缺失');
  const data = Buffer.from(String(resource.ciphertext), 'base64');
  const authTag = data.subarray(data.length - 16);
  const body = data.subarray(0, data.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(c.apiV3Key, 'utf8'), Buffer.from(String(resource.nonce || ''), 'utf8'));
  decipher.setAuthTag(authTag);
  if (resource.associated_data) decipher.setAAD(Buffer.from(String(resource.associated_data), 'utf8'));
  const plain = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  return JSON.parse(plain);
}

/** 解析回调 → { outTradeNo, transactionId, tradeState, success } */
function parseNotify(headers, rawBody) {
  verifyNotify(headers, rawBody);
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw errors.badRequest('微信回调报文不是合法 JSON');
  }
  const plain = payload.resource ? decryptResource(payload.resource) : payload;
  const tradeState = plain.trade_state || 'SUCCESS';
  return {
    outTradeNo: plain.out_trade_no,
    transactionId: plain.transaction_id || '',
    tradeState,
    success: tradeState === 'SUCCESS',
    raw: plain,
  };
}

module.exports = {
  isConfigured,
  createPayParams,
  verifyNotify,
  decryptResource,
  parseNotify,
};
