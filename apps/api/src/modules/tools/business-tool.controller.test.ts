import { describe, expect, it, vi } from "vitest";
import { BusinessToolController } from "./business-tool.controller.js";

describe("BusinessToolController", () => {
  const passthroughDeduplicator = () => ({
    run: vi.fn(async (_identity: unknown, _input: unknown, execute: () => Promise<unknown>) => execute()),
  });

  it("allows the trusted worker context only for scheduled report tools", async () => {
    const invoke = vi.fn(async () => ({ id: "report-1" }));
    const resolveChannelUser = vi.fn();
    const deduplicator = passthroughDeduplicator();
    const controller = new BusinessToolController({ hasTool: () => true, invoke } as never, { resolveChannelUser } as never, deduplicator as never);

    const response = await controller.invoke("generate_daily_report", {}, undefined, "worker") as { data: { id: string } };

    expect(response.data).toEqual({ id: "report-1" });
    expect(invoke).toHaveBeenCalledWith("generate_daily_report", {}, { system: true });
    expect(resolveChannelUser).not.toHaveBeenCalled();
    expect(deduplicator.run).not.toHaveBeenCalled();
  });

  it("does not let a caller use worker context for arbitrary business tools", async () => {
    const resolveChannelUser = vi.fn(async () => { throw new Error("CHANNEL_USER_ID_REQUIRED"); });
    const controller = new BusinessToolController({ hasTool: () => true, invoke: vi.fn() } as never, { resolveChannelUser } as never, passthroughDeduplicator() as never);

    await expect(controller.invoke("get_sales_summary", {}, undefined, "worker")).rejects.toThrow("CHANNEL_USER_ID_REQUIRED");
  });

  it("maps the trusted channel sender to an internal employee before invoking a tool", async () => {
    const invoke = vi.fn(async () => ({ summary: {} }));
    const resolveChannelUser = vi.fn(async () => "employee-1");
    const assertPermission = vi.fn(async () => undefined);
    const deduplicator = passthroughDeduplicator();
    const controller = new BusinessToolController({ hasTool: () => true, invoke } as never, { resolveChannelUser, assertPermission } as never, deduplicator as never);

    await controller.invoke("get_sales_summary", {}, "wx-sender-1", undefined, "openclaw-weixin", "account-1", "message-1");

    expect(resolveChannelUser).toHaveBeenCalledWith("wx-sender-1");
    expect(assertPermission).toHaveBeenCalledWith("employee-1", "chat:use");
    expect(invoke).toHaveBeenCalledWith("get_sales_summary", {}, { userId: "employee-1" });
    expect(deduplicator.run).toHaveBeenCalledWith(
      { channel: "openclaw-weixin", accountId: "account-1", externalMessageId: "message-1" },
      { name: "get_sales_summary", params: {}, userId: "employee-1" },
      expect.any(Function),
    );
  });

  it("rejects a paired channel user without chat permission", async () => {
    const invoke = vi.fn();
    const access = {
      resolveChannelUser: vi.fn(async () => "employee-1"),
      assertPermission: vi.fn(async () => { throw new Error("FORBIDDEN"); }),
    };
    const controller = new BusinessToolController({ hasTool: () => true, invoke } as never, access as never, passthroughDeduplicator() as never);

    await expect(controller.invoke("get_sales_summary", {}, "wx-sender-1")).rejects.toThrow("FORBIDDEN");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects a partial inbound identity before invoking a business tool", async () => {
    const invoke = vi.fn();
    const controller = new BusinessToolController(
      { hasTool: () => true, invoke } as never,
      { resolveChannelUser: vi.fn(async () => "employee-1"), assertPermission: vi.fn(async () => undefined) } as never,
      passthroughDeduplicator() as never,
    );

    await expect(controller.invoke("get_sales_summary", {}, "wx-sender-1", undefined, "openclaw-weixin"))
      .rejects.toMatchObject({ status: 400 });
    expect(invoke).not.toHaveBeenCalled();
  });
});
