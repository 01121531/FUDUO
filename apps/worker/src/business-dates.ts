export function shanghaiBusinessDate(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function recentBusinessDates(days: number, now = new Date()): string[] {
  if (!Number.isInteger(days) || days < 1) throw new Error("BUSINESS_DATE_RANGE_INVALID");

  const current = shanghaiBusinessDate(now);
  const start = new Date(`${current}T00:00:00.000Z`);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() - index);
    return date.toISOString().slice(0, 10);
  });
}
