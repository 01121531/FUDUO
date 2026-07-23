import { Controller, Get, Inject, Res, UseGuards } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { Public } from "../auth/public.decorator.js";
import { InternalServiceGuard } from "../tools/internal-service.guard.js";
import { MetricsService } from "./metrics.service.js";

@Public()
@UseGuards(InternalServiceGuard)
@Controller("metrics")
export class MetricsController {
  constructor(@Inject(MetricsService) private readonly metrics: MetricsService) {}

  @Get()
  async render(@Res({ passthrough: true }) reply: FastifyReply) {
    reply.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    reply.header("Cache-Control", "no-store");
    return this.metrics.render();
  }
}
