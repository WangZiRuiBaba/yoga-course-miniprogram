'use strict';
/**
 * 轻量校验：显式字段声明，抛 ApiError(VALIDATION_ERROR)。
 *
 * const data = validate.object(ctx.body, {
 *   productId: { type: 'string', required: true, max: 64, label: '商品' },
 *   qty:       { type: 'int', default: 1, min: 1, max: 99, label: '数量' },
 *   source:    { type: 'enum', values: ['miniprogram', 'h5', 'ai'], default: 'miniprogram' },
 * });
 */
const { errors } = require('./errors');

const DEFAULTS = { label: '参数' };

function fail(label, rule, reason) {
  const name = label || rule.label || '参数';
  return errors.validation(`${name}${reason}`);
}

function asString(value, rule) {
  const label = rule.label || DEFAULTS.label;
  if (value === undefined || value === null || value === '') {
    if (rule.required) throw fail(label, rule, '不能为空');
    return rule.default !== undefined ? rule.default : '';
  }
  if (typeof value === 'object') throw fail(label, rule, '格式不正确');
  const s = rule.trim === false ? String(value) : String(value).trim();
  if (rule.min !== undefined && s.length < rule.min) throw fail(label, rule, `至少 ${rule.min} 个字符`);
  if (rule.max !== undefined && s.length > rule.max) throw fail(label, rule, `最多 ${rule.max} 个字符`);
  if (rule.pattern && !rule.pattern.test(s)) throw fail(label, rule, '格式不正确');
  return s;
}

function asInt(value, rule) {
  const label = rule.label || DEFAULTS.label;
  if (value === undefined || value === null || value === '') {
    if (rule.required) throw fail(label, rule, '不能为空');
    return rule.default !== undefined ? rule.default : 0;
  }
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw fail(label, rule, '必须是整数');
  if (rule.min !== undefined && n < rule.min) throw fail(label, rule, `不能小于 ${rule.min}`);
  if (rule.max !== undefined && n > rule.max) throw fail(label, rule, `不能大于 ${rule.max}`);
  return n;
}

function asNumber(value, rule) {
  const label = rule.label || DEFAULTS.label;
  if (value === undefined || value === null || value === '') {
    if (rule.required) throw fail(label, rule, '不能为空');
    return rule.default !== undefined ? rule.default : 0;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw fail(label, rule, '必须是数字');
  if (rule.min !== undefined && n < rule.min) throw fail(label, rule, `不能小于 ${rule.min}`);
  if (rule.max !== undefined && n > rule.max) throw fail(label, rule, `不能大于 ${rule.max}`);
  return n;
}

function asBool(value, rule) {
  if (value === undefined || value === null || value === '') {
    return rule.default !== undefined ? rule.default : false;
  }
  if (typeof value === 'boolean') return value;
  const s = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  throw fail(rule.label || DEFAULTS.label, rule, '必须是布尔值');
}

function asEnum(value, rule) {
  const label = rule.label || DEFAULTS.label;
  const values = rule.values || [];
  if (value === undefined || value === null || value === '') {
    if (rule.default !== undefined) return rule.default;
    if (rule.required) throw fail(label, rule, '不能为空');
    return undefined;
  }
  if (!values.includes(value)) throw fail(label, rule, `只能是 ${values.join('/')}`);
  return value;
}

function asArray(value, rule) {
  const label = rule.label || DEFAULTS.label;
  if (value === undefined || value === null || value === '') {
    if (rule.required) throw fail(label, rule, '不能为空');
    return rule.default !== undefined ? rule.default : [];
  }
  if (!Array.isArray(value)) throw fail(label, rule, '必须是数组');
  if (rule.max !== undefined && value.length > rule.max) throw fail(label, rule, `最多 ${rule.max} 项`);
  if (rule.min !== undefined && value.length < rule.min) throw fail(label, rule, `至少 ${rule.min} 项`);
  return value;
}

/** 金额：接受 "199" / "199.00" / 199 元，返回整数分 */
function asMoneyCents(value, rule) {
  const { yuanToCents } = require('../utils/money');
  const label = rule.label || '金额';
  if (value === undefined || value === null || value === '') {
    if (rule.required) throw fail(label, rule, '不能为空');
    return rule.default !== undefined ? rule.default : 0;
  }
  let cents;
  try {
    cents = yuanToCents(value);
  } catch {
    throw fail(label, rule, '格式不正确（最多两位小数）');
  }
  if (rule.min !== undefined && cents < rule.min) throw fail(label, rule, `不能小于 ${rule.min} 分`);
  if (rule.max !== undefined && cents > rule.max) throw fail(label, rule, `不能大于 ${rule.max} 分`);
  return cents;
}

const TYPES = {
  string: asString,
  int: asInt,
  number: asNumber,
  bool: asBool,
  enum: asEnum,
  array: asArray,
  money: asMoneyCents,
};

/**
 * @param {object} source 通常是 ctx.body 或 ctx.query
 * @param {object} schema { field: {type, required, default, min, max, values, label, pattern} }
 */
function object(source, schema, { allowUnknown = true } = {}) {
  const src = source && typeof source === 'object' ? source : {};
  const out = {};
  for (const [field, rule] of Object.entries(schema)) {
    const type = rule.type || 'string';
    const fn = TYPES[type];
    if (!fn) throw errors.internal(`未知校验类型 ${type}`);
    const value = fn(src[field], rule);
    if (value !== undefined) out[field] = value;
  }
  if (!allowUnknown) {
    for (const key of Object.keys(src)) {
      if (!(key in schema)) out[key] = src[key];
    }
  }
  return out;
}

/** 分页参数：?page=1&size=20 */
function paging(query, { defaultSize = 20, maxSize = 100 } = {}) {
  const page = asInt(query.page, { default: 1, min: 1, max: 100000, label: '页码' });
  const size = asInt(query.size, { default: defaultSize, min: 1, max: maxSize, label: '每页条数' });
  return { page, size, limit: size, offset: (page - 1) * size };
}

/** 分页响应包装 */
function pageResult(rows, total, { page, size }) {
  return {
    list: rows,
    total,
    page,
    size,
    pages: size > 0 ? Math.ceil(total / size) : 0,
    hasMore: page * size < total,
  };
}

module.exports = { object, paging, pageResult, asString, asInt, asNumber, asBool, asEnum, asArray, asMoneyCents };
