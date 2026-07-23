import { randomUUID } from "node:crypto";

export const OPENCLAW_MODEL_ALIAS = "default";
export const OPENCLAW_MODEL_REQUEST_MAX_BYTES = 1_000_000;

const ALLOWED_REQUEST_KEYS = new Set([
  "model",
  "messages",
  "stream",
  "stream_options",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "presence_penalty",
  "frequency_penalty",
  "seed",
  "stop",
  "response_format",
  "reasoning_effort",
]);
const MESSAGE_ROLES = new Set(["system", "developer", "user", "assistant", "tool"]);
const FUNCTION_NAME = /^[A-Za-z0-9_-]{1,128}$/;

export interface OpenClawCompletionRequest extends Record<string, unknown> {
  model: typeof OPENCLAW_MODEL_ALIAS;
  messages: Array<Record<string, unknown>>;
  stream: boolean;
}

export function parseOpenClawCompletionRequest(raw: unknown): OpenClawCompletionRequest {
  if (!isRecord(raw)) throw new Error("MODEL_PROXY_REQUEST_INVALID");
  assertJsonLimits(raw);
  for (const key of Object.keys(raw)) if (!ALLOWED_REQUEST_KEYS.has(key)) throw new Error("MODEL_PROXY_REQUEST_INVALID");
  if (raw.model !== OPENCLAW_MODEL_ALIAS) throw new Error("MODEL_PROXY_MODEL_INVALID");
  if (!Array.isArray(raw.messages) || raw.messages.length < 1 || raw.messages.length > 256) throw new Error("MODEL_PROXY_REQUEST_INVALID");
  const messages = raw.messages.map(parseMessage);
  const stream = raw.stream === undefined ? false : raw.stream;
  if (typeof stream !== "boolean") throw new Error("MODEL_PROXY_REQUEST_INVALID");
  if (raw.tools !== undefined) parseTools(raw.tools);
  if (raw.tool_choice !== undefined) parseToolChoice(raw.tool_choice);
  numberInRange(raw.temperature, 0, 2);
  numberInRange(raw.top_p, 0, 1);
  numberInRange(raw.presence_penalty, -2, 2);
  numberInRange(raw.frequency_penalty, -2, 2);
  integerInRange(raw.max_tokens, 1, 32_768);
  integerInRange(raw.max_completion_tokens, 1, 32_768);
  if (raw.parallel_tool_calls !== undefined && typeof raw.parallel_tool_calls !== "boolean") throw new Error("MODEL_PROXY_REQUEST_INVALID");
  if (raw.seed !== undefined && (!Number.isSafeInteger(raw.seed) || Math.abs(raw.seed as number) > 2_147_483_647)) throw new Error("MODEL_PROXY_REQUEST_INVALID");
  if (raw.stop !== undefined && !isShortStringOrArray(raw.stop, 4, 500)) throw new Error("MODEL_PROXY_REQUEST_INVALID");
  if (raw.reasoning_effort !== undefined && !["none", "minimal", "low", "medium", "high", "xhigh"].includes(String(raw.reasoning_effort))) {
    throw new Error("MODEL_PROXY_REQUEST_INVALID");
  }
  return { ...raw, model: OPENCLAW_MODEL_ALIAS, messages, stream } as OpenClawCompletionRequest;
}

export function withUpstreamModel(request: OpenClawCompletionRequest, model: string) {
  return { ...request, model };
}

export function toAnthropicRequest(request: OpenClawCompletionRequest, model: string) {
  const system: string[] = [];
  const messages: Array<{ role: "user" | "assistant"; content: Array<Record<string, unknown>> }> = [];
  for (const message of request.messages) {
    const role = String(message.role);
    if (role === "system" || role === "developer") {
      const text = textContent(message.content);
      if (text) system.push(text);
      continue;
    }
    if (role === "tool") {
      appendAnthropicMessage(messages, "user", [{
        type: "tool_result",
        tool_use_id: message.tool_call_id,
        content: textContent(message.content),
      }]);
      continue;
    }
    const content = textBlocks(message.content);
    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const rawToolCall of message.tool_calls) {
        const toolCall = rawToolCall as Record<string, unknown>;
        const fn = toolCall.function as Record<string, unknown>;
        content.push({
          type: "tool_use",
          id: toolCall.id,
          name: fn.name,
          input: parseToolArguments(fn.arguments),
        });
      }
    }
    appendAnthropicMessage(messages, role === "assistant" ? "assistant" : "user", content);
  }

  const result: Record<string, unknown> = {
    model,
    max_tokens: request.max_completion_tokens ?? request.max_tokens ?? 4_096,
    messages,
    stream: false,
  };
  if (system.length) result.system = system.join("\n\n");
  if (request.temperature !== undefined) result.temperature = request.temperature;
  if (request.top_p !== undefined) result.top_p = request.top_p;
  if (request.stop !== undefined) result.stop_sequences = typeof request.stop === "string" ? [request.stop] : request.stop;
  if (Array.isArray(request.tools)) {
    result.tools = request.tools.map((entry) => {
      const fn = (entry as Record<string, unknown>).function as Record<string, unknown>;
      return { name: fn.name, description: fn.description, input_schema: fn.parameters ?? { type: "object", properties: {} } };
    });
  }
  const toolChoice = anthropicToolChoice(request.tool_choice);
  if (toolChoice) result.tool_choice = toolChoice;
  return result;
}

