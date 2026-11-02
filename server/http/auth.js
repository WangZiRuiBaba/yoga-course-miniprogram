'use strict';
/** 鉴权：从请求头解析用户 / 后台身份（不强制，是否强制由路由 meta 决定） */
const jwt = require('../utils/jwt');
const { errors } = require('./errors');

/** 用户 token：Authorization: Bearer <token> */
function resolveUser(db, req, config) {
  const token = jwt.extractBearer(req.headers.authorization || req.headers.Authorization);
  if (!token) return null;
  const payload = jwt.verify(token, config.jwtSecret);
  if (!payload || payload.kind !== 'user' || !payload.sub) return null;
  const user = db.get('SELECT * FROM users WHERE id = ?', payload.sub);
  return user || null;
}

/** 后台 token：x-admin-token: <token> */
function resolveAdmin(db, req, config) {
  const token = jwt.extractBearer(req.headers['x-admin-token'] || req.headers['X-Admin-Token']);
  if (!token) return null;
  const payload = jwt.verify(token, config.jwtSecret);
  if (!payload || payload.kind !== 'admin' || !payload.sub) return null;
  return db.get('SELECT id, username, role FROM admin_users WHERE id = ?', payload.sub) || null;
}

function requireUser(ctx) {
  if (!ctx.user) throw errors.unauthorized();
  return ctx.user;
}

function requireAdmin(ctx) {
  if (!ctx.admin) throw errors.unauthorized('请先登录后台');
  return ctx.admin;
}

function signUserToken(user, config) {
  return jwt.sign({ sub: user.id, kind: 'user', role: user.role || 'user' }, config.jwtSecret, config.userTokenTtl);
}

function signAdminToken(admin, config) {
  return jwt.sign({ sub: admin.id, kind: 'admin', role: admin.role || 'admin' }, config.jwtSecret, config.adminTokenTtl);
}

module.exports = { resolveUser, resolveAdmin, requireUser, requireAdmin, signUserToken, signAdminToken };
