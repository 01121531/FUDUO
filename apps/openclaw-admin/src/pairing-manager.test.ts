import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { upsertChannelPairingRequest, type PairingChannel } from "openclaw/plugin-sdk/conversation-runtime";
import { PairingManager } from "./pairing-manager.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("PairingManager", () => {
  it("lists, approves, and revokes an OpenClaw WeChat pairing", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "fuduo-openclaw-admin-"));
    temporaryDirectories.push(stateDir);
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const created = await upsertChannelPairingRequest({
      channel: "openclaw-weixin" as PairingChannel,
      id: "wechat-user-001",
      accountId: "default",
      meta: { displayName: "测试员工" },
      env,
    });
    const manager = new PairingManager(env);

    const before = await manager.list();
    expect(before.pending).toEqual([expect.objectContaining({ id: "wechat-user-001", code: created.code })]);
    expect(before.approved).toEqual([]);

    await expect(manager.approve(created.code)).resolves.toEqual(expect.objectContaining({ externalUserId: "wechat-user-001" }));
    const approved = await manager.list();
    expect(approved.pending).toEqual([]);
    expect(approved.approved).toEqual(["wechat-user-001"]);

    await expect(manager.revoke("wechat-user-001")).resolves.toEqual({ externalUserId: "wechat-user-001", revoked: true });
    expect((await manager.list()).approved).toEqual([]);
  }, 45_000);
});
