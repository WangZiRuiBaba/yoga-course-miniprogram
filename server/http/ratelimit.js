'use strict';
/** 进程内滑动窗口限流（单机足够；多实例请换 Redis） */
const { errors } = require('./errors');

function createLimiter({ windowMs = 60000, max = 30, label = '操作' } = {}) {
  const buckets = new Map();
  let lastSweep = Date.now();

  function sweep(now) {
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [key, arr] of buckets) {
      const kept = arr.filter((t) => now - t < windowMs);
      if (kept.length === 0) buckets.delete(key);
      else buckets.set(key, kept);
    }
  }

  return function check(key) {
    const now = Date.now();
    sweep(now);
    const id = String(key || 'anon');
    const arr = buckets.get(id) || [];
    const kept = arr.filter((t) => now - t < windowMs);
    if (kept.length >= max) {
      const retryAfter = Math.ceil((windowMs - (now - kept[0])) / 1000);
      const err = errors.tooMany(`${label}太频繁，请 ${retryAfter} 秒后再试`);
      err.details = { retryAfter };
      throw err;
    }
    kept.push(now);
    buckets.set(id, kept);
    return { remaining: max - kept.length };
  };
}

module.exports = { createLimiter };
