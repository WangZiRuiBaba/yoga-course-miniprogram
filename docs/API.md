# 瑜伽卖课小程序 · 接口契约（v1）

> 本文件是前后端与各模块并行开发的**唯一契约**。任何一方按此实现，合并后即可跑通。
> 修改契约必须先改这里，再改代码。

---

## 0. 运行方式

```bash
node server/index.js          # http://127.0.0.1:3100
node --watch server/index.js  # 开发热重载
node --test test/             # 单元/接口测试
```

| 入口 | 说明 |
| --- | --- |
| `http://127.0.0.1:3100/` | H5 商城（`web/`，本机验收主通道） |
| `http://127.0.0.1:3100/#/ai` | AI 商城对话页 |
| `http://127.0.0.1:3100/admin` | 后台管理 |
| `http://127.0.0.1:3100/mp/...` | 小程序源码静态预览 |
| `http://127.0.0.1:3100/api/_health` | 健康检查（含已加载模块清单） |

零运行时依赖：`node:http` + `node:sqlite` + `node:crypto`。**不要引入任何 npm 依赖。**

---

## 1. 通用约定

### 1.1 响应包装

成功（HTTP 2xx）：

```json
{ "ok": true, "data": { } }
```

失败（HTTP 4xx/5xx）：

```json
{ "ok": false, "code": "VALIDATION_ERROR", "message": "数量不能大于 99", "details": { } }
```

- `code` 为机器可判定的错误码，`message` 为可直接展示给用户的中文文案。
- 路由 handler 直接 `return 数据对象` 即可，`router` 会自动包装成 `{ok:true,data}`。
- 抛错统一用 `server/http/errors.js`：`throw errors.validation('...')`。

### 1.2 错误码

| code | HTTP | 场景 |
| --- | --- | --- |
| `BAD_REQUEST` | 400 | 参数缺失/格式错误 |
| `UNAUTHORIZED` | 401 | 未登录、token 失效 |
| `FORBIDDEN` | 403 | 无权限（非本人资源、非管理员） |
| `NOT_FOUND` | 404 | 资源不存在 |
| `VALIDATION_ERROR` | 422 | 业务校验失败（库存、余额、上限） |
| `INVALID_STATE` | 409 | 状态机不允许（如已支付订单再支付） |
| `OUT_OF_STOCK` | 409 | 库存不足 |
| `INSUFFICIENT_BALANCE` | 409 | 可提现余额不足 |
| `DUPLICATE` | 409 | 重复提交/已绑定 |
| `TOO_MANY_REQUESTS` | 429 | 限流，`details.retryAfter` 为秒 |
| `INTERNAL` | 500 | 未预期错误 |

### 1.3 鉴权

| 角色 | 传递方式 | 载荷 |
| --- | --- | --- |
| 用户 | `Authorization: Bearer <token>` | `{sub: userId, kind: 'user'}` |
| 管理员 | `x-admin-token: <token>` | `{sub: adminId, kind: 'admin'}` |

路由声明 `{ auth: 'user' | 'admin' | true }`，handler 内 `ctx.auth()` / `ctx.adminAuth()` 取当前身份。

### 1.4 金额与时间

- **金额一律整数「分」**：`priceCents`、`paidCents`、`amountCents`。展示用同时返回 `xxxText`（如 `"199.00"`）。
- **时间一律 ISO-8601 UTC 字符串**：`"2026-11-02T13:53:19.753Z"`。字典序即时间序，可直接比较/排序/`substr(paid_at,1,10)` 取日期。
- 计算佣金用 `bpsOf(baseCents, bps)`（万分比，向下取整），不用浮点。

### 1.5 分页

请求：`?page=1&size=20`（`size` 上限 100）。
响应 `data`：

```json
{ "list": [], "total": 0, "page": 1, "size": 20, "pages": 0, "hasMore": false }
```

用 `validate.paging(ctx.query)` + `validate.pageResult(rows, total, paging)`。

### 1.6 字段命名

- 出参一律 **camelCase**（数据库是 snake_case，在模块里做映射，不把 `xxx_cents` 直接吐给前端）。
- 每张核心表都带 `id`（字符串，形如 `ord_xxxx`）与对外编号（`orderNo` / `refundNo` / `outTradeNo`）。
- 用户对外不暴露 `openid`（用 `publicUser()`）。

### 1.7 模块挂载方式

每个 `server/modules/<name>/index.js` 必须导出：

```js
module.exports = { mount(router) { router.get('/api/xxx', { auth: 'user' }, (ctx) => ({...})); } };
```

