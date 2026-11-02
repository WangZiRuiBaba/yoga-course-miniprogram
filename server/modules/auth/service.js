'use strict';
/** 用户服务：登录、建档、资料 */
const config = require('../../config');
const { newId, inviteCode } = require('../../utils/id');
const { nowIso } = require('../../utils/time');
const { sha256Hex } = require('../../utils/crypto');
const { errors } = require('../../http/errors');

const DEFAULT_AVATAR = '';

/** 公开字段（永不下发 openid） */
function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    nickname: user.nickname,
    avatar: user.avatar || '',
    phone: user.phone || '',
    role: user.role,
    inviteCode: user.invite_code,
    distEnabled: !!user.dist_enabled,
    hasParent: !!user.parent_id,
    createdAt: user.created_at,
  };
}

function genUniqueInviteCode(db) {
  for (let i = 0; i < 12; i++) {
    const code = inviteCode();
    if (!db.get('SELECT 1 AS x FROM users WHERE invite_code = ?', code)) return code;
  }
  return `${inviteCode()}${Date.now().toString(36).slice(-3).toUpperCase()}`;
}

function findByOpenid(db, openid) {
  return db.get('SELECT * FROM users WHERE openid = ?', openid) || null;
}

function findByInviteCode(db, code) {
  if (!code) return null;
  return db.get('SELECT * FROM users WHERE invite_code = ?', String(code).toUpperCase()) || null;
}

/**
 * 建档（幂等）
 * @param {{openid:string, nickname?:string, avatar?:string, unionid?:string}} input
 */
function ensureUser(db, input) {
  const openid = String(input.openid || '').trim();
  if (!openid) throw errors.badRequest('缺少 openid');
  const existing = findByOpenid(db, openid);
  if (existing) {
    const patch = {};
    if (input.nickname && input.nickname !== existing.nickname) patch.nickname = input.nickname;
    if (input.avatar && input.avatar !== existing.avatar) patch.avatar = input.avatar;
    if (Object.keys(patch).length) {
      db.run(
        'UPDATE users SET nickname = ?, avatar = ?, updated_at = ? WHERE id = ?',
        patch.nickname !== undefined ? patch.nickname : existing.nickname,
        patch.avatar !== undefined ? patch.avatar : existing.avatar,
        nowIso(),
        existing.id
      );
      return db.get('SELECT * FROM users WHERE id = ?', existing.id);
    }
    return existing;
  }

  const id = newId('u_');
  const ts = nowIso();
  db.run(
    `INSERT INTO users (id, openid, unionid, nickname, avatar, role, parent_id, invite_code, dist_enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'user', NULL, ?, 1, ?, ?)`,
    id,
    openid,
    input.unionid || null,
    input.nickname || `瑜伽学员${String(Date.now()).slice(-4)}`,
    input.avatar || DEFAULT_AVATAR,
    genUniqueInviteCode(db),
    ts,
    ts
  );
  return db.get('SELECT * FROM users WHERE id = ?', id);
}

/** 微信 code2session；缺 appid/secret 时退化成本地稳定 openid */
async function codeToOpenid(code) {
  const wx = config.wx;
  if (wx.mock) {
    return { openid: `mock_${sha256Hex(String(code)).slice(0, 24)}`, unionid: null, mock: true };
  }
  const url =
    'https://api.weixin.qq.com/sns/jscode2session' +
    `?appid=${encodeURIComponent(wx.appid)}` +
    `&secret=${encodeURIComponent(wx.secret)}` +
    `&js_code=${encodeURIComponent(code)}` +
    '&grant_type=authorization_code';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const data = await res.json();
    if (!data || !data.openid) {
      throw errors.badRequest(`微信登录失败：${(data && data.errmsg) || '未知错误'}`);
    }
    return { openid: data.openid, unionid: data.unionid || null, mock: false };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw errors.internal('微信登录超时，请重试');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { publicUser, ensureUser, findByOpenid, findByInviteCode, codeToOpenid, genUniqueInviteCode };
