import { notFound } from "next/navigation";
import { ReportDetailView, type ReportDetail } from "@/components/report-detail-view";
import { apiGet } from "@/lib/api";

export default async function ReportDetailPage({ params }: { params: Promise<{ reportId: string }> }) {
  const { reportId } = await params;
  const report = await apiGet<ReportDetail>(`/reports/${encodeURIComponent(reportId)}`).catch(() => null);
  if (!report) notFound();
  return <ReportDetailView report={report} />;
}
