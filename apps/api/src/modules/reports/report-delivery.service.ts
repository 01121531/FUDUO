import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service.js";
import { AccessControlService } from "../auth/access-control.service.js";
import { OpenClawAdminService } from "../settings/openclaw-admin.service.js";
import { canReceiveReport } from "./report-access.js";
import { buildWechatReportPreview, parseReportSnapshotData } from "./report-view.js";

const SAFE_PRE_SEND_ERRORS = new Set([
  "OPENCLAW_ADMIN_NOT_CONFIGURED",
  "WECHAT_RECIPIENT_INVALID",
  "WECHAT_MESSAGE_INVALID",
  "WECHAT_ACCOUNT_NOT_CONFIGURED",
  "WECHAT_ACCOUNT_AMBIGUOUS",
  "WECHAT_BASE_URL_INVALID",
  "OPENCLAW_STATE_DIR_REQUIRED",
  "OPENCLAW_STATE_FILE_TOO_LARGE",
]);
const DELIVERY_LEASE_MS = 120_000;

@Injectable()
export class ReportDeliveryService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AccessControlService) private readonly access: AccessControlService,
    @Inject(OpenClawAdminService) private readonly openClaw: OpenClawAdminService,
  ) {}

  async execute(id: string) {
    if (!this.database.enabled) throw new Error("REPORT_DELIVERY_UNAVAILABLE");
    const now = new Date();
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + DELIVERY_LEASE_MS);
    const existing = await this.database.prisma.reportDelivery.findUnique({
      where: { id },
      select: { id: true, status: true, attempts: true, externalMessageId: true, leaseExpiresAt: true },
    });
    if (!existing) throw new Error("REPORT_DELIVERY_NOT_FOUND");
    if (existing.status === "SUCCEEDED" || (existing.status === "SENDING" && existing.leaseExpiresAt && existing.leaseExpiresAt > now)) return deliveryResult(existing, true);

    const claimed = await this.database.prisma.reportDelivery.updateMany({
      where: {
        id,
        OR: [
          { status: { in: ["QUEUED", "FAILED"] } },
          { status: "SENDING", OR: [{ leaseExpiresAt: { lte: now } }, { leaseExpiresAt: null }] },
        ],
      },
      data: { status: "SENDING", attempts: { increment: 1 }, lastAttemptAt: now, errorCode: null, leaseToken, leaseExpiresAt },
    });
    if (claimed.count !== 1) {
      const current = await this.database.prisma.reportDelivery.findUnique({
        where: { id },
        select: { id: true, status: true, attempts: true, externalMessageId: true },
      });
      if (!current) throw new Error("REPORT_DELIVERY_NOT_FOUND");
      return deliveryResult(current, true);
    }

    const delivery = await this.database.prisma.reportDelivery.findUnique({
      where: { id },
      include: { reportSnapshot: true },
    });
    if (!delivery) throw new Error("REPORT_DELIVERY_NOT_FOUND");

    let text: string;
    try {
      if (delivery.channel !== "WECHAT") throw new Error("REPORT_DELIVERY_CHANNEL_INVALID");
      const pairings = await this.database.prisma.channelUser.findMany({
        where: {
          externalUserId: delivery.recipient,
          revokedAt: null,
          user: { active: true },
          channelAccount: { channel: "openclaw-weixin", active: true },
        },
        select: { userId: true },
        take: 2,
      });
      const userIds = [...new Set(pairings.map((pairing) => pairing.userId))];
      if (userIds.length !== 1) throw new Error(userIds.length ? "REPORT_DELIVERY_RECIPIENT_AMBIGUOUS" : "REPORT_DELIVERY_RECIPIENT_REVOKED");
      const scope = await this.access.scope(userIds[0]);
      if (!canReceiveReport(scope, delivery.reportSnapshot.shopIds)) throw new Error("REPORT_DELIVERY_FORBIDDEN");
      const type = reportType(delivery.reportSnapshot.type);
      const data = parseReportSnapshotData(delivery.reportSnapshot.data);
      text = buildWechatReportPreview(
        type,
        dayKey(delivery.reportSnapshot.periodStart),
        dayKey(delivery.reportSnapshot.periodEnd),
        data,
      );
    } catch (error) {
      await this.markFailed(id, leaseToken, errorCode(error));
      throw error;
    }

    let sent: { messageId: string };
    try {
      const renewed = await this.database.prisma.reportDelivery.updateMany({
        where: { id, status: "SENDING", leaseToken },
        data: { leaseExpiresAt: new Date(Date.now() + DELIVERY_LEASE_MS) },
      });
      if (renewed.count !== 1) throw new Error("REPORT_DELIVERY_STATE_CHANGED");
      sent = await this.openClaw.send(delivery.recipient, text, id);
    } catch (error) {
      const code = errorCode(error);
      if (SAFE_PRE_SEND_ERRORS.has(code)) await this.markFailed(id, leaseToken, code);
      throw new Error(SAFE_PRE_SEND_ERRORS.has(code) ? code : "REPORT_DELIVERY_UNCERTAIN");
    }

    const completed = await this.database.prisma.reportDelivery.updateMany({
      where: { id, status: "SENDING", leaseToken },
      data: { status: "SUCCEEDED", externalMessageId: sent.messageId, sentAt: new Date(), errorCode: null, leaseToken: null, leaseExpiresAt: null },
    });
    if (completed.count !== 1) throw new Error("REPORT_DELIVERY_STATE_CHANGED");
    const current = await this.database.prisma.reportDelivery.findUnique({
      where: { id },
      select: { id: true, status: true, attempts: true, externalMessageId: true },
    });
    if (!current) throw new Error("REPORT_DELIVERY_NOT_FOUND");
    return deliveryResult(current, false);
  }

  private async markFailed(id: string, leaseToken: string, code: string) {
    await this.database.prisma.reportDelivery.updateMany({
      where: { id, status: "SENDING", leaseToken },
      data: { status: "FAILED", errorCode: code, leaseToken: null, leaseExpiresAt: null },
    });
  }
}

function deliveryResult(
  delivery: { id: string; status: string; attempts: number; externalMessageId: string | null },
  idempotent: boolean,
) {
  return {
    id: delivery.id,
    status: delivery.status,
    attempts: delivery.attempts,
    idempotent,
    ...(delivery.externalMessageId ? { externalMessageId: delivery.externalMessageId } : {}),
  };
}

function reportType(value: string): "DAILY" | "WEEKLY" {
  if (value === "DAILY" || value === "WEEKLY") return value;
  throw new Error("REPORT_TYPE_INVALID");
}

function dayKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

function errorCode(error: unknown) {
  return error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "REPORT_DELIVERY_FAILED";
}
