'use strict';
/** 静态文件服务（web/ 与 miniprogram/ 预览用），带目录穿越防护 */
const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function contentType(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/**
 * 安全解析：把 URL 相对路径映射到 root 下的真实文件
 * @returns {string|null} 绝对路径，越界或不存在返回 null
 */
function safeResolve(root, relative) {
  const decoded = decodeURIComponent(relative).replace(/\\/g, '/');
  if (decoded.includes('\0')) return null;
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
  if (target !== rootAbs && !target.startsWith(rootAbs + path.sep)) return null;
  return target;
}

/**
 * 尝试用 ctx.raw 输出静态文件
 * @returns {boolean} 是否已响应
 */
function serveStatic(ctx, root, relative) {
  if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return false;
  const file = safeResolve(root, relative || '/');
  if (!file) return false;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (stat.isDirectory()) {
    const indexFile = path.join(file, 'index.html');
    if (!fs.existsSync(indexFile)) return false;
    return sendFile(ctx, indexFile);
  }
  if (!stat.isFile()) return false;
  return sendFile(ctx, file);
}

function sendFile(ctx, file) {
  const ext = path.extname(file).toLowerCase();
  const isAsset = ['.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.woff2', '.woff', '.ico'].includes(ext);
  const body = fs.readFileSync(file);
  ctx.raw(contentType(file), body, 200, {
    'Cache-Control': isAsset ? 'public, max-age=300' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  return true;
}

module.exports = { serveStatic, contentType, safeResolve };
