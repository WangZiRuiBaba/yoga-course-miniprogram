'use strict';
/** 时间工具：统一使用 ISO-8601 UTC 字符串（字典序 == 时间序，便于 SQLite 比较） */

function nowIso() {
  return new Date().toISOString();
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function isoPlusMs(ms) {
  return new Date(Date.now() + Number(ms || 0)).toISOString();
}

function isoPlusDays(days) {
  return isoPlusMs(Number(days || 0) * 86400000);
}

function isoPlusMinutes(minutes) {
  return isoPlusMs(Number(minutes || 0) * 60000);
}

/** ISO -> "2026-11-02 21:44"（本地时区展示） */
function isoToLocalText(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 距某 ISO 时刻还有多少毫秒（负数=已过期） */
function msUntil(iso) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return t - Date.now();
}

module.exports = { nowIso, nowSec, isoPlusMs, isoPlusDays, isoPlusMinutes, isoToLocalText, msUntil };
