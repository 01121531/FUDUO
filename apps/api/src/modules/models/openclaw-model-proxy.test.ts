import { describe, expect, it } from "vitest";
import {
  anthropicResponseToOpenAi,
  parseOpenClawCompletionRequest,
  toAnthropicRequest,
} from "./openclaw-model-proxy.js";

describe("OpenClaw model proxy protocol", () => {
  it("accepts the fixed model alias and rejects arbitrary models, fields and oversized bodies", () => {
    const valid = parseOpenClawCompletionRequest({ model: "default", messages: [{ role: "user", content: "查询昨日销售" }], stream: true });
    expect(valid).toEqual(expect.objectContaining({ model: "default", stream: true }));
    expect(() => parseOpenClawCompletionRequest({ model: "gpt-secret", messages: [{ role: "user", content: "x" }] })).toThrow("MODEL_PROXY_MODEL_INVALID");
    expect(() => parseOpenClawCompletionRequest({ model: "default", messages: [{ role: "user", content: "x" }], upstream_url: "http://127.0.0.1" })).toThrow("MODEL_PROXY_REQUEST_INVALID");
    expect(() => parseOpenClawCompletionRequest({ model: "default", messages: [{ role: "user", content: "x".repeat(1_000_001) }] })).toThrow("MODEL_PROXY_REQUEST_TOO_LARGE");
  });

  it("converts OpenAI tool history and definitions to Anthropic messages", () => {
    const request = parseOpenClawCompletionRequest({
      model: "default",
      stream: true,
      messages: [
        { role: "system", content: "只读经营助手" },
        { role: "user", content: "查询店铺" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "list_shops", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "{\"shops\":[]}" },
      ],
      tools: [{ type: "function", function: { name: "list_shops", description: "店铺列表", parameters: { type: "object", properties: {} } } }],
      tool_choice: "auto",
      max_tokens: 1000,
    });

    expect(toAnthropicRequest(request, "claude-test")).toEqual(expect.objectContaining({
      model: "claude-test",
      max_tokens: 1000,
      stream: false,
      system: "只读经营助手",
      tool_choice: { type: "auto" },
      tools: [{ name: "list_shops", description: "店铺列表", input_schema: { type: "object", properties: {} } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "查询店铺" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "list_shops", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "{\"shops\":[]}" }] },
      ],
    }));
  });

  it("converts an Anthropic tool response to OpenAI-compatible SSE", async () => {
    const response = anthropicResponseToOpenAi({
      id: "msg_1",
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "我先查询。" },
        { type: "tool_use", id: "tool_1", name: "get_sales_summary", input: { startDate: "2026-07-21" } },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    }, true);
    const body = await response.text();

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain('"finish_reason":"tool_calls"');
    expect(body).toContain('"name":"get_sales_summary"');
    expect(body).toContain('"arguments":"{\\"startDate\\":\\"2026-07-21\\"}"');
    expect(body).toContain('"prompt_tokens":10');
    expect(body.endsWith("data: [DONE]\n\n")).toBe(true);
  });
});
