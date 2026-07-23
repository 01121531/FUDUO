import type { PrismaClient } from "@fuduo/database";
import { isReportCron } from "@fuduo/shared";
import type { Queue } from "bullmq";
import { retryableJobOptions } from "./queue.js";

const PREFIX = "scheduled-report-";

export async function ensureDefaultReportSchedules(prisma: Pick<PrismaClient, "scheduledReport">) {
  if (await prisma.scheduledReport.count() > 0) return false;
  await prisma.scheduledReport.createMany({
    data: [
      { type: "DAILY", cron: "0 30 8 * * *", timezone: "Asia/Shanghai", shopIds: [], channels: ["WEB", "WECHAT"] },
      { type: "WEEKLY", cron: "0 0 9 * * 1", timezone: "Asia/Shanghai", shopIds: [], channels: ["WEB", "WECHAT"] },
    ],
  });
  return true;
}

export async function reconcileReportSchedulers(
  prisma: Pick<PrismaClient, "scheduledReport">,
  queue: Pick<Queue<unknown, unknown, string>, "getJobSchedulers" | "removeJobScheduler" | "upsertJobScheduler">,
) {
  const schedules = await prisma.scheduledReport.findMany({ orderBy: { createdAt: "asc" } });
  const active = new Set(schedules.filter((schedule) => schedule.active).map((schedule) => `${PREFIX}${schedule.id}`));
  const installed = await queue.getJobSchedulers(0, 999, true);
  for (const scheduler of installed) {
    if (scheduler.key.startsWith(PREFIX) && !active.has(scheduler.key)) await queue.removeJobScheduler(scheduler.key);
  }
  let count = 0;
  for (const schedule of schedules) {
    if (!schedule.active) continue;
    if ((schedule.type !== "DAILY" && schedule.type !== "WEEKLY") || schedule.timezone !== "Asia/Shanghai" || !isReportCron(schedule.cron)) continue;
    await queue.upsertJobScheduler(
      `${PREFIX}${schedule.id}`,
      { pattern: schedule.cron, tz: schedule.timezone },
      { name: "report-generate", data: { reportType: schedule.type, scheduledReportId: schedule.id, shopIds: schedule.shopIds }, opts: retryableJobOptions() },
    );
    count += 1;
  }
  return { configured: count };
}
