'use strict';
/**
 * 定时任务注册表。
 * 各模块在 mount() 里 register('名字', 间隔秒, fn)，由 index.js 统一 start()。
 * 用途：订单超时关单、佣金解冻、会话归档等。
 */
const jobs = new Map();

function register(name, everySec, fn) {
  if (typeof fn !== 'function') throw new Error(`sweeper ${name} 缺少执行函数`);
  jobs.set(name, { everySec: Math.max(1, Number(everySec) || 60), fn, lastRun: 0 });
}

function tick() {
  const now = Date.now();
  const results = [];
  for (const [name, job] of jobs) {
    if (now - job.lastRun < job.everySec * 1000) continue;
    job.lastRun = now;
    try {
      const out = job.fn();
      results.push({ name, ok: true, out });
    } catch (err) {
      console.error(`[sweeper] ${name} 执行失败:`, err && err.message ? err.message : err);
      results.push({ name, ok: false, error: err && err.message });
    }
  }
  return results;
}

let timer = null;

function start(intervalMs = 10000) {
  if (timer) return timer;
  timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function list() {
  return [...jobs.keys()];
}

module.exports = { register, tick, start, stop, list };
