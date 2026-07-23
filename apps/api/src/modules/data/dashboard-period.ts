export const dashboardPeriods = ["today", "yesterday", "7d", "30d", "custom"] as const;
export type DashboardPeriod = typeof dashboardPeriods[number];

export interface DashboardRange {
  period: DashboardPeriod;
  start: string;
  end: string;
  previousStart: string;
  previousEnd: string;
  dayCount: number;
  label: string;
  comparisonLabel: string;
}

export function isDashboardPeriod(value: unknown): value is DashboardPeriod {
  return typeof value === "string" && dashboardPeriods.some((period) => period === value);
}

export function resolveDashboardRange(period: DashboardPeriod, now = new Date(), custom?: { start: string; end: string }): DashboardRange {
  const today = shanghaiBusinessDate(now);
  if (period === "custom") return resolveCustomRange(custom, today);
  const config = {
    today: { end: today, dayCount: 1, label: "今天", comparisonLabel: "较昨天" },
    yesterday: { end: addBusinessDays(today, -1), dayCount: 1, label: "昨天", comparisonLabel: "较前一天" },
    "7d": { end: today, dayCount: 7, label: "近 7 天", comparisonLabel: "较上一个 7 天" },
    "30d": { end: today, dayCount: 30, label: "近 30 天", comparisonLabel: "较上一个 30 天" },
  }[period];
  const start = addBusinessDays(config.end, 1 - config.dayCount);
  const previousEnd = addBusinessDays(start, -1);
  return {
    period,
    start,
    end: config.end,
    previousStart: addBusinessDays(previousEnd, 1 - config.dayCount),
    previousEnd,
    dayCount: config.dayCount,
    label: config.label,
    comparisonLabel: config.comparisonLabel,
  };
}

function resolveCustomRange(custom: { start: string; end: string } | undefined, today: string): DashboardRange {
  if (!custom || !isBusinessDate(custom.start) || !isBusinessDate(custom.end)) throw new Error("DASHBOARD_CUSTOM_RANGE_INVALID");
  if (custom.start > custom.end) throw new Error("DASHBOARD_CUSTOM_RANGE_REVERSED");
  if (custom.end > today) throw new Error("DASHBOARD_CUSTOM_RANGE_FUTURE");
  const dayCount = Math.round((businessDateAsUtc(custom.end).getTime() - businessDateAsUtc(custom.start).getTime()) / 86_400_000) + 1;
  if (dayCount > 366) throw new Error("DASHBOARD_CUSTOM_RANGE_TOO_LARGE");
  const previousEnd = addBusinessDays(custom.start, -1);
  return {
    period: "custom",
    start: custom.start,
    end: custom.end,
    previousStart: addBusinessDays(previousEnd, 1 - dayCount),
    previousEnd,
    dayCount,
    label: custom.start === custom.end ? custom.start : `${custom.start} 至 ${custom.end}`,
    comparisonLabel: dayCount === 1 ? "较前一天" : `较前 ${dayCount} 天`,
  };
}

export function isBusinessDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = businessDateAsUtc(value);
  return !Number.isNaN(date.getTime()) && toBusinessDateKey(date) === value;
}

export function businessDateAsUtc(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

export function addBusinessDays(value: string, days: number): string {
  const date = businessDateAsUtc(value);
  date.setUTCDate(date.getUTCDate() + days);
  return toBusinessDateKey(date);
}

export function toBusinessDateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

export function shanghaiBusinessDate(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
