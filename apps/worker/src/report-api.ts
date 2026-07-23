interface ReportDeliveryReference {
  id: string;
  channel: string;
  status: string;
}

export interface GeneratedReport {
  deliveries?: ReportDeliveryReference[];
  [key: string]: unknown;
}

export async function requestReportGeneration(
  type: "DAILY" | "WEEKLY",
  shopIds: string[] | undefined,
  scheduledReportId: string | undefined,
  periodStart: string | undefined,
  options: InternalApiOptions = internalApiOptions(),
): Promise<GeneratedReport> {
  const tool = type === "DAILY" ? "generate_daily_report" : "generate_weekly_report";
  const payload = await requestInternalApi(
    options,
    `/tools/${tool}`,
    {
      ...(shopIds?.length ? { shopIds } : {}),
      ...(scheduledReportId ? { scheduledReportId } : {}),
      ...(periodStart ? { [type === "DAILY" ? "date" : "weekStart"]: periodStart } : {}),
    },
    "REPORT_GENERATE_FAILED",
  );
  return isRecord(payload) ? payload as GeneratedReport : {};
}

export async function enqueueReportDeliveries(
  queue: DeliveryQueue,
  report: GeneratedReport,
) {
  const deliveries = Array.isArray(report.deliveries) ? report.deliveries : [];
  let queued = 0;
  for (const delivery of deliveries) {
    if (!isDelivery(delivery) || delivery.channel !== "WECHAT" || (delivery.status !== "QUEUED" && delivery.status !== "SENDING")) continue;
    await queue.add(
      "channel-delivery",
      { reportDeliveryId: delivery.id },
      {
        jobId: `channel-delivery-${delivery.id}`,
        attempts: 3,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: 500,
        removeOnFail: 1_000,
      },
    );
    queued += 1;
  }
  return queued;
}

export async function reconcileQueuedReportDeliveries(
  source: QueuedDeliverySource,
  queue: DeliveryRecoveryQueue,
) {
  const deliveries = await source.reportDelivery.findMany({
    where: {
      channel: "WECHAT",
      OR: [
        { status: "QUEUED" },
        { status: "SENDING", OR: [{ leaseExpiresAt: { lte: new Date() } }, { leaseExpiresAt: null }] },
      ],
    },
    select: { id: true, channel: true, status: true },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  let added = 0;
  let retried = 0;
  for (const delivery of deliveries) {
    if (!isDelivery(delivery)) continue;
    const jobId = `channel-delivery-${delivery.id}`;
    const job = await queue.getJob(jobId);
    if (!job) {
      added += await enqueueReportDeliveries(queue, { deliveries: [delivery] });
      continue;
    }
    const state = await job.getState();
    if (state === "failed") {
      await job.retry("failed");
      retried += 1;
    } else if (state === "completed") {
      await job.remove();
      added += await enqueueReportDeliveries(queue, { deliveries: [delivery] });
    }
  }
  return { found: deliveries.length, added, retried };
}

export interface DeliveryQueue {
  add(
    name: "channel-delivery",
    data: { reportDeliveryId: string },
    options: {
      jobId: string;
      attempts: number;
      backoff: { type: "exponential"; delay: number };
      removeOnComplete: number;
      removeOnFail: number;
    },
  ): Promise<unknown>;
}

interface DeliveryRecoveryQueue extends DeliveryQueue {
  getJob(id: string): Promise<{
    getState(): Promise<string>;
    retry(state?: "failed" | "completed"): Promise<void>;
    remove(): Promise<void>;
  } | undefined>;
}

interface QueuedDeliverySource {
  reportDelivery: {
    findMany(args: {
      where: {
        channel: "WECHAT";
        OR: Array<{ status: string; OR?: Array<{ leaseExpiresAt: { lte: Date } | null }> }>;
      };
      select: { id: true; channel: true; status: true };
      orderBy: { createdAt: "asc" };
      take: number;
    }): Promise<ReportDeliveryReference[]>;
  };
}

export async function executeReportDelivery(
  reportDeliveryId: string,
  options: InternalApiOptions = internalApiOptions(),
) {
  if (!isUuid(reportDeliveryId)) throw new Error("REPORT_DELIVERY_ID_INVALID");
  const payload = await requestInternalApi(
    options,
    `/internal/report-deliveries/${reportDeliveryId}/execute`,
    undefined,
    "REPORT_DELIVERY_EXECUTE_FAILED",
  );
  return payload;
}

export interface InternalApiOptions {
  apiUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export class InternalApiError extends Error {
  constructor(public readonly code: string, public readonly status = 0) {
    super(code);
    this.name = "InternalApiError";
  }
}

export function internalApiOptions(): InternalApiOptions {
  const token = process.env.INTERNAL_SERVICE_TOKEN;
  if (!token) throw new Error("INTERNAL_SERVICE_TOKEN_REQUIRED");
  return { apiUrl: process.env.API_INTERNAL_URL ?? "http://api:3001/api", token };
}

export async function requestInternalApi(options: InternalApiOptions, path: string, body: Record<string, unknown> | undefined, failureCode: string) {
  const baseUrl = assertInternalApiUrl(options.apiUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  try {
    const response = await (options.fetchImpl ?? fetch)(`${baseUrl}${path}`, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "X-Internal-Service-Token": options.token,
        "X-Internal-Caller": "worker",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new InternalApiError(failureCode, response.status);
    }
    const envelope = await readJson(response, options.maxResponseBytes ?? 1_000_000);
    if (!isRecord(envelope) || envelope.success !== true || !("data" in envelope)) {
      throw new InternalApiError("INTERNAL_API_RESPONSE_INVALID", response.status);
    }
    return envelope.data;
  } catch (error) {
    if (error instanceof InternalApiError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new InternalApiError("INTERNAL_API_TIMEOUT", 504);
    }
    throw new InternalApiError("INTERNAL_API_NETWORK_ERROR", 502);
  } finally {
    clearTimeout(timer);
  }
}

function assertInternalApiUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InternalApiError("INTERNAL_API_URL_NOT_ALLOWED");
  }
  const allowedHosts = new Set(["api", "localhost", "127.0.0.1"]);
  if (!new Set(["http:", "https:"]).has(url.protocol) || !allowedHosts.has(url.hostname.toLowerCase()) || url.username || url.password || url.search || url.hash) {
    throw new InternalApiError("INTERNAL_API_URL_NOT_ALLOWED");
  }
  return url.toString().replace(/\/+$/, "");
}

async function readJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new InternalApiError("INTERNAL_API_RESPONSE_TOO_LARGE", response.status);
  }
  if (!response.body) throw new InternalApiError("INTERNAL_API_RESPONSE_INVALID", response.status);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new InternalApiError("INTERNAL_API_RESPONSE_TOO_LARGE", response.status);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new InternalApiError("INTERNAL_API_RESPONSE_INVALID", response.status);
  }
}

function isDelivery(value: unknown): value is ReportDeliveryReference {
  if (!isRecord(value)) return false;
  return isUuid(value.id) && typeof value.channel === "string" && typeof value.status === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
