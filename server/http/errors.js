'use strict';
/** 统一业务错误。HTTP 状态与业务 code 分离：code 给前端做分支，message 给人看 */

class ApiError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const errors = {
  badRequest(message = '请求参数有误', details = null) {
    return new ApiError(400, 'BAD_REQUEST', message, details);
  },
  validation(message = '参数校验失败', details = null) {
    return new ApiError(422, 'VALIDATION_ERROR', message, details);
  },
  unauthorized(message = '请先登录') {
    return new ApiError(401, 'UNAUTHORIZED', message);
  },
  forbidden(message = '没有权限') {
    return new ApiError(403, 'FORBIDDEN', message);
  },
  notFound(message = '资源不存在') {
    return new ApiError(404, 'NOT_FOUND', message);
  },
  conflict(code = 'CONFLICT', message = '操作冲突，请刷新后重试') {
    return new ApiError(409, code, message);
  },
  invalidState(message = '当前状态不允许该操作', details = null) {
    return new ApiError(409, 'INVALID_STATE', message, details);
  },
  outOfStock(message = '库存不足') {
    return new ApiError(409, 'OUT_OF_STOCK', message);
  },
  insufficientBalance(message = '可提现余额不足') {
    return new ApiError(409, 'INSUFFICIENT_BALANCE', message);
  },
  duplicate(message = '请勿重复提交') {
    return new ApiError(409, 'DUPLICATE', message);
  },
  tooMany(message = '操作太频繁，请稍后再试') {
    return new ApiError(429, 'TOO_MANY_REQUESTS', message);
  },
  internal(message = '服务器开小差了') {
    return new ApiError(500, 'INTERNAL', message);
  },
};

module.exports = { ApiError, errors };
