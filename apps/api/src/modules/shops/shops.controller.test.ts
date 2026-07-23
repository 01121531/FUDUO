import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { ShopsController } from "./shops.controller.js";

describe("ShopsController", () => {
  it("validates the history window and applies the employee shop scope", async () => {
    const history = { shopId: "101", range: { days: 30 }, sales: [], orders: [], refunds: [] };
    const shopHistory = vi.fn(async () => history);
    const readableShopIds = vi.fn(async () => ["101"]);
    const controller = new ShopsController({ shopHistory } as never, { readableShopIds } as never);

    const response = await controller.sales("101", "30", { user: { id: "employee-1" } });

    expect(readableShopIds).toHaveBeenCalledWith("employee-1", ["101"]);
    expect(shopHistory).toHaveBeenCalledWith("101", 30, ["101"]);
    expect(response.data).toBe(history);
    await expect(controller.sales("101", "31", { user: { id: "employee-1" } })).rejects.toBeInstanceOf(BadRequestException);
  });
});
