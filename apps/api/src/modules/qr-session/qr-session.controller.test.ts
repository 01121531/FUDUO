import { NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { of } from "rxjs";
import { QrSessionController } from "./qr-session.controller.js";

describe("QrSessionController", () => {
  it("binds a new QR session to the authenticated administrator", async () => {
    const create = vi.fn(async (ownerId: string) => ({ id: "qr-1", ownerId }));
    const access = { assertPermission: vi.fn(async () => ({ userId: "admin-1" })) };
    const response = await new QrSessionController({ create } as never, access as never).create({ user: { id: "admin-1" } });

    expect(access.assertPermission).toHaveBeenCalledWith("admin-1", "settings:erp");
    expect(create).toHaveBeenCalledWith("admin-1");
    expect(response.data).toEqual({ id: "qr-1", ownerId: "admin-1" });
  });

  it("uses the authenticated user ID for reads, events, and cancellation", async () => {
    const stream = of({ type: "status", data: { status: "WAITING_SCAN" } });
    const sessions = {
      get: vi.fn((id: string, ownerId: string) => ownerId === "admin-1" ? { id } : null),
      events: vi.fn((id: string, ownerId: string) => ownerId === "admin-1" ? stream : null),
      cancel: vi.fn(async (id: string, ownerId: string) => ownerId === "admin-1" ? { id, status: "CANCELLED" } : null),
    };
    const controller = new QrSessionController(sessions as never, {} as never);

    expect(controller.get("qr-1", { user: { id: "admin-1" } }).data).toEqual({ id: "qr-1" });
    expect(controller.events("qr-1", { user: { id: "admin-1" } })).toBe(stream);
    expect((await controller.cancel("qr-1", { user: { id: "admin-1" } })).data).toMatchObject({ status: "CANCELLED" });
    expect(sessions.get).toHaveBeenCalledWith("qr-1", "admin-1");
    expect(sessions.events).toHaveBeenCalledWith("qr-1", "admin-1");
    expect(sessions.cancel).toHaveBeenCalledWith("qr-1", "admin-1");
  });

  it("returns not found instead of revealing another administrator's session", async () => {
    const controller = new QrSessionController({ get: () => null, events: () => null, cancel: async () => null } as never, {} as never);
    expect(() => controller.get("qr-private", { user: { id: "other-user" } })).toThrow(NotFoundException);
    expect(() => controller.events("qr-private", { user: { id: "other-user" } })).toThrow(NotFoundException);
    await expect(controller.cancel("qr-private", { user: { id: "other-user" } })).rejects.toBeInstanceOf(NotFoundException);
  });
});
