#!/usr/bin/env node
/**
 * 前端静态自检（不依赖浏览器）：
 *   1. web/ 关键文件存在且非空
 *   2. 所有前端 .js 通过 node --check（ES module 用 --input-type=module）
 *   3. miniprogram/app.json 里注册的每个页面，4 个文件（.js/.json/.wxml/.wxss）都存在
 *   4. app.json 的 pages 路径对应文件齐全；tabBar 引用的页面已注册
 *   5. 前端代码里出现的 /api/ 路径都在 docs/API.md 里能找到（发现打错接口）
 *
 *   node scripts/check-frontend.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let problems = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => {
  problems += 1;
  console.log(`  ✗ ${msg}`);
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    bad(`${path.relative(ROOT, file)} JSON 解析失败: ${err.message}`);
    return null;
  }
}

function walk(dir, ext, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, ext, out);
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

/* ---------- 1. web/ ---------- */
console.log('\n[H5]');
const webDir = path.join(ROOT, 'web');
const requiredWeb = ['index.html', 'admin.html', 'style.css'];
for (const f of requiredWeb) {
  const p = path.join(webDir, f);
  if (!fs.existsSync(p)) bad(`缺少 web/${f}`);
  else if (fs.statSync(p).size < 200) bad(`web/${f} 内容过少（${fs.statSync(p).size} 字节）`);
  else ok(`web/${f} (${(fs.statSync(p).size / 1024).toFixed(1)} KB)`);
}

/* ---------- 2. JS 语法 ---------- */
console.log('\n[JS 语法]');
for (const dir of [path.join(ROOT, 'web'), path.join(ROOT, 'miniprogram')]) {
  for (const file of walk(dir, '.js')) {
    const rel = path.relative(ROOT, file);
    const src = fs.readFileSync(file, 'utf8');
    const isEsm = /^\s*(import|export)\s/m.test(src);
    const args = ['--no-warnings'];
    if (isEsm) args.push('--input-type=module');
    args.push('--check');
    try {
      execFileSync(process.execPath, args, {
        input: src,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      const out = String(err.stderr || err.message).split('\n').slice(0, 3).join(' ');
      bad(`${rel} 语法错误: ${out}`);
    }
  }
}
const jsCount = walk(path.join(ROOT, 'web'), '.js').length + walk(path.join(ROOT, 'miniprogram'), '.js').length;
if (jsCount === 0) bad('没有找到任何前端 .js 文件');
else ok(`${jsCount} 个前端 .js 语法检查完成`);

/* ---------- 3/4. 小程序页面 ---------- */
console.log('\n[小程序]');
const mpDir = path.join(ROOT, 'miniprogram');
const appJsonPath = path.join(mpDir, 'app.json');
if (!fs.existsSync(appJsonPath)) {
  bad('缺少 miniprogram/app.json');
} else {
  const appJson = readJson(appJsonPath);
  const pages = (appJson && appJson.pages) || [];
  if (pages.length === 0) bad('app.json pages 为空');
  for (const page of pages) {
    for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
      const p = path.join(mpDir, page + ext);
      if (!fs.existsSync(p)) bad(`页面 ${page} 缺少 ${ext}`);
    }
  }
  if (pages.length) ok(`${pages.length} 个页面 × 4 文件齐备`);

  const tabList = (appJson && appJson.tabBar && appJson.tabBar.list) || [];
  for (const tab of tabList) {
    if (tab.pagePath && !pages.includes(tab.pagePath)) bad(`tabBar 页面未在 pages 注册: ${tab.pagePath}`);
  }
  if (tabList.length) ok(`tabBar ${tabList.length} 项已注册`);

  // wxml 中引用的自定义组件
  for (const page of pages) {
    const jsonFile = path.join(mpDir, page + '.json');
    if (!fs.existsSync(jsonFile)) continue;
    const cfg = readJson(jsonFile) || {};
    for (const [name, compPath] of Object.entries(cfg.usingComponents || {})) {
      const base = compPath.startsWith('/')
        ? path.join(mpDir, compPath.slice(1))
        : path.resolve(path.dirname(jsonFile), compPath);
      for (const ext of ['.js', '.json', '.wxml']) {
        if (!fs.existsSync(base + ext)) bad(`${page}.json 引用的组件 ${name}(${compPath}) 缺少 ${ext}`);
      }
    }
  }
}

/* ---------- 5. 接口路径对照契约 ---------- */
console.log('\n[接口路径 vs docs/API.md]');
const docPath = path.join(ROOT, 'docs', 'API.md');
if (!fs.existsSync(docPath)) {
  bad('缺少 docs/API.md');
} else {
  const doc = fs.readFileSync(docPath, 'utf8');
  const apiPat = /['"`](\/api\/[A-Za-z0-9_\-/:.]*)['"`]/g;
  const seen = new Set();
  let unknown = 0;
  for (const dir of [path.join(ROOT, 'web'), path.join(ROOT, 'miniprogram')]) {
    for (const file of walk(dir, '.js')) {
      const src = fs.readFileSync(file, 'utf8');
      let m;
      while ((m = apiPat.exec(src))) {
        let p = m[1];
        if (!p.startsWith('/api/')) continue;
        const norm = p.replace(/\$\{[^}]*\}/g, ':x').replace(/\/+$/, '');
        if (seen.has(norm)) continue;
        seen.add(norm);
        // 契约里可能写成 /api/xxx 或带 :param 前缀，做前缀匹配
        const key = norm.split('/').slice(0, 4).join('/');
        if (!doc.includes(key)) {
          unknown += 1;
          bad(`${path.relative(ROOT, file)} 用到未在契约中的接口: ${p}`);
        }
      }
    }
  }
  if (unknown === 0) ok(`前端接口路径均可在契约中找到（${seen.size} 个）`);
}

console.log('');
if (problems > 0) {
  console.log(`  自检完成：${problems} 个问题需要处理\n`);
  process.exitCode = 1;
} else {
  console.log('  自检完成：全部通过\n');
}
