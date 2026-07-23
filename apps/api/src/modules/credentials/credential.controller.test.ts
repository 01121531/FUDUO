import { describe, expect, it, vi } from "vitest";
import { CredentialController } from "./credential.controller.js";

describe("CredentialController", () => {
  it("always verifies a manually imported token against the Fuduo account", async () => {
    const importToken = vi.fn(async () => ({ status: "ACTIVE" }));
    const assertPermission = vi.fn(async () => undefined);
    const controller = new CredentialController({ importToken } as never, { assertPermission } as never);

    await controller.import({ authorization: "Bearer signed-token-value" }, { user: { id: "admin-1" } });

    expect(assertPermission).toHaveBeenCalledWith("admin-1", "settings:erp");
    expect(importToken).toHaveBeenCalledWith("Bearer signed-token-value", true);
  });
});
