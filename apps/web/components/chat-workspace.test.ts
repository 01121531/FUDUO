import { describe, expect, it } from "vitest";
import { chatFailureMessage, isTerminalTurnStatus, mergeStreamContent } from "./chat-stream";

describe("chat stream rendering", () => {
  it("uses cumulative server content so replayed SSE events do not duplicate text", () => {
    let content = mergeStreamContent("", { delta: "实时", content: "实时" });
    content = mergeStreamContent(content, { delta: "回答", content: "实时回答" });
    content = mergeStreamContent(content, { delta: "实时", content: "实时" });
    content = mergeStreamContent(content, { delta: "回答", content: "实时回答" });

    expect(content).toBe("实时回答");
  });

  it("keeps compatibility with delta-only events", () => {
    expect(mergeStreamContent("实时", { delta: "回答" })).toBe("实时回答");
  });

  it("does not rewind visible content when an older cumulative frame is replayed", () => {
    expect(mergeStreamContent("实时回答", { delta: "实时", content: "实时" })).toBe("实时回答");
  });

  it("renders actionable failures and recognizes terminal cancellation races", () => {
    expect(chatFailureMessage({ message: "模型暂不可用", recovery: "检查模型配置后重试" }))
      .toBe("模型暂不可用。检查模型配置后重试");
    expect(isTerminalTurnStatus("COMPLETED")).toBe(true);
    expect(isTerminalTurnStatus("COMPOSING")).toBe(false);
  });
});
