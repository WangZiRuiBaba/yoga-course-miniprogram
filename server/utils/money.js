'use strict';
/** 金额工具：全链路整数「分」，禁止浮点参与结算 */

function yuanToCents(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error('invalid money');
    return Math.round(input * 100);
  }
  const s = String(input).trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new Error(`invalid money: ${input}`);
  const neg = s.startsWith('-');
  const [intPart, frac = ''] = s.replace('-', '').split('.');
  const cents = Number(intPart) * 100 + Number((frac + '00').slice(0, 2));
  return neg ? -cents : cents;
}

/** 19900 -> "199.00"（字符串，便于展示与入库前对齐） */
function centsToYuanString(cents) {
  const n = Number(cents || 0);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(n));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** 展示用，带符号：¥199.00 */
function fmtYuan(cents) {
  return `¥${centsToYuanString(cents)}`;
}

/** 按万分比抽成，向下取整（不让平台多付一分钱） */
function bpsOf(baseCents, bps) {
  const base = Number(baseCents || 0);
  const rate = Number(bps || 0);
  if (base <= 0 || rate <= 0) return 0;
  return Math.floor((base * rate) / 10000);
}

/** 按比例分摊退款冲正，向下取整 */
function prorate(totalCents, partCents, targetCents) {
  const total = Number(totalCents || 0);
  if (total <= 0) return 0;
  const part = Math.min(Number(partCents || 0), total);
  return Math.floor((Number(targetCents || 0) * part) / total);
}

module.exports = { yuanToCents, centsToYuanString, fmtYuan, bpsOf, prorate };
