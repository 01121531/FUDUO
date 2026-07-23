import { PairingManager } from "./pairing-manager.js";
import { createOpenClawAdminServer } from "./server.js";
import { WeixinSender } from "./weixin-sender.js";
import { validateOpenClawAdminEnvironment } from "@fuduo/shared/environment";
import { WechatLoginManager } from "./wechat-login-manager.js";
import { createReadinessCheck } from "./readiness.js";
import { ExtensionInstaller } from "./extension-installer.js";

validateOpenClawAdminEnvironment();

const token = process.env.OPENCLAW_ADMIN_TOKEN;
if (!token || token.length < 32) throw new Error("OPENCLAW_ADMIN_TOKEN must contain at least 32 characters");

const manager = new PairingManager();
const sender = new WeixinSender();
const login = new WechatLoginManager();
const readiness = createReadinessCheck({
  stateDir: process.env.OPENCLAW_STATE_DIR!,
  gatewayHealthUrl: process.env.OPENCLAW_GATEWAY_HEALTH_URL ?? "http://openclaw:18789/readyz",
});
const extensions = new ExtensionInstaller(process.env.OPENCLAW_STATE_DIR!);
const server = createOpenClawAdminServer({
  list: () => manager.list(),
  approve: (code) => manager.approve(code),
  revoke: (externalUserId) => manager.revoke(externalUserId),
  send: (externalUserId, text, idempotencyKey) => sender.send(externalUserId, text, idempotencyKey),
  loginStatus: () => login.status(),
  loginStart: (accountId) => login.start(accountId),
  loginCancel: () => login.cancel(),
  loginVerify: (code) => login.submitVerificationCode(code),
  installExtension: (bundle) => extensions.install(bundle),
}, token, readiness);

const port = Number(process.env.OPENCLAW_ADMIN_PORT ?? 18790);
const host = process.env.OPENCLAW_ADMIN_HOST ?? "0.0.0.0";
server.listen(port, host, () => {
  process.stdout.write(`${JSON.stringify({ level: "info", event: "openclaw-admin.started", host, port, at: new Date().toISOString() })}\n`);
});