export function anthropicResponseToOpenAi(raw: unknown, stream: boolean): Response {
  if (!isRecord(raw) || !Array.isArray(raw.content)) throw new Error("MODEL_RESPONSE_INVALID");
  const id = typeof raw.id === "string" && raw.id ? raw.id : `chatcmpl_${randomUUID()}`;
  const created = Math.floor(Date.now() / 1_000);
  const text = raw.content
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
  const toolCalls = raw.content
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string")
    .map((block) => ({
      id: block.id,
      type: "function",
      function: { name: block.name, arguments: JSON.stringify(isRecord(block.input) ? block.input : {}) },
    }));
  const finishReason = anthropicFinishReason(raw.stop_reason);
  const usage = anthropicUsage(raw.usage);
  if (!stream) {
    return jsonResponse({
      id,
      object: "chat.completion",
      created,
      model: OPENCLAW_MODEL_ALIAS,
      choices: [{
        index: 0,
        message: { role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
        finish_reason: finishReason,
      }],
      usage,
    });
  }

  const chunks: unknown[] = [{
    id,
    object: "chat.completion.chunk",
    created,
    model: OPENCLAW_MODEL_ALIAS,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  }];
  if (text) chunks.push({
    id,
    object: "chat.completion.chunk",
    created,
    model: OPENCLAW_MODEL_ALIAS,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  });
  toolCalls.forEach((toolCall, index) => chunks.push({
    id,
    object: "chat.completion.chunk",
    created,
    model: OPENCLAW_MODEL_ALIAS,
    choices: [{ index: 0, delta: { tool_calls: [{ index, ...toolCall }] }, finish_reason: null }],
  }));
  chunks.push({
    id,
    object: "chat.completion.chunk",
    created,
    model: OPENCLAW_MODEL_ALIAS,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    usage,
  });
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { headers: sseHeaders() });
}

function parseMessage(raw: unknown) {
  if (!isRecord(raw) || typeof raw.role !== "string" || !MESSAGE_ROLES.has(raw.role)) throw new Error("MODEL_PROXY_REQUEST_INVALID");
  const result: Record<string, unknown> = { role: raw.role };
  if (raw.content !== undefined) {
    validateContent(raw.content);
    result.content = raw.content;
  }
  if (raw.name !== undefined) {
    if (typeof raw.name !== "string" || !FUNCTION_NAME.test(raw.name)) throw new Error("MODEL_PROXY_REQUEST_INVALID");
    result.name = raw.name;
  }
  if (raw.tool_call_id !== undefined) {
    if (typeof raw.tool_call_id !== "string" || raw.tool_call_id.length > 256) throw new Error("MODEL_PROXY_REQUEST_INVALID");
    result.tool_call_id = raw.tool_call_id;
  }
  if (raw.tool_calls !== undefined) {
    if (raw.role !== "assistant" || !Array.isArray(raw.tool_calls) || raw.tool_calls.length > 32) throw new Error("MODEL_PROXY_REQUEST_INVALID");
    result.tool_calls = raw.tool_calls.map(parseToolCall);
  }
  if (result.content === undefined && result.tool_calls === undefined) throw new Error("MODEL_PROXY_REQUEST_INVALID");
  if (raw.role === "tool" && typeof result.tool_call_id !== "string") throw new Error("MODEL_PROXY_REQUEST_INVALID");
  return result;
}

function parseToolCall(raw: unknown) {
  if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.length > 256 || raw.type !== "function" || !isRecord(raw.function)) {
    throw new Error("MODEL_PROXY_REQUEST_INVALID");
  }
  const fn = raw.function;
  if (typeof fn.name !== "string" || !FUNCTION_NAME.test(fn.name) || typeof fn.arguments !== "string" || fn.arguments.length > 200_000) {
    throw new Error("MODEL_PROXY_REQUEST_INVALID");
  }
  return { id: raw.id, type: "function", function: { name: fn.name, arguments: fn.arguments } };
}

