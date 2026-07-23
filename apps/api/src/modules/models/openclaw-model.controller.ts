import { Readable } from "node:stream";
import { Body, Controller, Get, Inject, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Public } from "../auth/public.decorator.js";
import { InternalServiceGuard } from "../tools/internal-service.guard.js";
import { ModelProviderService } from "./model-provider.service.js";
import { OPENCLAW_MODEL_ALIAS, parseOpenClawCompletionRequest } from "./openclaw-model-proxy.js";
import { RateLimit } from "../rate-limit/rate-limit.decorator.js";

@Public()
@UseGuards(InternalServiceGuard)
@Controller("internal/openclaw/v1")
export class OpenClawModelController {
  constructor(@Inject(ModelProviderService) private readonly models: ModelProviderService) {}

  @Get("models")
  listModels() {
    return {
      object: "list",
      data: [{ id: OPENCLAW_MODEL_ALIAS, object: "model", created: 0, owned_by: "fuduo-runtime" }],
    };
  }

  @RateLimit({ name: "openclaw-completion", limit: 120, windowSeconds: 60, identity: "internal" })
  @Post("chat/completions")
  async complete(
    @Body() rawBody: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const input = parseOpenClawCompletionRequest(rawBody);
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.raw.once("aborted", abort);
    try {
      const response = await this.models.proxyOpenClawCompletion(input, controller.signal);
      reply.status(response.status);
      reply.header("Content-Type", response.headers.get("content-type") ?? (input.stream ? "text/event-stream; charset=utf-8" : "application/json"));
      if (input.stream) {
        reply.header("Cache-Control", "no-cache, no-transform");
        reply.header("X-Accel-Buffering", "no");
      }
      if (!response.body) {
        request.raw.removeListener("aborted", abort);
        return reply.send();
      }
      const stream = Readable.fromWeb(response.body as never);
      stream.once("close", () => request.raw.removeListener("aborted", abort));
      return reply.send(stream);
    } catch (error) {
      request.raw.removeListener("aborted", abort);
      throw error;
    }
  }
}
