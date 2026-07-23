import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface OpenClawAdmin {
  list(): Promise<unknown>;
  approve(code: string): Promise<unknown>;
  revoke(externalUserId: string): Promise<unknown>;
  send(externalUserId: string, text: string, idempotencyKey?: string): Promise<unknown>;
  loginStatus(): Promise<unknown> | unknown;
  loginStart(accountId?: string): Promise<unknown>;
  loginCancel(): Promise<unknown> | unknown;
  loginVerify(code: string): Promise<unknown> | unknown;
}

export function createOpenClawAdminServer(manager: OpenClawAdmin, token: string, readiness: () => Promise<boolean> = async () => true) {
  if (token.length < 32) throw new Error("OPENCLAW_ADMIN_TOKEN_INVALID");

  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && (request.url === "/health" || request.url === "/health/live")) {
        return send(response, 200, { status: "ok" });
      }
      if (request.method === "GET" && request.url === "/health/ready") {
        const ready = await readiness().catch(() => false);
        return send(response, ready ? 200 : 503, { status: ready ? "ready" : "unavailable" });
      }
      if (!authorized(request, token)) return send(response, 401, { error: { code: "AUTH_UNAUTHORIZED", message: "未授权" } });
      if (request.method === "GET" && request.url === "/pairings") return send(response, 200, await manager.list());
      if (request.method === "GET" && request.url === "/login/status") return send(response, 200, await manager.loginStatus());
      if (request.method === "POST" && request.url === "/login/start") {
        const body = await readJson(request, true);
        return send(response, 200, await manager.loginStart(optionalStringField(body, "accountId")));
      }
      if (request.method === "POST" && request.url === "/login/cancel") return send(response, 200, await manager.loginCancel());
      if (request.method === "POST" && request.url === "/login/verify") {
        const body = await readJson(request);
        return send(response, 200, await manager.loginVerify(stringField(body, "code")));
      }
      if (request.method === "POST" && request.url === "/pairings/approve") {
        const body = await readJson(request);
        return send(response, 200, await manager.approve(stringField(body, "code")));
      }
      if (request.method === "POST" && request.url === "/pairings/revoke") {
        const body = await readJson(request);
        return send(response, 200, await manager.revoke(stringField(body, "externalUserId")));
      }
      if (request.method === "POST" && request.url === "/messages/send") {
        const body = await readJson(request);
        return send(response, 200, await manager.send(stringField(body, "externalUserId"), stringField(body, "text"), optionalUuidField(body, "idempotencyKey")));
      }
      return send(response, 404, { error: { code: "NOT_FOUND", message: "接口不存在" } });
    } catch (error) {
      const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "SYSTEM_INTERNAL";
      return send(response, errorStatus(code), { error: { code, message: userMessage(code) } });
    }
  });
}

function authorized(request: IncomingMessage, expected: string) {
  const provided = request.headers["x-internal-service-token"];
  if (typeof provided !== "string") return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJson(request: IncomingMessage, allowEmpty = false): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > 16_384) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(value);
  }
  try {
    const text = Buffer.concat(chunks).toString("utf8");
    if (allowEmpty && !text.trim()) return {};
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("REQUEST_INVALID");
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message === "REQUEST_TOO_LARGE") throw error;
    throw new Error("REQUEST_INVALID");
  }
}

function stringField(body: Record<string, unknown>, key: string) {
  const value = body[key];
  if (typeof value !== "string") throw new Error("REQUEST_INVALID");
  return value;
}

function optionalStringField(body: Record<string, unknown>, key: string) {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.trim().length > 256) throw new Error("REQUEST_INVALID");
  return value.trim();
}

function optionalUuidField(body: Record<string, unknown>, key: string) {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error("REQUEST_INVALID");
  return value;
}

function errorStatus(code: string) {
  if (code === "PAIRING_CODE_NOT_FOUND") return 404;
  if (code === "REQUEST_TOO_LARGE") return 413;
  if (code === "REQUEST_INVALID" || code.startsWith("PAIRING_") || code.startsWith("WECHAT_VERIFY_CODE_")) return 400;
  if (code === "OPENCLAW_NOT_CONFIGURED" || code === "WECHAT_LOGIN_QR_UNAVAILABLE") return 503;
  return 500;
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

function userMessage(code: string) {
  const messages: Record<string, string> = {
    PAIRING_CODE_INVALID: "配对码格式无效",
    PAIRING_CODE_NOT_FOUND: "配对码不存在或已过期",
    PAIRING_USER_INVALID: "微信用户标识无效",
    REQUEST_INVALID: "请求参数无效",
    REQUEST_TOO_LARGE: "请求内容过大",
    OPENCLAW_NOT_CONFIGURED: "OpenClaw 微信渠道尚未配置",
    WECHAT_LOGIN_QR_UNAVAILABLE: "暂时无法生成微信登录二维码",
    WECHAT_VERIFY_CODE_INVALID: "验证码格式无效",
    WECHAT_VERIFY_CODE_NOT_REQUIRED: "当前登录不需要验证码",
  };
  return messages[code] ?? "服务处理请求时发生错误";
}
