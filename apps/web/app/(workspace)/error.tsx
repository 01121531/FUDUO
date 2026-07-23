"use client";

import { ErrorState } from "@/components/error-state";

export default function WorkspaceError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="page">
      <ErrorState
        title="页面暂时无法加载"
        impact="本次请求没有完成，当前页面的数据和操作暂时不可用，其他页面不受影响。"
        {...(error.digest ? { traceId: error.digest } : {})}
        reset={reset}
      />
    </main>
  );
}
