"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, CloudDownload, Copy, ExternalLink, LoaderCircle, RefreshCw } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

interface UpdateStatus {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseName: string;
  releaseUrl: string;
  publishedAt: string | null;
  deployment: Record<"docker" | "source" | "windowsDocker" | "windowsSource", string>;
}

export function UpdatePanel() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => { void check(false); }, []);

  async function check(refresh: boolean) {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/system/update${refresh ? "?refresh=true" : ""}`, { credentials: "include", cache: "no-store" });
      const text = await response.text();
      let body: { success?: boolean; data?: UpdateStatus; error?: { message?: string } } = {};
      try { body = text ? JSON.parse(text) : {}; } catch { throw new Error(`服务器返回了无效响应（${response.status}）`); }
      if (!response.ok || !body.success || !body.data) throw new Error(body.error?.message ?? `检查失败（${response.status}）`);
      setStatus(body.data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "更新检查失败");
    } finally {
      setLoading(false);
    }
  }

  async function copy(name: string, command: string) {
    await navigator.clipboard.writeText(command);
    setCopied(name);
    window.setTimeout(() => setCopied(null), 1_500);
  }

  return (
    <div className="update-panel">
      {error ? <div className="notice danger" role="alert">{error}</div> : null}
      <section className="panel update-status-panel">
        <header className="panel-header">
          <div><h2>版本状态</h2><p>{status?.releaseName ?? "GitHub Releases"}</p></div>
          <button className="button" type="button" disabled={loading} onClick={() => void check(true)}>
            {loading ? <LoaderCircle className="spin" aria-hidden="true" size={16} /> : <RefreshCw aria-hidden="true" size={16} />}检查更新
          </button>
        </header>
        {status ? (
          <div className="update-version-grid">
            <div><span>当前版本</span><strong>{status.currentVersion}</strong></div>
            <div><span>最新版本</span><strong>{status.latestVersion}</strong></div>
            <div><span>发布时间</span><strong>{status.publishedAt ? new Date(status.publishedAt).toLocaleString("zh-CN") : "—"}</strong></div>
            <div className={status.updateAvailable ? "update-available" : "update-current"}>
              {status.updateAvailable ? <CloudDownload aria-hidden="true" size={18} /> : <CheckCircle2 aria-hidden="true" size={18} />}
              <strong>{status.updateAvailable ? "发现新版本" : "已是最新版本"}</strong>
            </div>
          </div>
        ) : null}
        {status ? <a className="button" href={status.releaseUrl} target="_blank" rel="noreferrer">查看 Release<ExternalLink aria-hidden="true" size={15} /></a> : null}
      </section>

      {status ? (
        <section className="panel update-command-panel">
          <header className="panel-header"><div><h2>更新命令</h2><p>在部署主机的项目目录执行</p></div></header>
          <div className="update-command-list">
            <UpdateCommand label="Linux / Docker" value={status.deployment.docker} copied={copied === "docker"} onCopy={() => void copy("docker", status.deployment.docker)} />
            <UpdateCommand label="Linux / 源码" value={status.deployment.source} copied={copied === "source"} onCopy={() => void copy("source", status.deployment.source)} />
            <UpdateCommand label="Windows / Docker" value={status.deployment.windowsDocker} copied={copied === "windowsDocker"} onCopy={() => void copy("windowsDocker", status.deployment.windowsDocker)} />
            <UpdateCommand label="Windows / 源码" value={status.deployment.windowsSource} copied={copied === "windowsSource"} onCopy={() => void copy("windowsSource", status.deployment.windowsSource)} />
          </div>
        </section>
      ) : null}
    </div>
  );
}

function UpdateCommand({ label, value, copied, onCopy }: { label: string; value: string; copied: boolean; onCopy: () => void }) {
  return <div className="update-command"><span>{label}</span><code>{value}</code><button className="button icon-button" type="button" onClick={onCopy} aria-label={`复制${label}更新命令`}><Copy aria-hidden="true" size={15} />{copied ? <span className="sr-only">已复制</span> : null}</button></div>;
}
