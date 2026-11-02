'use strict';
/** 登录与账号 */
const config = require('../../config');
const validate = require('../../http/validate');
const { signUserToken } = require('../../http/auth');
const { errors } = require('../../http/errors');
const { createLimiter } = require('../../http/ratelimit');
const { coverSvg } = require('../../utils/svg');
const service = require('./service');

const loginLimiter = createLimiter({ windowMs: 60000, max: 30, label: '登录' });

module.exports = {
  mount(router) {
    /* 微信小程序登录：wx.login 的 code 换 openid */
    router.post('/api/auth/wx-login', async (ctx) => {
      loginLimiter(`wx:${ctx.ip}`);
      const { code, nickname, avatar } = validate.object(ctx.body, {
        code: { type: 'string', required: true, min: 1, max: 256, label: '微信登录凭证' },
        nickname: { type: 'string', max: 40, label: '昵称' },
        avatar: { type: 'string', max: 512, label: '头像' },
      });
      const session = await service.codeToOpenid(code);
      const user = service.ensureUser(ctx.db, { openid: session.openid, unionid: session.unionid, nickname, avatar });
      ctx.log(`登录成功 user=${user.id} mock=${session.mock}`);
      return { token: signUserToken(user, config), user: service.publicUser(user), mock: !!session.mock };
    });

    /* 本地/演示登录：openid 可用 dev_demo_a / dev_demo_b / dev_demo_c 直接切换身份 */
    router.post('/api/auth/dev-login', (ctx) => {
      if (!config.allowDevLogin) throw errors.forbidden('当前环境已关闭演示登录');
      loginLimiter(`dev:${ctx.ip}`);
      const { openid, nickname, avatar } = validate.object(ctx.body, {
        openid: { type: 'string', max: 64, label: 'openid' },
        nickname: { type: 'string', max: 40, label: '昵称' },
        avatar: { type: 'string', max: 512, label: '头像' },
      });
      const target = openid || `dev_${Math.abs(hashCode(ctx.ip || 'guest')) % 100000}`;
      /* 昵称只在显式传入时覆盖：老用户（含种子演示账号）保留自己的昵称，新用户由 ensureUser 兜底命名 */
      const user = service.ensureUser(ctx.db, { openid: target, nickname: nickname || undefined, avatar });
      return { token: signUserToken(user, ctx.config), user: service.publicUser(user), mock: true };
    });

    /* 当前登录用户 */
    router.get('/api/me', { auth: true }, (ctx) => {
      const user = ctx.user;
      const openConversation = ctx.db.get(
        "SELECT id FROM conversations WHERE user_id = ? AND status = 'open'",
        user.id
      );
      return {
        user: service.publicUser(user),
        hasOpenConversation: !!openConversation,
        inviteCode: user.invite_code,
      };
    });

    /* 更新资料 */
    router.post('/api/auth/profile', { auth: true }, (ctx) => {
      const data = validate.object(ctx.body, {
        nickname: { type: 'string', max: 40, label: '昵称' },
        avatar: { type: 'string', max: 512, label: '头像' },
        phone: { type: 'string', max: 20, label: '手机号' },
      });
      const user = ctx.auth();
      ctx.db.run(
        'UPDATE users SET nickname = ?, avatar = ?, phone = ?, updated_at = ? WHERE id = ?',
        data.nickname !== undefined && data.nickname !== '' ? data.nickname : user.nickname,
        data.avatar !== undefined ? data.avatar : user.avatar,
        data.phone !== undefined ? data.phone : user.phone,
        new Date().toISOString(),
        user.id
      );
      return { user: service.publicUser(ctx.db.get('SELECT * FROM users WHERE id = ?', user.id)) };
    });

    /* 商品封面（SVG，零外部资源） */
    router.get('/api/media/cover/:key', (ctx) => {
      const key = String(ctx.params.key || 'yoga').replace(/\.svg$/i, '');
      const product = ctx.db.get('SELECT title, subtitle FROM products WHERE id = ?', key);
      const svg = coverSvg({
        key,
        title: product ? shorten(product.title) : '瑜伽',
        subtitle: product ? product.subtitle : '',
      });
      ctx.raw('image/svg+xml; charset=utf-8', svg, 200, { 'Cache-Control': 'public, max-age=600' });
    });
  },
};

function shorten(title) {
  const chars = [...String(title)];
  return chars.length > 12 ? `${chars.slice(0, 12).join('')}…` : String(title);
}

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return h;
}
