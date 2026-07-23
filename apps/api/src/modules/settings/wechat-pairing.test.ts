import { describe, expect, it } from "vitest";
import {
  normalizeWechatNickname,
  resolveWechatPairingStatus,
} from "./wechat-pairing.js";

describe("WeChat pairing view", () => {
  it("normalizes a real nickname from supported OpenClaw metadata", () => {
    expect(normalizeWechatNickname({ displayName: "  微信\n员工  " })).toBe(
      "微信 员工",
    );
    expect(normalizeWechatNickname({ nickname: "店长小王" })).toBe("店长小王");
    expect(
      normalizeWechatNickname({ displayName: "", unrelated: "not-a-name" }),
    ).toBeNull();
  });

  it("does not claim a pairing is active without runtime confirmation", () => {
    const runtime = { pending: [], approved: ["wx-confirmed"] };
    expect(resolveWechatPairingStatus(runtime, "wx-confirmed")).toBe("PAIRED");
    expect(resolveWechatPairingStatus(runtime, "wx-missing")).toBe(
      "NEEDS_REVIEW",
    );
    expect(resolveWechatPairingStatus(null, "wx-confirmed")).toBe("UNKNOWN");
  });
});