function parseTools(raw: unknown) {
  if (!Array.isArray(raw) || raw.length > 64) throw new Error("MODEL_PROXY_REQUEST_INVALID");
  for (const tool of raw) {
    if (!isRecord(tool) || tool.type !== "function" || !isRecord(tool.function)) throw new Error("MODEL_PROXY_REQUEST_INVALID");
    const fn = tool.function;
    if (typeof fn.name !== "string" || !FUNCTION_NAME.test(fn.name)) throw new Error("MODEL_PROXY_REQUEST_INVALID");
    if (fn.description !== undefined && (typeof fn.description !== "string" || fn.description.length > 8_000)) throw new Error("MODEL_PROXY_REQUEST_INVALID");
    if (fn.parameters !== undefined && !isRecord(fn.parameters)) throw new Error("MODEL_PROXY_REQUEST_INVALID");
  }
}

function parseToolChoice(raw: unknown) {
  if (["none", "auto", "required"].includes(String(raw))) return;
  if (!isRecord(raw) || raw.type !== "function" || !isRecord(raw.function) || typeof raw.function.name !== "string" || !FUNCTION_NAME.test(raw.function.name)) {
    throw new Error("MODEL_PROXY_REQUEST_INVALID");
  }
}

function validateContent(raw: unknown) {
  if (raw === null || typeof raw === "string") return;
  if (!Array.isArray(raw) || raw.length > 256) throw new Error("MODEL_PROXY_REQUEST_INVALID");
  for (const part of raw) {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") throw new Error("MODEL_PROXY_REQUEST_INVALID");
  }
}

function textBlocks(raw: unknown): Array<Record<string, unknown>> {
  const text = textContent(raw);
  return text ? [{ type: "text", text }] : [];
}

function textContent(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (!Array.isArray(raw)) return "";
  return raw.filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string).join("");
}

function appendAnthropicMessage(
  messages: Array<{ role: "user" | "assistant"; content: Array<Record<string, unknown>> }>,
  role: "user" | "assistant",
  content: Array<Record<string, unknown>>,
) {
  if (!content.length) return;
  const last = messages.at(-1);
  if (last?.role === role) last.content.push(...content);
  else messages.push({ role, content });
}

function parseToolArguments(value: unknown) {
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function anthropicToolChoice(raw: unknown) {
  if (raw === "auto") return { type: "auto" };
  if (raw === "required") return { type: "any" };
  if (raw === "none" || raw === undefined) return null;
  if (isRecord(raw) && isRecord(raw.function) && typeof raw.function.name === "string") return { type: "tool", name: raw.function.name };
  return null;
}

function anthropicFinishReason(raw: unknown) {
  if (raw === "tool_use") return "tool_calls";
  if (raw === "max_tokens") return "length";
  return "stop";
}

function anthropicUsage(raw: unknown) {
  const usage = isRecord(raw) ? raw : {};
  const prompt = finiteNonNegative(usage.input_tokens);
  const completion = finiteNonNegative(usage.output_tokens);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

function finiteNonNegative(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function numberInRange(value: unknown, min: number, max: number) {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)) throw new Error("MODEL_PROXY_REQUEST_INVALID");
}

function integerInRange(value: unknown, min: number, max: number) {
  if (value !== undefined && (!Number.isInteger(value) || (value as number) < min || (value as number) > max)) throw new Error("MODEL_PROXY_REQUEST_INVALID");
}

function isShortStringOrArray(value: unknown, maxItems: number, maxLength: number) {
  if (typeof value === "string") return value.length <= maxLength;
  return Array.isArray(value) && value.length <= maxItems && value.every((item) => typeof item === "string" && item.length <= maxLength);
}

function assertJsonLimits(value: unknown) {
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { throw new Error("MODEL_PROXY_REQUEST_INVALID"); }
  if (!encoded || Buffer.byteLength(encoded, "utf8") > OPENCLAW_MODEL_REQUEST_MAX_BYTES) throw new Error("MODEL_PROXY_REQUEST_TOO_LARGE");
  walk(value, 0);
}

function walk(value: unknown, depth: number) {
  if (depth > 20) throw new Error("MODEL_PROXY_REQUEST_INVALID");
  if (typeof value === "string" && value.length > 500_000) throw new Error("MODEL_PROXY_REQUEST_INVALID");
  if (Array.isArray(value)) {
    if (value.length > 2_000) throw new Error("MODEL_PROXY_REQUEST_INVALID");
    value.forEach((item) => walk(item, depth + 1));
  } else if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > 500) throw new Error("MODEL_PROXY_REQUEST_INVALID");
    entries.forEach(([, item]) => walk(item, depth + 1));
  }
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

function sseHeaders() {
  return { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