- 请求期取库：`const { getDb } = require('../../db'); const db = getDb();`（**不要**在模块顶层缓存 db）。
- `db.tx(fn)` 的回调**必须是同步函数**（禁止 `await`）。
- 业务服务函数放在 `server/modules/<name>/service.js`，`index.js` 只做 HTTP 适配，方便 AI 模块与测试直接调用。

---

## 2. 已实现（公共层，勿改签名）

### 2.1 认证 `/api/auth/*`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/wx-login` | `{code, nickname?, avatar?, inviteCode?}` → `{token, user, mock}` |
| POST | `/api/auth/dev-login` | `{openid?, nickname?, avatar?}` 本地调试登录（生产 403） |
| GET | `/api/me` | 需登录 → `{user, hasOpenConversation, inviteCode}` |
| POST | `/api/auth/profile` | `{nickname?, avatar?, phone?}` |
| GET | `/api/media/cover/:key` | 返回 `image/svg+xml` 封面（按 key 生成） |

`user` 结构：`{id, nickname, avatar, phone, role, inviteCode, parentId, distEnabled, hasParent, createdAt}`。

演示账号（seed）：`dev_demo_a`(DEMOA)、`dev_demo_b`(DEMOB, 上级 A)、`dev_demo_c`(DEMOC, 上级 B)。
本地登录：`POST /api/auth/dev-login {"openid":"dev_demo_a"}`。

### 2.2 后台基础 `/api/admin/*`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/admin/login` | `{username,password}` → `{token, admin}`（默认 `admin` / `admin123`） |
| GET | `/api/admin/me` | 当前管理员 |
| GET | `/api/admin/stats` | 看板（订单/退款率/佣金/待处理/近 14 天曲线） |
| GET/PUT | `/api/admin/settings` | 业务参数（`EDITABLE_SETTINGS` 白名单） |
| GET/POST/DELETE | `/api/admin/quick-replies[/:id]` | 客服快捷话术 |
| GET | `/api/admin/users?keyword=` | 用户列表（含上级昵称、团队人数） |
| GET | `/api/admin/audit-logs` | 审计日志 |

可改参数（`PUT /api/admin/settings`，body 直接传键值）：

```json
{ "commission_l1_bps": 1500, "commission_l2_bps": 500, "freeze_days": 7,
  "refund_window_days": 7, "auto_refund_max_cents": 20000, "auto_refund_enabled": true,
  "min_withdraw_cents": 1000, "order_timeout_minutes": 15, "allow_partial_refund": true }
```

---

## 3. 商品 `/api/products`（负责人：be-commerce）

### 3.1 前端用商品卡 `productCard`

```json
{
  "id": "prd_xxx", "title": "21 天燃脂塑形训练营", "subtitle": "每天 30 分钟",
  "cover": "/api/media/cover/prd_xxx", "type": "online|offline|membership",
  "goalTags": ["减脂", "塑形"], "priceCents": 19900, "priceText": "199.00",
  "originalPriceCents": 39900, "originalPriceText": "399.00", "discountText": "5.0 折",
  "stock": 100, "sales": 128, "teacher": "Lina", "durationMin": 30,
  "schedule": "周一/三/五 20:00", "badges": ["热卖"]
}
```

### 3.2 接口

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/products` | - | 查询参数 `type`、`goal`、`keyword`、`sort`(`hot`\|`new`\|`price_asc`\|`price_desc`)、分页 |
| GET | `/api/products/:id` | - | → `{product, skus, faq, related}`；`product` 含 `detailHtml`（安全的 HTML 字符串） |
| GET | `/api/home` | - | → `{banners, sections:[{key,title,subtitle,products:[productCard]}], notice}` |
| GET | `/api/goals` | - | → 目标标签列表 `[{key,label,icon,count}]`（减脂/塑形/孕产/理疗/入门/进阶） |
| GET | `/api/admin/products` | admin | `keyword`/`status`/分页，含下架商品 |
| POST | `/api/admin/products` | admin | 新建 |
| PUT | `/api/admin/products/:id` | admin | 全量更新（含 `skus` 数组，`id` 缺失则新建，缺失的旧 sku 置 `status='off'`） |
| PATCH | `/api/admin/products/:id/status` | admin | `{status:'on'|'off'}` 上下架 |
| GET/POST/PUT | `/api/admin/skus` | admin | 可选，若 sku 直接在 product 里维护则不必实现 |

`sku`：`{id, productId, name, priceCents, priceText, stock, status}`。

**规则**：`status='off'` 的商品不出现在 `/api/products`、`/api/home`；`priceCents` 即实际售价。

---

## 4. 订单 `/api/orders`（负责人：be-commerce）

### 4.1 订单状态机

```
pending ──支付成功──> paid ──核销/到期──> completed
   │                    │
   │取消/超时            └──退款申请──> refunding ──退款成功──> refunded（全额）
   ↓                                      └──部分退款──> partial_refunded
