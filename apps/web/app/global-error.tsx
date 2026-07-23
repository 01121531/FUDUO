"use client";

import { ErrorState } from "@/components/error-state";
import "./globals.css";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="zh-CN">
      <body>
        <main className="login-page">
          <div className="login-form global-error-frame">
            <ErrorState
              title="系统暂时不可用"
              impact="工作区未能完成加载，当前所有页面和操作暂时不可用。"
              {...(error.digest ? { traceId: error.digest } : {})}
              reset={reset}
            />
          </div>
        </main>
      </body>
    </html>
  );
}
