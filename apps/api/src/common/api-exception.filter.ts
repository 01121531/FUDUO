import { randomUUID } from "node:crypto";
import { ArgumentsHost, Catch, HttpException, HttpStatus, type ExceptionFilter } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { FuduoApiError } from "@fuduo/fuduo-sdk";

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const request = context.getRequest<FastifyRequest & { traceId?: string }>();
    const reply = context.getResponse<FastifyReply>();
    const traceId = request.traceId ?? randomUUID();
    const normalized = normalize(exception);

    process.stderr.write(`${JSON.stringify({
      level: normalized.status >= 500 ? "error" : "warn",
      event: "api.request.failed",
      code: normalized.code,
      status: normalized.status,
      method: request.method,
      route: request.routeOptions?.url ?? "unknown",
      traceId,
      at: new Date().toISOString(),
    })}\n`);

    void reply.status(normalized.status).send({
      success: false,
      error: {
        code: normalized.code,
        message: normalized.message,
        ...(normalized.recovery ? { recovery: normalized.recovery } : {}),
      },
      meta: { traceId },
    });
  }
}

function normalize(exception: unknown) {
  if (exception instanceof FuduoApiError) {
    return {
      status: exception.status >= 400 && exception.status <= 599 ? exception.status : 502,
      code: exception.code,
      message: exception.status === 401 ? "富多授权已失效" : exception.message,
      recovery: exception.status === 401 ? "请在富多授权页面重新扫码" : "请稍后重试",
    };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const response = exception.getResponse();
    const declared = typeof response === "object" && response !== null
      ? response as { code?: unknown; message?: unknown; recovery?: unknown }
      : undefined;
    const code = typeof declared?.code === "string" && /^[A-Z][A-Z0-9_]+$/.test(declared.code)
      ? declared.code
      : status === 401
        ? "AUTH_UNAUTHORIZED"
        : status === 403
          ? "AUTH_FORBIDDEN"
          : status === 404
            ? "DATA_NOT_FOUND"
            : status === 429
              ? "RATE_LIMIT_EXCEEDED"
              : "REQUEST_INVALID";
    return {
      status,
      code,
      message: safeHttpMessage(response, exception.message),
      recovery: typeof declared?.recovery === "string" ? redact(declared.recovery) : status >= 500 ? "请稍后重试" : undefined,
    };
  }
  if (exception instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(exception.message)) {
    const status = errorStatus(exception.message);
    return {
      status,
      code: exception.message,
      message: userMessage(exception.message),
      recovery: exception.message.includes("REAUTH") ? "请在富多授权页面重新扫码" : undefined,
    };
  }
  return { status: HttpStatus.INTERNAL_SERVER_ERROR, code: "SYSTEM_INTERNAL", message: "系统处理请求时发生错误", recovery: "请稍后重试" };
}

function safeHttpMessage(response: string | object, fallback: string): string {
  if (typeof response === "string") return redact(response);
  const message = (response as { message?: unknown }).message;
  if (Array.isArray(message)) return message.map(String).join("；").slice(0, 500);
  return typeof message === "string" ? redact(message) : redact(fallback);
}

function redact(value: string) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]")
    .replace(/(?:cookie|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 500);
}

