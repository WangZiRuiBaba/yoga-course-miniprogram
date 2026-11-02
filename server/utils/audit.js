'use strict';
/** 审计日志写入（后台操作、资金动作必留痕） */
const { newId } = require('./id');
const { nowIso } = require('./time');

function writeAudit(db, { actorType = 'system', actorId = null, action, targetType = null, targetId = null, detail = null }) {
  db.run(
    `INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    newId('log_'),
    actorType,
    actorId,
    String(action),
    targetType,
    targetId,
    detail == null ? null : JSON.stringify(detail),
    nowIso()
  );
}

module.exports = { writeAudit };
