"use client";

import { useEffect, useMemo, useState } from "react";
import { Bot, Check, Code2, LoaderCircle, PackageCheck, RefreshCw, ShieldAlert, X } from "lucide-react";
import { StatusBadge } from "./status-badge";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";
type ExtensionKind = "SKILL" | "MCP";

interface ExtensionFile { path: string; content: string }
interface ExtensionDraft {
  id: string;
  kind: ExtensionKind;
  name: string;
  slug: string;
  description: string;
  status: string;
  version: number;
  manifest: {
    entrypoint?: string;
    tools?: Array<{ name: string; description: string }>;
    permissions?: { networkHosts?: string[]; environment?: string[]; filesystem?: string[] };
  };
  files: ExtensionFile[];
  validation: { errors: string[]; warnings: string[] };
  installedAt: string | null;
  createdAt: string;
}

type Notice = { kind: "success" | "danger"; text: string };

export function ExtensionWorkbench() {
  const [drafts, setDrafts] = useState<ExtensionDraft[]>([]);
  const [kind, setKind] = useState<ExtensionKind>("SKILL");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<string | null>("load");
  const [notice, setNotice] = useState<Notice | null>(null);
  const counts = useMemo(() => ({
    total: drafts.length,
    ready: drafts.filter((item) => item.validation.errors.length === 0 && item.status !== "INSTALLED").length,
    installed: drafts.filter((item) => item.status === "INSTALLED").length,
  }), [drafts]);

  useEffect(() => { void load(); }, []);

  async function load() {
    setBusy((value) => value ?? "load");
    try {
      setDrafts(await apiRequest<ExtensionDraft[]>(`${API_URL}/extensions`));
    } catch (error) {
      setNotice({ kind: "danger", text: errorMessage(error, "扩展列表加载失败") });
    } finally {
      setBusy(null);
    }
  }

  async function createDraft() {
    if (prompt.trim().length < 4) return;
    setBusy("create");
    setNotice(null);
    try {
      const created = await apiRequest<ExtensionDraft>(`${API_URL}/extensions`, { method: "POST", body: { kind, prompt: prompt.trim() } });
      setDrafts((current) => [created, ...current]);
      setPrompt("");
      setNotice({ kind: "success", text: `${created.name} 草案已生成，等待复核` });
    } catch (error) {
      setNotice({ kind: "danger", text: errorMessage(error, "草案生成失败") });
    } finally {
      setBusy(null);
    }
  }

  async function review(id: string, action: "install" | "reject") {
    setBusy(`${action}:${id}`);
    setNotice(null);
    try {
      const updated = await apiRequest<ExtensionDraft>(`${API_URL}/extensions/${id}/${action}`, { method: "POST" });
      setDrafts((current) => current.map((item) => item.id === id ? updated : item));
      setNotice({ kind: "success", text: action === "install" ? "扩展已安装" : "草案已拒绝" });
    } catch (error) {
      setNotice({ kind: "danger", text: errorMessage(error, action === "install" ? "安装失败" : "拒绝失败") });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="extension-workbench">
      {notice ? <div className={`notice ${notice.kind}`} role="status">{notice.text}</div> : null}

      <section className="panel extension-composer" aria-labelledby="extension-composer-title">
        <header className="panel-header">
          <div><h2 id="extension-composer-title">创建扩展草案</h2><p>描述目标、输入、输出和限制，AI 会生成文件包与权限清单。</p></div>
          <button className="button icon-button" type="button" onClick={() => void load()} disabled={Boolean(busy)} aria-label="刷新扩展列表">
            <RefreshCw aria-hidden="true" size={17} />
          </button>
        </header>
        <div className="extension-kind-control" role="group" aria-label="扩展类型">
          <button type="button" className={kind === "SKILL" ? "active" : ""} aria-pressed={kind === "SKILL"} onClick={() => setKind("SKILL")}><Bot aria-hidden="true" size={16} />Skill</button>
          <button type="button" className={kind === "MCP" ? "active" : ""} aria-pressed={kind === "MCP"} onClick={() => setKind("MCP")}><Code2 aria-hidden="true" size={16} />MCP</button>
        </div>
        <textarea
          value={prompt}
          maxLength={4_000}
          rows={5}
          placeholder={kind === "SKILL" ? "例如：创建一个每周复盘技能，先汇总销售，再列出异常店铺和待办。" : "例如：创建一个 MCP 工具，接收订单号并返回标准化的查询结果。"}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <div className="extension-composer-footer">
          <span>{prompt.length}/4000</span>
          <button className="button primary" type="button" disabled={Boolean(busy) || prompt.trim().length < 4} onClick={() => void createDraft()}>
            {busy === "create" ? <LoaderCircle className="spin" aria-hidden="true" size={17} /> : <Bot aria-hidden="true" size={17} />}
            生成草案
          </button>
        </div>
      </section>

      <div className="extension-summary" aria-label="扩展统计">
        <span>全部 <strong>{counts.total}</strong></span>
        <span>可安装 <strong>{counts.ready}</strong></span>
        <span>已安装 <strong>{counts.installed}</strong></span>
      </div>

      <section className="extension-list" aria-label="扩展草案列表">
        {!drafts.length && !busy ? <div className="empty-state"><PackageCheck aria-hidden="true" size={28} /><strong>暂无扩展草案</strong></div> : null}
        {drafts.map((draft) => (
          <details className="panel extension-item" key={draft.id}>
            <summary>
              <span className={`extension-kind ${draft.kind.toLowerCase()}`}>{draft.kind}</span>
              <span className="extension-item-title"><strong>{draft.name}</strong><small>{draft.slug}@{draft.version}</small></span>
              <StatusBadge status={draft.status} />
              <span className="extension-validation">
                {draft.validation.errors.length ? <><ShieldAlert aria-hidden="true" size={15} />{draft.validation.errors.length} 错误</> : <><Check aria-hidden="true" size={15} />校验通过</>}
              </span>
            </summary>
            <div className="extension-detail">
              <p>{draft.description}</p>
              <div className="extension-permissions">
                <strong>权限清单</strong>
                <span>网络：{draft.manifest.permissions?.networkHosts?.join("、") || "无"}</span>
                <span>环境变量：{draft.manifest.permissions?.environment?.join("、") || "无"}</span>
                <span>文件系统：{draft.manifest.permissions?.filesystem?.join("、") || "无"}</span>
              </div>
              {draft.validation.errors.length || draft.validation.warnings.length ? (
                <div className="extension-findings">
                  {draft.validation.errors.map((item) => <code key={item}>错误：{item}</code>)}
                  {draft.validation.warnings.map((item) => <code key={item}>复核：{item}</code>)}
                </div>
              ) : null}
              <div className="extension-files">
                {draft.files.map((file) => <details key={file.path}><summary>{file.path}</summary><pre>{file.content}</pre></details>)}
              </div>
              {draft.status !== "INSTALLED" && draft.status !== "REJECTED" ? (
                <div className="extension-actions">
                  <button className="button" type="button" disabled={Boolean(busy)} onClick={() => void review(draft.id, "reject")}><X aria-hidden="true" size={16} />拒绝</button>
                  <button className="button primary" type="button" disabled={Boolean(busy) || draft.validation.errors.length > 0} onClick={() => void review(draft.id, "install")}>
                    {busy === `install:${draft.id}` ? <LoaderCircle className="spin" aria-hidden="true" size={16} /> : <PackageCheck aria-hidden="true" size={16} />}确认安装
                  </button>
                </div>
              ) : null}
            </div>
          </details>
        ))}
      </section>
    </div>
  );
}

async function apiRequest<T>(url: string, options?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(url, {
    method: options?.method ?? "GET",
    credentials: "include",
    cache: "no-store",
    ...(options?.body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  let payload: { success?: boolean; data?: T; error?: { message?: string } } = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { throw new Error(`服务器返回了无效响应（${response.status}）`); }
  if (!response.ok || !payload.success || payload.data === undefined) throw new Error(payload.error?.message ?? `请求失败（${response.status}）`);
  return payload.data;
}

function errorMessage(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
