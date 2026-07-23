import { Controller, Get, Inject, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { ok } from "../../common/response.js";
import { Public } from "../auth/public.decorator.js";
import { DatabaseService } from "../database/database.service.js";
import { SyncQueueService } from "../sync/sync-queue.service.js";

@Controller("health")
export class HealthController {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SyncQueueService) private readonly queue: SyncQueueService,
  ) {}

  @Public()
  @Get()
  health() {
    return ok({ status: "ok", demoMode: process.env.DEMO_MODE === "true", timestamp: new Date().toISOString() });
  }

  @Public()
  @Get("live")
  live() {
    return this.health();
  }

  @Public()
  @Get("ready")
  async ready(@Res({ passthrough: true }) reply: FastifyReply) {
    if (!this.database.enabled) {
      reply.status(200);
      return ok({
        status: "ready",
        demoMode: true,
        checks: { postgres: "disabled", redis: "disabled" },
        timestamp: new Date().toISOString(),
      });
    }
    const [postgres, redis] = await Promise.all([
      this.database.ping().catch(() => false),
      this.queue.ping().catch(() => false),
    ]);
    const ready = postgres && redis;
    reply.status(ready ? 200 : 503);
    return ok({
      status: ready ? "ready" : "not_ready",
      demoMode: false,
      checks: { postgres: postgres ? "ok" : "unavailable", redis: redis ? "ok" : "unavailable" },
      timestamp: new Date().toISOString(),
    });
  }
}
