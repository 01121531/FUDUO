import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WeixinSender } from "./weixin-sender.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("WeixinSender", () => {
  it("selects the account with the recipient context token without exposing credentials", async () => {
    const stateDir = await state({
      first: { token: "token-first", contexts: {} },
      second: { token: "token-second", contexts: { "employee@im.wechat": "context-2" } },
    });
    const send = vi.fn(async () => ({ messageId: "message-1" }));
    const runId = "550e8400-e29b-41d4-a716-446655440000";
    await expect(new WeixinSender(stateDir, send).send("employee@im.wechat", "经营日报", runId)).resolves.toEqual({ messageId: "message-1" });
    expect(send).toHaveBeenCalledWith({ to: "employee@im.wechat", text: "经营日报", opts: { baseUrl: "https://ilinkai.weixin.qq.com", token: "token-second", contextToken: "context-2", runId, timeoutMs: 15_000 } });
  });

  it("rejects ambiguous accounts and invalid recipients before sending", async () => {
    const stateDir = await state({ first: { token: "token-first", contexts: {} }, second: { token: "token-second", contexts: {} } });
    const send = vi.fn(async () => ({ messageId: "message-1" }));
    const sender = new WeixinSender(stateDir, send);
    await expect(sender.send("employee@im.wechat", "经营日报")).rejects.toThrow("WECHAT_ACCOUNT_AMBIGUOUS");
    await expect(sender.send("invalid", "经营日报")).rejects.toThrow("WECHAT_RECIPIENT_INVALID");
    expect(send).not.toHaveBeenCalled();
  });
});

async function state(accounts: Record<string, { token: string; contexts: Record<string, string> }>) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "fuduo-weixin-"));
  temporaryDirectories.push(stateDir);
  const root = path.join(stateDir, "openclaw-weixin");
  const accountDir = path.join(root, "accounts");
  await mkdir(accountDir, { recursive: true });
  await writeFile(path.join(root, "accounts.json"), JSON.stringify(Object.keys(accounts)), "utf8");
  await Promise.all(Object.entries(accounts).flatMap(([id, account]) => [
    writeFile(path.join(accountDir, `${id}.json`), JSON.stringify({ token: account.token }), "utf8"),
    writeFile(path.join(accountDir, `${id}.context-tokens.json`), JSON.stringify(account.contexts), "utf8"),
  ]));
  return stateDir;
}
