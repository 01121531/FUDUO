import { AlertTriangle, CheckCircle2, Clock3, HelpCircle, Info, LoaderCircle } from "lucide-react";

export function StatusBadge({ status }: { status: string }) {
  const normalized = status.toUpperCase();
  const label = STATUS_LABELS[normalized] ?? status;
  if (["正常", "SUCCEEDED", "ACTIVE", "LIVE", "PAIRED", "INSTALLED", "VALIDATED", "已推送"].includes(normalized) || ["正常", "已推送"].includes(status)) {
    return <span className="status success"><CheckCircle2 size={13} />{label}</span>;
  }
  if (["RUNNING", "QUEUED", "REFRESHING", "SENDING", "RETRY_WAIT"].includes(normalized) || status === "推送中") {
    return <span className="status info"><LoaderCircle className="spin" size={13} />{label}</span>;
  }
  if (["FAILED", "REAUTH_REQUIRED", "REJECTED"].includes(normalized) || ["失败", "推送失败"].includes(status)) {
    return <span className="status danger"><AlertTriangle size={13} />{label}</span>;
  }
  if (["PARTIAL", "STALE", "PENDING", "UNBOUND", "NEEDS_REVIEW", "DRAFT"].includes(normalized) || ["待重新登录", "待测试"].includes(status)) {
    return <span className="status warning"><Clock3 size={13} />{label}</span>;
  }
  if (normalized === "UNKNOWN") {
    return <span className="status neutral"><HelpCircle size={13} />{label}</span>;
  }
  return <span className="status neutral"><Info size={13} />{label}</span>;
}

const STATUS_LABELS: Record<string, string> = {
  SUCCEEDED: "成功",
  RUNNING: "同步中",
  QUEUED: "排队中",
  RETRY_WAIT: "等待重试",
  PARTIAL: "部分成功",
  FAILED: "失败",
  REAUTH_REQUIRED: "待重新授权",
  REFRESHING: "刷新中",
  ACTIVE: "正常",
  LIVE: "实时",
  RECENT: "最近同步",
  STALE: "数据过期",
  UNKNOWN: "未知/从未同步",
  CANCELLED: "已取消",
  REVOKED: "已撤销",
  PAIRED: "已配对",
  PENDING: "待审批",
  UNBOUND: "未绑定员工",
  NEEDS_REVIEW: "需核对",
  DRAFT: "草案",
  VALIDATED: "校验通过",
  INSTALLED: "已安装",
  REJECTED: "已拒绝",
};
