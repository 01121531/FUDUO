import { describe, expect, it } from "vitest";
import { encodeWechatQr } from "./wechat-qr";

describe("WeChat QR encoding", () => {
  it("encodes Tencent QR content into a browser-safe PNG data URL", async () => {
    const image = await encodeWechatQr("https://weixin.qq.com/x/session-content");
    expect(image).toMatch(/^data:image\/png;base64,/);
    expect(image).not.toContain("session-content");
  });
});