function userMessage(code: string) {
  const messages: Record<string, string> = {
    ERP_REAUTH_REQUIRED: "富多授权已失效",
    ERP_REFRESH_LOCK_TIMEOUT: "富多授权正在刷新，请稍后重试",
    SHOP_NOT_FOUND: "店铺不存在",
    DATA_INVALID_DATE_RANGE: "开始日期不能晚于结束日期",
    AUTH_INVALID_CREDENTIALS: "当前密码不正确",
    AUTH_TOTP_REQUIRED: "请输入当前动态验证码",
    AUTH_TOTP_INVALID: "动态验证码无效",
    AUTH_TOTP_NOT_CONFIGURED: "TOTP 配置不完整",
    AUTH_TOTP_ENROLLMENT_EXPIRED: "TOTP 绑定会话已过期，请重新开始",
    AUTH_USER_NOT_FOUND: "用户不存在",
    AUTH_UNAUTHORIZED: "请先登录",
    AUTH_FORBIDDEN: "当前账号没有执行此操作的权限",
    MODEL_BASE_URL_INVALID: "模型 Base URL 格式不正确",
    MODEL_BASE_URL_NOT_ALLOWED: "模型 Base URL 不在允许的公网域名内",
    MODEL_HOST_UNRESOLVED: "模型供应商域名无法解析",
    MODEL_PROVIDER_NOT_FOUND: "模型供应商不存在",
    MODEL_PROVIDER_INACTIVE: "模型供应商已停用",
    MODEL_PROVIDER_TYPE_INVALID: "模型供应商接口类型无效",
    MODEL_PROFILE_INVALID: "模型角色无效",
    MODEL_NAME_REQUIRED: "必须指定模型名称",
    MODEL_KEY_MISSING: "请先配置 API Key",
    MODEL_PROVIDER_NAME_REQUIRED: "必须填写供应商名称",
    MODEL_UPDATE_EMPTY: "没有需要更新的模型配置",
    MODEL_PROXY_REQUEST_INVALID: "模型代理请求格式无效",
    MODEL_PROXY_REQUEST_TOO_LARGE: "模型代理请求超过大小限制",
    MODEL_PROXY_MODEL_INVALID: "模型代理只接受固定模型别名",
    MODEL_PROFILE_NOT_CONFIGURED: "尚未配置默认对话模型",
    MODEL_UPSTREAM_UNAVAILABLE: "当前模型服务暂不可用",
    MEMBER_NAME_REQUIRED: "必须填写员工姓名",
    MEMBER_EMAIL_EXISTS: "该登录邮箱已存在",
    MEMBER_NOT_FOUND: "员工不存在",
    MEMBER_ROLE_REQUIRED: "必须选择员工角色",
    MEMBER_SHOP_SCOPE_INVALID: "店铺授权范围包含无效店铺",
    MEMBER_SELF_LOCKOUT: "不能停用自己或移除自己的管理员角色",
    MEMBER_LAST_ADMIN: "系统必须至少保留一名启用的管理员",
    MEMBER_UPDATE_EMPTY: "没有需要更新的员工资料",
    CHANNEL_USER_ID_REQUIRED: "微信调用缺少可信发送者身份",
    CHANNEL_USER_NOT_PAIRED: "微信账号尚未批准或已被撤销",
    EXTENSION_NOT_FOUND: "扩展草案不存在",
    EXTENSION_VALIDATION_FAILED: "扩展草案未通过静态校验",
    EXTENSION_REJECTED: "已拒绝的扩展草案不能安装",
    EXTENSION_INSTALLED: "已安装的扩展不能标记为拒绝",
    EXTENSION_FILES_INVALID: "扩展文件包格式无效",
    EXTENSION_BUNDLE_INVALID: "扩展安装包格式无效",
    EXTENSION_BUNDLE_TOO_LARGE: "扩展安装包超过大小限制",
    EXTENSION_PATH_INVALID: "扩展文件路径无效",
    EXTENSION_MCP_ENTRYPOINT_INVALID: "MCP 启动文件无效",
    EXTENSION_MCP_PROBE_FAILED: "MCP 启动探测失败，未执行安装",
    OPENCLAW_ADMIN_NOT_CONFIGURED: "OpenClaw 管理服务尚未配置",
    OPENCLAW_ADMIN_REQUEST_FAILED: "OpenClaw 管理服务暂不可用",
    UPDATE_REPOSITORY_INVALID: "在线更新仓库配置无效",
    UPDATE_CHECK_FAILED: "暂时无法获取 GitHub 最新版本",
    UPDATE_RELEASE_INVALID: "GitHub Release 信息格式无效",
  };
  return messages[code] ?? "请求无法完成";
}

function errorStatus(code: string) {
  if (code === "AUTH_REQUIRED" || code.includes("REAUTH")) return 401;
  if (code === "MODEL_PROXY_REQUEST_TOO_LARGE" || code === "EXTENSION_BUNDLE_TOO_LARGE") return 413;
  if (code.includes("NOT_FOUND")) return 404;
  if (code === "EXTENSION_REJECTED" || code === "EXTENSION_INSTALLED") return 409;
  if ([
    "MODEL_UPSTREAM_UNAVAILABLE",
    "MODEL_PROFILE_NOT_CONFIGURED",
    "OPENCLAW_ADMIN_NOT_CONFIGURED",
    "OPENCLAW_ADMIN_REQUEST_FAILED",
    "EXTENSION_MCP_PROBE_FAILED",
    "UPDATE_CHECK_FAILED",
  ].includes(code)) return 503;
  if (code === "UPDATE_RELEASE_INVALID") return 502;
  if (code === "UPDATE_REPOSITORY_INVALID") return 500;
  return 400;
}
