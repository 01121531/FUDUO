import { Body, Controller, Headers, Inject, NotFoundException, Param, Post, UseGuards } from "@nestjs/common";
import { ok } from "../../common/response.js";
import { BusinessToolService } from "./business-tool.service.js";
import { InternalServiceGuard } from "./internal-service.guard.js";
import { Public } from "../auth/public.decorator.js";
import { AccessControlService } from "../auth/access-control.service.js";
import { parseInboundInvocationIdentity, ToolInvocationDeduplicator } from "./tool-invocation-deduplicator.js";

@Controller("tools")
@UseGuards(InternalServiceGuard)
@Public()
export class BusinessToolController {
  constructor(
    @Inject(BusinessToolService) private readonly tools: BusinessToolService,
    @Inject(AccessControlService) private readonly access: AccessControlService,
    @Inject(ToolInvocationDeduplicator) private readonly deduplicator: ToolInvocationDeduplicator,
  ) {}

  @Post(":name")
  async invoke(
    @Param("name") name: string,
    @Body() params: unknown,
    @Headers("x-channel-user-id") channelUserId?: string,
    @Headers("x-internal-caller") internalCaller?: string,
    @Headers("x-channel-id") channel?: string,
    @Headers("x-channel-account-id") channelAccountId?: string,
    @Headers("x-channel-message-id") externalMessageId?: string,
  ): Promise<unknown> {
    if (!this.tools.hasTool(name)) throw new NotFoundException("业务工具不存在");
    if (internalCaller === "worker" && isWorkerTool(name)) return ok(await this.tools.invoke(name, params, { system: true }));
    const userId = await this.access.resolveChannelUser(channelUserId);
    await this.access.assertPermission(userId, "chat:use");
    const identity = parseInboundInvocationIdentity({ channel, accountId: channelAccountId, externalMessageId });
    return ok(await this.deduplicator.run(identity, { name, params, ...(userId ? { userId } : {}) }, () => this.tools.invoke(name, params, userId ? { userId } : {})));
  }
}

function isWorkerTool(name: string) {
  return name === "generate_daily_report" || name === "generate_weekly_report" || name === "get_sync_status";
}
