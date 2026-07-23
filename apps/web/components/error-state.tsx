"use client";

import { AlertTriangle, RotateCw } from "lucide-react";

export function ErrorState({
  title,
  impact,
  traceId,
  reset,
}: {
  title: string;
  impact: string;
  traceId?: string;
  reset: () => void;
}) {
  return (
    <section className="panel empty-state error-state" role="alert">
      <AlertTriangle size={30} />
      <h1 className="section-title">{title}</h1>
      <p className="muted">{impact}</p>
      <p className="muted">可以重新加载当前页面；如果问题持续，请将追踪 ID 提供给管理员。</p>
      {traceId ? <div className="error-trace"><span>追踪 ID</span><code>{traceId}</code></div> : null}
      <button className="button primary" type="button" onClick={reset}><RotateCw size={17} />重新加载</button>
    </section>
  );
}