cancelled
```

允许的写操作：`pending → cancelled`（用户取消/超时）、`paid → completed`（确认完成）、`paid/partial_refunded → refunding`。

### 4.2 接口

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/orders` | user | `{productId, skuId?, quantity=1, remark?, source='miniprogram'\|'h5'\|'ai'}` |
| GET | `/api/orders` | user | `?status=&page=&size=` |
| GET | `/api/orders/:orderNo` | user | → `{order, items, payment, entitlements, canPay, canCancel, canRefund, timeline}` |
| POST | `/api/orders/:orderNo/cancel` | user | `{reason?}`，仅 `pending` |
| POST | `/api/orders/:orderNo/confirm` | user | 仅 `paid` → `completed` |
| GET | `/api/admin/orders` | admin | `status`/`keyword`(订单号或昵称)/分页 |
| GET | `/api/admin/orders/:orderNo` | admin | 详情 |
| POST | `/api/admin/orders/:orderNo/close` | admin | 强制关单 |
| POST | `/api/admin/orders/:orderNo/complete` | admin | 标记完成 |

**下单响应** `data`：

```json
{ "orderId": "ord_xxx", "orderNo": "YO202611022130001234", "status": "pending",
  "totalCents": 19900, "totalText": "199.00", "expireAt": "2026-11-02T13:45:00.000Z",
  "items": [{ "productId": "prd_xxx", "title": "21 天燃脂塑形训练营", "priceCents": 19900, "quantity": 1 }] }
```

**校验**：商品存在且 `status='on'`；库存充足（`stock >= quantity`）；每人同一商品限购逻辑不强制；`quantity` 1–99；`expireAt = now + order_timeout_minutes`。
**下单即锁库存**：`stock -= quantity`，取消/超时回滚；支付成功后 `sales += quantity`。

**`order` 结构**：`{id, orderNo, userId, status, totalCents, paidCents, refundedCents, commissionBaseCents, source, remark, expireAt, paidAt, createdAt, itemsCount, productTitles}`。

**sweeper**：每 60 秒关掉 `status='pending' AND expire_at < now` 的订单（`cancel_reason='超时未支付'`，回滚库存）。job 名 `order:expire`。

---

## 5. 支付 `/api/pay`（负责人：be-commerce）

支付抽象：`provider = mock | wxpay`（`config.pay.provider`）。**默认 mock，付款即刻成功**，用于本机验收。

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/orders/:orderNo/pay` | user | 发起支付 → `{payment, payParams, provider, mock}` |
| POST | `/api/pay/mock-notify` | - | `{outTradeNo, success=true}` 模拟支付回调（前端「我已支付」按钮 & 测试用） |
| GET | `/api/pay/status/:outTradeNo` | user | → `{status, orderStatus, paidAt, transactionId}`（前端轮询） |
| POST | `/api/pay/wxpay/notify` | - | 微信支付 v3 回调（`raw body` + 验签，仅 wxpay 模式需要） |
| GET | `/api/admin/payments` | admin | `?status=&page=` 支付流水 |

**payParams（mock）**：

```json
{ "provider": "mock", "outTradeNo": "PY...", "mock": true,
  "message": "模拟支付：点击「我已支付」即成功" }
```

`payParams`（wxpay）为小程序 `wx.requestPayment` 所需：`{timeStamp, nonceStr, package, signType, paySign}`。

**关键实现点**：
- 一个订单只允许一条成功支付；重复发起复用 `pending` 的 `payments` 记录（同一个 `outTradeNo`）。
- mock 默认 `mockAutoPay=true` 且 `mockPayDelayMs=200`：发起支付后 200ms 自动标记成功（异步 `setTimeout` 也可，前端一样轮询 `pay/status`）。**支付成功必须走统一入口**，见 5.1。
- 微信回调必须验签 + 幂等（`out_trade_no` 已成功则直接返回 200）。

### 5.1 支付成功统一入口（跨模块契约）

```js
// server/modules/payment/service.js
markPaid({ outTradeNo, transactionId, raw })  // 幂等；内部事务提交后 emit('order.paid', payload)
```

`order.paid` payload（**发出方 be-commerce，订阅方 entitlement/distribution/ai**）：

```json
{ "orderId": "ord_xxx", "orderNo": "YO...", "userId": "u_xxx",
  "paidCents": 19900, "commissionBaseCents": 19900, "paidAt": "2026-...",
  "items": [{ "productId": "prd_xxx", "title": "...", "quantity": 1, "priceCents": 19900 }] }
