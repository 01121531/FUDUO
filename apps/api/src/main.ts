import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module.js";
import { ApiExceptionFilter } from "./common/api-exception.filter.js";
import fastifyCookie from "@fastify/cookie";
import { MetricsService } from "./modules/health/metrics.service.js";
import { validateApiEnvironment } from "@fuduo/shared/environment";
import { normalizeTraceId, runWithRequestContext } from "./common/request-context.js";

validateApiEnvironment();

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false, trustProxy: true }),
  );
  app.setGlobalPrefix("api");
  await app.register(fastifyCookie);
  app.enableCors({
    origin: process.env.WEB_ORIGIN?.split(",") ?? ["http://127.0.0.1:3000", "http://localhost:3000"],
    credentials: true,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();
  app.use((request: { headers: Record<string, string | string[] | undefined>; traceId?: string }, response: { setHeader?: (name: string, value: string) => void }, next: () => void) => {
    const traceId = normalizeTraceId(request.headers["x-trace-id"]);
    request.traceId = traceId;
    response.setHeader?.("x-trace-id", traceId);
    runWithRequestContext(traceId, next);
  });
  const metrics = app.get(MetricsService);
  app.getHttpAdapter().getInstance().addHook("onResponse", (request, reply, done) => {
    metrics.observeHttp(request.method, request.routeOptions.url ?? request.url, reply.statusCode, reply.elapsedTime / 1_000);
    done();
  });

  const port = Number(process.env.API_PORT ?? 3001);
  const host = process.env.API_HOST ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
  await app.listen(port, host);
  process.stdout.write(`${JSON.stringify({ level: "info", event: "api.started", host, port, at: new Date().toISOString() })}\n`);
}

void bootstrap();
