'use strict';
/**
 * LLM provider（OpenAI 兼容 /chat/completions，docs/API.md §10）。
 *
 * 设计约束：
 *   - 零依赖，只用全局 fetch（Node 18+）；
 *   - 超时可配（config.ai.timeoutMs，默认 20s），失败一律返回 { ok:false }，
 *     由 ai/service.js 降级到离线 rule 引擎，绝不把 5xx 抛给前端；
 *   - 提示词只允许模型输出 JSON：{ "reply": "...", "intent": "...", "actions": [...] }。
 */
const config = require('../../config');
const engine = require('./engine');

const INTENT_LIST = engine.INTENTS.join(' | ');

const SYSTEM_PROMPT = [
  '你是一家线上瑜伽馆的售前顾问，负责帮用户选课、下单、查订单、退款和讲解分销佣金。',
  '语气亲切、简洁，中文，一次回答不超过 120 字，不要编造课程名、价格、订单号。',
  '你只能从下面的意图中选择一个，并同时给出一句自然的中文回复。',
  `intent 只能是：${INTENT_LIST}`,
  '如果用户情绪激烈、要求投诉或明确要人工，intent 用 service。',
  '如果无法判断，intent 用 fallback。',
  '严格只输出 JSON（不要 markdown 代码块），格式：{"reply":"中文回复","intent":"recommend","actions":[]}',
  'actions 数组可以留空，卡片和按钮由系统根据 intent 生成。',
].join('\n');

function available() {
  const ai = config.ai || {};
  return ai.provider === 'llm' && !!ai.apiKey;
}

function apiUrl() {
  const base = String((config.ai && config.ai.baseUrl) || '').replace(/\/+$/, '');
  if (!base) return '';
  return `${base}/chat/completions`;
}

/** 去掉 ```json 包裹，再从文本里抠出第一个 JSON 对象 */
function parseJsonReply(content) {
  let text = String(content === null || content === undefined ? '' : content).trim();
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    /* 落到下面的花括号扫描 */
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const value = JSON.parse(text.slice(start, end + 1));
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      return null;
    }
  }
  return null;
}

function buildMessages({ text, history = [] }) {
  const list = [{ role: 'system', content: SYSTEM_PROMPT }];
  for (const item of history) {
    if (!item || !item.content) continue;
    const role = item.role === 'user' ? 'user' : 'assistant';
    list.push({ role, content: String(item.content).slice(0, 500) });
  }
  list.push({ role: 'user', content: String(text || '').slice(0, 500) });
  return list;
}

function normalizeIntent(value) {
  const intent = String(value || '').trim().toLowerCase();
  return engine.INTENTS.includes(intent) ? intent : null;
}

/**
 * 调一次模型。
 * @returns {Promise<{ok:boolean, reply?:string, intent?:string, provider:string, error?:string}>}
 */
async function complete({ text, history = [], state = {} }) {
  if (!available()) return { ok: false, provider: 'llm', error: 'LLM_DISABLED' };
  const url = apiUrl();
  if (!url) return { ok: false, provider: 'llm', error: 'NO_BASE_URL' };

  const timeoutMs = Math.max(1000, Number(config.ai.timeoutMs) || 20000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.ai.apiKey}`,
      },
      body: JSON.stringify({
        model: config.ai.model,
        messages: buildMessages({ text, history }),
        temperature: 0.3,
        max_tokens: 400,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      return { ok: false, provider: 'llm', error: `HTTP_${resp.status}` };
    }
    const payload = await resp.json();
    const content =
      payload && payload.choices && payload.choices[0] && payload.choices[0].message
        ? payload.choices[0].message.content
        : '';
    const parsed = parseJsonReply(content);
    if (!parsed) return { ok: false, provider: 'llm', error: 'BAD_JSON' };

    const intent = normalizeIntent(parsed.intent);
    const reply = String(parsed.reply || parsed.content || '').trim();
    if (!reply && !intent) return { ok: false, provider: 'llm', error: 'EMPTY_REPLY' };

    return {
      ok: true,
      provider: 'llm',
      intent: intent || 'fallback',
      reply: reply.slice(0, 500),
      actions: Array.isArray(parsed.actions) ? parsed.actions.slice(0, 4) : [],
      model: config.ai.model,
      usage: (payload && payload.usage) || null,
      stateHint: state && state.goal ? state.goal : null,
    };
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
    return { ok: false, provider: 'llm', error: aborted ? 'TIMEOUT' : `NETWORK_${(err && err.message) || 'ERROR'}` };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  SYSTEM_PROMPT,
  INVALID_HINT: INTENT_LIST,
  available,
  apiUrl,
  parseJsonReply,
  buildMessages,
  normalizeIntent,
  complete,
};