```

约定：**事务提交后**再 `emit`；订阅方自己开事务且必须幂等（重复投递不能重复发放）。

---

## 6. 退款 `/api/refunds`（负责人：be-commerce）

### 6.1 退款状态机

```
pending ──自动通过/人工通过──> processing ──出款成功──> succeeded
   └──人工驳回──> rejected          └──出款失败──> failed
```

### 6.2 接口

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/orders/:orderNo/refund` | user | `{amountCents?, reason, reasonType?}`；不传 `amountCents` 视为全额 |
| GET | `/api/refunds` | user | 我的退款单 |
| GET | `/api/refunds/:refundNo` | user | 详情（含进度） |
| GET | `/api/admin/refunds` | admin | `?status=&keyword=` |
| POST | `/api/admin/refunds/:refundNo/approve` | admin | `{note?}` → 出款（mock 立即成功） |
| POST | `/api/admin/refunds/:refundNo/reject` | admin | `{reason}` |

**规则**（全部从 settings 读，不要写死）：
- 仅 `paid / completed / partial_refunded` 可退；`paid_at` 超过 `refund_window_days` 天 → `VALIDATION_ERROR`（文案：已超过退款期限）。
- 可退上限 = `paid_cents - refunded_cents`；`allow_partial_refund=false` 时只接受全额。
- **AI 商城自动退款**：`auto_refund_enabled=true` 且 `amountCents <= auto_refund_max_cents` 且订单未核销 → 直接进入 `processing → succeeded`（不落 `pending`），响应里 `autoApproved=true` 并说明原因；否则落 `pending` 等人工审核。
- 退款成功必须走统一入口 `server/modules/refund/service.js#markRefundSucceeded`，事务提交后 emit：

```json
{ "refundId": "rfd_xxx", "refundNo": "RF...", "orderId": "ord_xxx", "orderNo": "YO...",
  "userId": "u_xxx", "amountCents": 19900, "refundedAt": "2026-...", "fullRefund": true }
```

- 全额退款：订单 → `refunded`，同时 `entitlements` 置失效（`revoked_at`），库存回滚（可选）、`sales` 回滚。
- 部分退款：订单 → `partial_refunded`，权益保留。
- 退款成功要冲正佣金：订阅方 distribution 写 `type='reverse'` 的负数条目（唯一索引 `ux_comm_once` 保证只冲一次）。

**响应**：`{refundNo, orderNo, amountCents, amountText, status, autoApproved, reason, message, nextAction}`（`nextAction`: `none|wait_review|contact_service`）。

---

## 7. 权益 `/api/my/entitlements`（负责人：be-commerce）

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/my/entitlements` | user | 我的课程 `[{id, productId, title, cover, type, verifyCode, grantedAt, expiresAt, status, orderNo}]` |
| GET | `/api/my/entitlements/:id` | user | 详情 + 上课须知 |
| GET | `/api/admin/entitlements` | admin | `?keyword=` 核销查询 |

支付成功（订阅 `order.paid`）生成权益：`verify_code` 用 `verifyCode()`（8 位数字），`membership` 类 `expiresAt = paidAt + 365 天`，`online/offline` 为 `null`（长期有效）。

---

## 8. 二级分销 `/api/dist`（负责人：be-distribution）

### 8.1 模型

- 绑定关系存在 `users.parent_id`：A 邀请 B，则 `B.parent_id = A.id`。**只能绑一次**，不可自绑，需防环（沿 parent 链最多 2 层校验）。
- 佣金按订单实付 `commissionBaseCents`（默认= `paid_cents`）计算：
  - 一级（直接上级）：`commission_l1_bps`（默认 1500 = 15%）
  - 二级（上级的上级）：`commission_l2_bps`（默认 500 = 5%）
- `pending` → 冻结 `freeze_days` 天 → `available`（可提现）。退款则写反向 `reverse` 条目并取消原条目。

### 8.2 接口

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/dist/overview` | user | 分销概览（见下） |
| POST | `/api/dist/bind` | user | `{inviteCode}` 绑定上级 |
| POST | `/api/dist/enable` | user | 开通分销（生成/返回邀请码） |
| GET | `/api/dist/invite` | user | `{inviteCode, inviteUrl, tips}` |
| GET | `/api/dist/team` | user | `?level=1|2` 团队成员（昵称脱敏、加入时间、贡献订单数） |
| GET | `/api/dist/commissions` | user | `?status=pending|available|reversed` 佣金流水 |
| GET | `/api/dist/withdrawals` | user | 提现记录 |
| POST | `/api/dist/withdrawals` | user | `{amountCents}`（≥ `min_withdraw_cents`，≤ available 余额） |
| GET | `/api/admin/dist` | admin | 分销员列表/排行 |
| GET | `/api/admin/withdrawals` | admin | `?status=` |
| POST | `/api/admin/withdrawals/:id/approve` | admin | 通过（→ `approved`） |
| POST | `/api/admin/withdrawals/:id/reject` | admin | `{reason}`（退回余额） |
| POST | `/api/admin/withdrawals/:id/paid` | admin | 标记已打款（→ `paid`） |
| POST | `/api/admin/dist/adjust` | admin | `{userId, amountCents, note}` 手工调整（写 `type='adjust'`） |

