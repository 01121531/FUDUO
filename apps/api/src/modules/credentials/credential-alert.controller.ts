import { Controller, Inject, Post, UseGuards } from "@nestjs/common";
import { ok } from "../../common/response.js";
import { Public } from "../auth/public.decorator.js";
import { InternalServiceGuard } from "../tools/internal-service.guard.js";
import { CredentialAlertService } from "./credential-alert.service.js";

@Controller("internal/alerts")
@UseGuards(InternalServiceGuard)
@Public()
export class CredentialAlertController {
  constructor(@Inject(CredentialAlertService) private readonly alerts: CredentialAlertService) {}

  @Post("erp-reauth")
  async erpReauth() {
    return ok(await this.alerts.notifyReauthRequired());
  }
}
