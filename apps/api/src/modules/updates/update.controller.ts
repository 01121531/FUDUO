import { Controller, Get, Inject, Query, Req } from "@nestjs/common";
import { ok } from "../../common/response.js";
import { AccessControlService } from "../auth/access-control.service.js";
import { UpdateService } from "./update.service.js";

interface AuthenticatedRequest { user?: { id: string } }

@Controller("system/update")
export class UpdateController {
  constructor(
    @Inject(UpdateService) private readonly updates: UpdateService,
    @Inject(AccessControlService) private readonly access: AccessControlService,
  ) {}

  @Get()
  async status(@Query("refresh") refresh: string | undefined, @Req() request: AuthenticatedRequest) {
    await this.access.assertPermission(request.user?.id, "system:update");
    return ok(await this.updates.status(refresh === "true"));
  }
}