**`/api/dist/overview` 响应**：

```json
{ "isDistributor": true, "inviteCode": "DEMOA", "inviteUrl": "http://127.0.0.1:3100/#/join?code=DEMOA",
  "level": 1, "teamSize": 1, "teamSizeL2": 1,
  "balance": { "availableCents": 2985, "pendingCents": 0, "settledCents": 0, "totalCents": 2985,
               "availableText": "29.85", "minWithdrawText": "10.00" },
  "today": { "commissionCents": 0, "orders": 0 },
  "recent": [ { "level": 1, "amountCents": 2985, "status": "pending", "availableAt": "..." } ] }
```

**实现要点**：
- 订阅 `order.paid` 生成两级佣金（`level=1|2`，`status='pending'`，`available_at = paidAt + freeze_days`）；上级未开通分销则**跳过该级**（不补发）。
- 订阅 `refund.succeeded` 对原条目写反向条目（`type='reverse'`、`amount_cents` 为负、`refund_id` 关联），并把原条目 `status='cancelled'`。
- 提现扣减：`available` 余额 = `SUM(available 条目) - SUM(已提现占用)`；提现创建时把对应金额标记占用（建议 `commission_entries` 上加 `withdraw_id` 字段或另建 `withdrawal_items`，自行决定，但必须可审计、可回滚）。
- sweeper：`dist:unfreeze` 每分钟把 `status='pending' AND available_at < now` 置 `available`。

---

## 9. 客服 `/api/service`（负责人：be-ai-assistant）

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/service/conversation` | user | 取/建当前 open 会话 → `{conversation, messages, quickReplies, welcome}` |
| POST | `/api/service/messages` | user | `{content, msgType='text'}` → `{message, autoReply?}` |
| GET | `/api/service/messages` | user | `?after=<iso>` 轮询增量 → `{messages, conversation}` |
| POST | `/api/service/conversation/close` | user | 结束会话 |
| GET | `/api/admin/conversations` | admin | `?status=open|closed`，按 `last_msg_at` 倒序 |
| GET | `/api/admin/conversations/:id/messages` | admin | 会话消息（进入即清未读） |
| POST | `/api/admin/conversations/:id/messages` | admin | `{content}` 客服回复 |
| POST | `/api/admin/conversations/:id/close` | admin | 关闭 |

`message`：`{id, conversationId, senderType:'user'|'admin'|'system'|'ai', content, msgType, meta, createdAt}`。

**规则**：一个用户同时只有一条 `status='open'` 的会话（本地唯一索引保证）；发消息要更新 `last_msg_at`/`last_msg_preview`/未读数。**AI 自动回复**：用户发消息后若 AI 开关打开，自动追加一条 `senderType='ai'` 的回复（与 AI 商城共用意图引擎）。

**service 模块对外导出**（供 ai 模块复用，跨模块契约）：

```js
// server/modules/service/service.js
ensureConversation(db, userId)                 // → conversation
appendMessage(db, { conversationId, senderType, content, msgType='text', meta })
publicMessage(row)                             // → camelCase
publicConversation(row)                        // → camelCase
```

---

## 10. AI 商城 `/api/ai`（负责人：be-ai-assistant）★核心

目标：用户说一句话 → AI 推荐课程 → 引导下单 → 支付 → 退款，全链路在对话里完成。

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/ai/session` | user | 新建/复用会话 → `{sessionId, state, messages}` |
| GET | `/api/ai/session/:id` | user | 会话详情（含历史消息） |
| POST | `/api/ai/chat` | user | `{sessionId, text}` → `{reply, messages, state}` |
| POST | `/api/ai/action` | user | `{sessionId, action, payload}` 执行动作按钮 |
| GET | `/api/ai/suggestions` | user | 推荐问题 `["我想减脂，推荐课程","我的订单在哪","怎么退款","怎么赚佣金"]` |
| GET | `/api/admin/ai/logs` | admin | `?page=` AI 动作审计（`ai_actions`） |

