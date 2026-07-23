import { Controller, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { ok } from "../../common/response.js";
import { Public } from "../auth/public.decorator.js";
import { InternalServiceGuard } from "../tools/internal-service.guard.js";
import { ReportDeliveryService } from "./report-delivery.service.js";

@Controller("internal/report-deliveries")
@UseGuards(InternalServiceGuard)
@Public()
export class ReportDeliveryController {
  constructor(@Inject(ReportDeliveryService) private readonly deliveries: ReportDeliveryService) {}

  @Post(":id/execute")
  async execute(@Param("id") id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error("REPORT_DELIVERY_ID_INVALID");
    }
    return ok(await this.deliveries.execute(id));
  }
}
