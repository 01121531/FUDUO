import { describe, expect, it, vi } from "vitest";
import { ChatController } from "./chat.controller.js";

describe("ChatController permissions", () => {
  it("requires chat:use for every Web Chat entry point", async () => {
    const chat = {
      listConversations: vi.fn(async () => []),
      createConversation: vi.fn(async () => ({ id: "conversation-1" })),
      listMessages: vi.fn(async () => []),
      start: vi.fn(async () => ({ turnId: "turn-1" })),
      events: vi.fn(() => ({ subscribe() {} })),
      cancel: vi.fn(() => ({ cancelled: true })),
    };
    const access = { assertPermission: vi.fn(async () => undefined) };
    const controller = new ChatController(chat as never, access as never);
    const request = { user: { id: "user-1", email: "user@example.com", displayName: "User" } };

    await controller.conversations(request);
    await controller.createConversation({}, request);
    await controller.messages("conversation-1", request);
    await controller.turn({ message: "销售怎么样" }, request);
    await controller.events("turn-1", request);
    await controller.cancel("turn-1", request);

    expect(access.assertPermission).toHaveBeenCalledTimes(6);
    for (const call of access.assertPermission.mock.calls) expect(call).toEqual(["user-1", "chat:use"]);
  });
});