**`/api/ai/chat` 响应**：

```json
{
  "reply": {
    "content": "给你挑了两门适合减脂的课 👇",
    "cards": [
      { "type": "product", "productId": "prd_xxx", "title": "21 天燃脂塑形训练营",
        "subtitle": "每天 30 分钟", "cover": "/api/media/cover/prd_xxx",
        "priceCents": 19900, "priceText": "199.00", "tags": ["减脂"] }
    ],
    "actions": [
      { "label": "立即下单", "action": "create_order", "payload": { "productId": "prd_xxx" } },
      { "label": "看看详情", "action": "open_product", "payload": { "productId": "prd_xxx" } }
    ]
  },
  "messages": [ { "role": "user", "content": "…", "createdAt": "…" },
                { "role": "assistant", "content": "…", "cards": [], "actions": [], "createdAt": "…" } ],
  "state": { "intent": "recommend", "stage": "browsing", "lastProductId": "prd_xxx", "lastOrderNo": null }
}
```

**卡片类型**：`product`（商品）、`order`（订单摘要：`orderNo,status,statusText,totalText,payExpireAt`）、`pay`（收银台：`orderNo,outTradeNo,payParams,provider,mock,amountText`）、`refund`（退款单：`refundNo,status,statusText,amountText,message`）、`entitlement`（已开通：`title,verifyCode`）、`text`。

**动作 `action`**：`create_order`、`pay_order`、`mock_pay`、`refund_order`、`open_product`、`open_orders`、`open_service`、`bind_invite`、`open_dist`。
`POST /api/ai/action` 返回：`{ok:true, action, result, message, cards, actions, state}`；失败用 `{ok:false, code, message, needConfirm?}`（HTTP 仍 200，前端按 `ok` 判断，避免打断对话）。

**意图清单（rule provider 必须覆盖）**：

| 用户输入例子 | intent | 行为 |
| --- | --- | --- |
| 我想减脂 / 塑形 / 肩颈不舒服 / 孕产 | `recommend` | 按 `goal_tags` 检索 → `product` 卡片 + `create_order` 按钮 |
| 多少钱 / 有优惠吗 | `price` | 报价 + 权益说明 + 下单按钮 |
| 买 / 就这个 / 下单 | `create_order` | 用 `lastProductId` 建单 → `pay` 卡片 + `mock_pay` 按钮 |
| 支付 / 付款 / 怎么付 | `pay` | 发起支付 → `pay` 卡片 |
| 我付好了 | `mock_pay` | 调 mock-notify → 已支付 + `entitlement` 卡片 |
| 退款 / 不想要了 | `refund` | 查最近可退订单 → 说明规则 → 一键退款 → `refund` 卡片 |
| 我的订单 / 订单呢 | `orders` | 最近 5 单 `order` 卡片 |
| 我的课 / 怎么上课 | `entitlements` | `entitlement` 卡片（含核销码） |
| 客服 / 人工 | `service` | 跳转客服会话（`open_service` 动作） |
| 赚钱 / 分销 / 邀请 | `dist` | 说明二级分销规则 + `open_dist` 动作 |
| 其他 | `fallback` | 引导语 + 推荐问题 |

**实现要求**：
- 状态存 `ai_sessions.state`（JSON），字段至少 `{intent, stage, lastProductId, lastOrderNo, pendingConfirm}`。
- 每轮把 `user` / `assistant` 消息写 `ai_messages`；每个动作写 `ai_actions`（`tool, args, result, status`）。
- 调用业务能力用**延迟 require + try/catch**（模块可能尚未就绪），失败时回复「该功能暂未开放」而不是 500：

```js
function tryService(path) { try { return require(path); } catch { return null; } }
const orderSvc = () => tryService('../order/service.js');
```

- `llm` provider：OpenAI 兼容 `/chat/completions`，`config.ai`（`AI_BASE_URL/AI_API_KEY/AI_MODEL`）；超时 20s；失败自动降级 rule。提示词里只允许模型输出 JSON（`{reply, intent, actions}`），解析失败也降级。
- **额度**：`/api/ai/chat` 限流 30 次/分钟/用户（`createLimiter`），返回 `TOO_MANY_REQUESTS`。

