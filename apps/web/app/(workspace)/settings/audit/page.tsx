import { AuditWorkspace, type AuditEvent, type AuditFilters } from "@/components/audit-workspace";
import { apiGet } from "@/lib/api";

interface PageProps {
  searchParams: Promise<Partial<Record<keyof AuditFilters, string>>>;
}

export default async function AuditPage({ searchParams }: PageProps) {
  const raw = await searchParams;
  const filters: AuditFilters = {
    search: scalar(raw.search),
    channel: scalar(raw.channel),
    result: scalar(raw.result),
    user: scalar(raw.user),
    tool: scalar(raw.tool),
    shop: scalar(raw.shop),
    start: scalar(raw.start),
    end: scalar(raw.end),
  };
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) query.set(key, value);
  }
  const events = await apiGet<AuditEvent[]>(`/settings/audit?${query.toString()}`);
  return <AuditWorkspace events={events} filters={filters} />;
}

function scalar(value: string | undefined) {
  return typeof value === "string" ? value.slice(0, 100) : "";
}
