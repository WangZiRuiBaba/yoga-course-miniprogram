'use strict';
/**
 * 进程内事件总线。
 * 用途：订单支付成功 -> 生成分销佣金；退款成功 -> 佣金冲正；支付成功 -> 发放课程凭证。
 * 约定：
 *   - emit 在事务提交后调用，handler 内部自行开事务；
 *   - handler 失败只记录日志，不影响主流程（由 sweeper 兜底对账）；
 *   - handler 必须幂等（重复触发结果一致）。
 */
const handlers = new Map();

function on(name, fn) {
  if (typeof fn !== 'function') throw new Error('handler must be function');
  const list = handlers.get(name) || [];
  list.push(fn);
  handlers.set(name, list);
  return () => off(name, fn);
}

function off(name, fn) {
  const list = handlers.get(name) || [];
  const i = list.indexOf(fn);
  if (i >= 0) list.splice(i, 1);
}

async function emit(name, payload) {
  const list = handlers.get(name) || [];
  const results = [];
  for (const fn of list) {
    try {
      results.push(await fn(payload));
    } catch (err) {
      console.error(`[events] ${name} handler failed:`, err && err.message ? err.message : err);
      results.push(undefined);
    }
  }
  return results;
}

function names() {
  return [...handlers.keys()];
}

module.exports = { on, off, emit, names };
