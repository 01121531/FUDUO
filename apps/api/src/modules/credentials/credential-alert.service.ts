import { Inject, Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service.js";
import { OpenClawAdminService } from "../settings/openclaw-admin.service.js";

const REAUTH_MESSAGE = "富多授权已失效，销售、订单和退款后台同步已暂停。请登录管理后台，在“设置 > 富多授权”中重新扫码。历史数据仍可正常查询。";

@Injectable()
export class CredentialAlertService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(OpenClawAdminService) private readonly openClaw: OpenClawAdminService,
  ) {}

  async notifyReauthRequired() {
    if (!this.database.enabled) return { total: 0, sent: 0, failed: 0, demo: true };
    const pairings = await this.database.prisma.channelUser.findMany({
      where: {
        revokedAt: null,
        user: { active: true, userRoles: { some: { role: { code: "ADMIN" } } } },
        channelAccount: { channel: "openclaw-weixin", active: true },
      },
      select: { externalUserId: true },
    });
    const recipients = [...new Set(pairings.map((pairing) => pairing.externalUserId))];
    const deliveries = await Promise.allSettled(recipients.map((recipient) => this.openClaw.send(recipient, REAUTH_MESSAGE)));
    const sent = deliveries.filter((delivery) => delivery.status === "fulfilled").length;
    return { total: recipients.length, sent, failed: recipients.length - sent };
  }
}
