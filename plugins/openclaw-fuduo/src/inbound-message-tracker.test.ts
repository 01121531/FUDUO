import { describe, expect, it } from "vitest";
import { InboundMessageTracker } from "./inbound-message-tracker.js";

describe("InboundMessageTracker", () => {
  it("correlates a provider message id to each tool call in the same run", () => {
    const tracker = new InboundMessageTracker();
    tracker.recordMessage({ runId: "run-1", messageId: "provider-message-9" }, { channelId: "test-channel", accountId: "account-1" });
    tracker.bindToolCall({ runId: "run-1", toolCallId: "call-1" });

    expect(tracker.identityForTool("call-1")).toEqual({
      channel: "test-channel",
      accountId: "account-1",
      externalMessageId: "provider-message-9",
    });
    expect(tracker.identityForTool("call-1")?.externalMessageId).toBe("provider-message-9");
  });

  it("derives a stable fingerprint because Tencent 2.4.6 does not propagate message_id", () => {
    const first = new InboundMessageTracker();
    const second = new InboundMessageTracker();
    const message = { runId: "run-a", messageId: "random-a", from: "wx-user", timestamp: 1784736000123, content: "查询今日销售" };
    first.recordMessage(message, { channelId: "openclaw-weixin", accountId: "wx-account" });
    second.recordMessage({ ...message, runId: "run-b", messageId: "random-b" }, { channelId: "openclaw-weixin", accountId: "wx-account" });
    first.bindToolCall({ runId: "run-a", toolCallId: "call-a" });
    second.bindToolCall({ runId: "run-b", toolCallId: "call-b" });

    expect(first.identityForTool("call-a")?.externalMessageId).toMatch(/^fingerprint:[a-f0-9]{64}$/);
    expect(first.identityForTool("call-a")?.externalMessageId).toBe(second.identityForTool("call-b")?.externalMessageId);
  });

  it("expires abandoned correlation state", () => {
    let now = 1_000;
    const tracker = new InboundMessageTracker(50, () => now);
    tracker.recordMessage({ runId: "run-1", messageId: "message-1" }, { channelId: "test" });
    now += 51;
    tracker.bindToolCall({ runId: "run-1", toolCallId: "call-1" });

    expect(tracker.identityForTool("call-1")).toBeUndefined();
  });
});
