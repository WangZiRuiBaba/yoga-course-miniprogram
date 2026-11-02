'use strict';
/**
 * 商品封面生成：纯 SVG，零外部资源。
 * 用法：GET /api/media/cover/:key  -> image/svg+xml
 * key 可以是商品 id / 任意种子；同一种子永远得到同一张图。
 */
const crypto = require('node:crypto');

const PALETTES = [
  ['#f3a683', '#f7d794'],
  ['#a8e6cf', '#dcedc1'],
  ['#c3bef0', '#dbc4f0'],
  ['#f6c6ea', '#c1e1f7'],
  ['#ffd3b6', '#ffaaa5'],
  ['#b5ead7', '#c7ceea'],
  ['#fbe7c6', '#b4f8c8'],
  ['#e0c3fc', '#8ec5fc'],
];

const POSES = [
  // 树式
  'M100 62 m-13 0 a13 13 0 1 0 26 0 a13 13 0 1 0 -26 0 M100 76 L100 132 M100 132 L78 190 M100 132 L122 190 M100 92 L74 118 M100 92 L126 118 M100 132 L86 150 M86 150 L74 138',
  // 战士二式
  'M118 60 m-12 0 a12 12 0 1 0 24 0 a12 12 0 1 0 -24 0 M118 74 L118 140 M118 140 L60 168 M118 140 L176 168 M118 96 L60 96 M118 96 L176 96',
  // 下犬式
  'M60 150 L150 88 L186 152 M150 88 L118 156 M60 150 L96 150 M186 152 L156 152',
  // 冥想盘坐
  'M100 70 m-13 0 a13 13 0 1 0 26 0 a13 13 0 1 0 -26 0 M100 84 L100 126 M100 126 L64 156 Q100 172 136 156 Z M100 96 L70 120 M100 96 L130 120',
  // 三角式
  'M100 58 m-12 0 a12 12 0 1 0 24 0 a12 12 0 1 0 -24 0 M100 72 L100 136 M100 136 L56 176 M100 136 L150 176 M100 92 L58 128 M100 92 L150 96',
];

function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function pick(list, seedBuf, offset) {
  return list[seedBuf[offset] % list.length];
}

/**
 * @param {{key?:string,title?:string,subtitle?:string}} opts
 */
function coverSvg(opts = {}) {
  const key = String(opts.key || 'yoga');
  const seedBuf = crypto.createHash('sha256').update(key).digest();
  const [c1, c2] = pick(PALETTES, seedBuf, 0);
  const pose = pick(POSES, seedBuf, 1);
  const angle = 20 + (seedBuf[2] % 40);
  const title = escapeXml(opts.title || '瑜伽');
  const subtitle = escapeXml(opts.subtitle || '');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="750" height="750" viewBox="0 0 200 200">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${c1}"/>
      <stop offset="100%" stop-color="${c2}"/>
    </linearGradient>
    <radialGradient id="halo" cx="50%" cy="42%" r="52%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="200" height="200" fill="url(#g)"/>
  <circle cx="100" cy="84" r="70" fill="url(#halo)"/>
  <g transform="rotate(${angle - 20} 100 120)" fill="none" stroke="#ffffff" stroke-opacity="0.92"
     stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
    <path d="${pose}"/>
  </g>
  <text x="100" y="182" text-anchor="middle" font-family="PingFang SC, Microsoft YaHei, sans-serif"
        font-size="13" font-weight="600" fill="#ffffff" fill-opacity="0.96">${title}</text>
  ${subtitle ? `<text x="100" y="196" text-anchor="middle" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="7.5" fill="#ffffff" fill-opacity="0.8">${subtitle}</text>` : ''}
</svg>`;
}

module.exports = { coverSvg };