---

## 11. 跨模块事件与函数契约（总和）

| 事件 | 发出方 | 订阅方 | 语义 |
| --- | --- | --- | --- |
| `order.paid` | `payment/service.js#markPaid` | entitlement（自己发权益）、distribution（发佣金）、service（欢迎语） | 支付成功，幂等 |
| `refund.succeeded` | `refund/service.js#markRefundSucceeded` | distribution（冲正）、entitlement（回收权益）、service（通知） | 退款成功，幂等 |

| 函数 | 模块 | 被谁调用 |
| --- | --- | --- |
| `createOrder(db, {userId, productId, skuId, quantity, remark, source})` | order | AI、前端 HTTP |
| `getOrderDetail(db, orderNo, userId?)` | order | AI、HTTP |
| `payOrder(db, {orderNo, userId})` | payment | AI、HTTP |
| `markPaid({outTradeNo, transactionId, raw})` | payment | 支付回调、mock |
| `createRefund(db, {orderNo, userId, amountCents, reason})` | refund | AI、HTTP |
| `markRefundSucceeded({refundNo, transactionId})` | refund | 后台审核、mock |
| `ensureConversation/appendMessage` | service | AI |

**所有 service 函数都要能被 `node --test` 直接调用**（纯函数式：第一个参数是 db）。

---

## 12. 分工作业与文件作用域（互斥，禁止越界写入）

| 负责人 | 允许写入 |
| --- | --- |
| **Lead** | `package.json` `.env.example` `.gitignore` `README.md` `docs/**` `scripts/**` `server/index.js` `server/config.js` `server/db.js` `server/seed.js` `server/events.js` `server/sweep.js` `server/http/**` `server/utils/**` `server/modules/auth/**` `server/modules/admin/index.js` `server/modules/admin/core.js` |
| **be-commerce** | `server/modules/product/**` `server/modules/order/**` `server/modules/payment/**` `server/modules/refund/**` `server/modules/entitlement/**` `server/modules/admin/products.js` `server/modules/admin/orders.js` `server/modules/admin/refunds.js` `test/commerce.test.mjs` |
| **be-distribution** | `server/modules/distribution/**` `server/modules/admin/dist.js` `test/distribution.test.mjs` |
| **be-ai-assistant** | `server/modules/ai/**` `server/modules/service/**` `server/modules/admin/service.js` `test/ai.test.mjs` |
| **fe-miniprogram** | `miniprogram/**` |
| **fe-web** | `web/**` |

新表如需新增，**不要改 `server/db.js`**：在自己的模块里 `db.exec('CREATE TABLE IF NOT EXISTS ...')` 并在模块 `mount()` 时执行一次（幂等）。确需中央表变更，先告知 Lead。

---

## 13. 验收要点（P2 集成）

1. `node --test test/` 全绿。
2. `GET /api/_health` → `modules.missing` 为空。
3. H5 全链路：浏览 → 下单 → mock 支付 → 我的课程（含核销码）→ 申请退款 → 后台审核成功 → 订单变 `refunded`。
4. 分销链路：B 用 A 的邀请码绑定 → B 下单支付 → A 得一级佣金、A 的上级得二级佣金 → B 退款 → 佣金冲正。
5. AI 链路：`/#/ai` 说「我想减脂」→ 出卡片 → 「买这个」→ 出收银台 → 「我已支付」→ 提示开通 → 「退款」→ 退款成功。
6. 后台：登录 → 看板有数据 → 商品上下架 → 退款审核 → 提现审核 → 客服回复。

---

---

## 14. 实现补充与实测差异（v1.1 修订，实现为准）

以下为并行开发阶段实测落地的字段/形状，**已是真实行为**，前端按此对接；与上面章节冲突时以本章为准。

### 14.1 金额文本双字段

所有金额字段同时给两种文本：

| 字段 | 示例 | 用途 |
| --- | --- | --- |
| `priceText` / `totalText` / `amountText` / `paidText` / `refundedText` / `originalPriceText` / `minWithdrawText` / `availableText` … | `"299.00"` | **纯数字 + 两位小数**，不带符号；前端自己拼 `¥` |
| 对应的 `xxxLabel`（`priceLabel` / `totalLabel` / `originalPriceLabel` …） | `"¥299.00"` | 直接可展示的带符号文案 |

`priceCents` 等整数字段恒为权威值，任何计算都用它。

### 14.2 商品

- `id` 形如 `p_xxxxxxxx`（不是文档早期的 `prd_xxx`），工具类前缀统一为 `p_ / ord_ / oit_ / u_ / ent_ / cm_ / wd_ / conv_ / msg_`。
- `discountText` 为 `"6.0 折"` 形式；`badges` 为字符串数组；`goalTags` 为中文标签数组（`/api/goals` 返回其去重集合 + 计数）。
- `/api/home` 的 `banners` 内每项含 `cover/title/subtitle/link/priceText`。

### 14.3 订单

- 列表项（`GET /api/orders`、`GET /api/admin/orders`）也带 `canPay` / `canCancel` / `canRefund`，语义与详情一致：`canPay = status='pending' && 未超时`；`canCancel = status='pending'`；`canRefund = status ∈ {paid, partial_refunded} && 在退款窗口内 && refundableCents > 0`。
- 详情 `data` 实为 `{order, items, payment, refund, entitlements, canPay, canCancel, canRefund, timeline}` —— 比 v1 多一个 `refund`（最近一条退款单，可为 `null`）。
- `order` 内金额同时带 `xxxCents` 与 `xxxText`；`statusText`、`source`、`cancelReason`、`expireAt`、`paidAt`、`createdAt` 均在。
- 请求体是**扁平**的 `{productId, skuId?, quantity=1, remark?, source?}`，不是 `items` 数组。

### 14.4 权益

- 权益对象除 `{id, orderNo, productId, title, cover, status, verifyCode, expiresAt}` 外，还返回 `teacher`、`schedule`、`durationMin`、`verifyTip`（列表与详情都有，列表项至少含 `teacher` / `durationMin`）。

### 14.5 分销

- `GET /api/dist/overview`：`balance` 含 `availableCents/availableText/occupiedCents/pendingText/settledText/totalText/minWithdrawCents/minWithdrawText`；`rules` 含 `l1Text:"15%"`、`l2Text:"5%"`、`freezeDays`；另有 `tips`（**字符串数组**，前端渲染成列表）。
- `GET /api/dist/commissions` 的 `status` 额外接受 `cancelled`；每行含 `buyerNickname`、`statusText`、`rateText`。
- 提现占用不建表：`availableCents = Σ(available 佣金条目) − Σ(pending/approved/paid 提现)`；驳回自动回滚。
- 冲正条目 `type='reverse'` 恒 `status='cancelled'`，只作审计，余额变化体现在原条目被置 `cancelled` 或金额折减（部分退款）。
- 后台鉴权头是 `x-admin-token`（不是 `Authorization: Bearer`）。

### 14.6 客服

- `GET /api/service/quick-replies`（或会话接口内联）返回 `{id, title, content}`，chip 显示 `title`、发送 `content`。

### 14.7 AI

- `POST /api/ai/action` 的响应形状是**顶层** `{ok, action, result}` / `{ok:false, code, message}`，不走 `{ok:true, data}` 包装（前端以 raw 方式解析）。其他 ai 接口仍是标准包装。
- 卡片类型：`product` / `order` / `pay` / `refund` / `entitlement` / `text`；动作按钮 `action` 取值见第 10 章。

### 14.8 支付

- mock 模式下 `GET /api/pay/status/:outTradeNo` 的 `status` 为 `pending` / `succeeded` / `failed`（**是 `succeeded`**，不是 `success`/`paid`），`orderStatus` 单独给订单状态。
- **原始请求体**：所有 `/api/*` 请求，中间件都会把原始字节挂到 `ctx.rawBody`（字符串）与 `ctx.rawBuffer`（Buffer）。微信支付 v3 回调验签必须用 `ctx.rawBody`，不要用 `JSON.stringify(ctx.body)`（字段顺序与转义都会变，验签必失败）。

### 14.9 权益与订单的其它落地细节

- 权益失效（全额退款后）状态为 `status='revoked'`（`entitlements` 表无 `revoked_at`，用 `updated_at` 表示失效时间）。
- 退款审核期间订单**不提前**进入 `refunding`：`approve` 时才置 `refunding` → `markRefundSucceeded`；`reject` 时若在 `refunding` 则回 `paid`。
- 金额 ≤ `auto_refund_max_cents`（默认 20000 分）且权益未核销 → 自动通过（`autoApproved=true`，直接 `succeeded`）；超过阈值或已核销 → `pending` 等人工审核。
- 订单已到终态（`refunded`/`cancelled`）时再次申请退款返回 `409 INVALID_STATE`；超窗口期/超可退金额/数量越界属校验类，返回 `422 VALIDATION_ERROR`。

---

_契约版本：v1.1（2026-11-02，随实现落地同步补充）。任何端点变更需同步更新本文件。_
