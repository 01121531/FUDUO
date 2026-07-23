"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  Laptop,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import {
  isTerminalQrStatus,
  transitionQrSession,
  type QrSession,
} from "./erp-auth-state";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";
const QR_SESSION_STORAGE_KEY = "fuduo_active_qr_session";

interface CredentialStatus {
  status: string;
  expiresAt: string | null;
  lastRefreshedAt: string | null;
  configured: boolean;
  accountName: string | null;
  shopCount: number | null;
  storage: string;
}

export function ErpAuthPanel() {
  const [status, setStatus] = useState<CredentialStatus | null>(null);
  const [qr, setQr] = useState<QrSession | null>(null);
  const [authorization, setAuthorization] = useState("");
  const [busy, setBusy] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const qrGeneration = useRef(0);
  const qrRef = useRef<QrSession | null>(null);

  function updateQr(next: QrSession | null) {
    qrRef.current = next;
    setQr(next);
  }

  useEffect(() => {
    void loadStatus();
    const sessionId = window.sessionStorage.getItem(QR_SESSION_STORAGE_KEY);
    if (sessionId) void restoreQrSession(sessionId);
  }, []);

  useEffect(() => {
    if (!qr || isTerminalQrStatus(qr.status)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [qr?.id, qr?.status]);

  useEffect(() => {
    if (!qr || isTerminalQrStatus(qr.status)) return;
    const source = new EventSource(`${API_URL}/fuduo/qr-sessions/${qr.id}/events`, { withCredentials: true });
    const applySession = (next: QrSession) => {
      const transition = transitionQrSession(qrRef.current, next);
      if (!transition.accepted) return;
      updateQr(transition.session);
      if (transition.terminalStatus) clearStoredSession(next.id);
      if (transition.terminalStatus === "SUCCESS") {
        setError(null);
        void loadStatus();
      }
      if (transition.terminalStatus === "FAILED") {
        setError(next.error ? `${next.error.message}。${next.error.recovery}` : "扫码登录失败，请重新生成二维码。");
      }
      if (transition.terminalStatus === "EXPIRED") {
        setError("二维码已失效，请重新生成。");
      }
    };
    source.addEventListener("status", (event) => {
      try {
        applySession(JSON.parse((event as MessageEvent).data) as QrSession);
      } catch {
        // Ignore malformed frames; polling remains the source of truth.
      }
    });
    const poll = window.setInterval(async () => {
      try {
        const response = await fetch(`${API_URL}/fuduo/qr-sessions/${qr.id}`, { credentials: "include" });
        if (response.status === 404 || response.status === 410) {
          if (qrRef.current?.id !== qr.id) return;
          setError("二维码会话已失效，请重新生成。");
          clearStoredSession(qr.id);
          updateQr(null);
          return;
        }
        const body = await response.json() as { data?: QrSession };
        if (response.ok && body.data) applySession(body.data);
      } catch {
        // EventSource reconnect and the next poll remain available.
      }
    }, 1_500);
    return () => {
      source.close();
      window.clearInterval(poll);
    };
  }, [qr?.id, qr?.status]);

  async function loadStatus() {
    try {
      const response = await fetch(`${API_URL}/fuduo/credential/status`, { credentials: "include", cache: "no-store" });
      if (!response.ok) throw new Error("STATUS_UNAVAILABLE");
      const body = await response.json() as { data: CredentialStatus };
      setStatus(body.data);
    } catch {
      setStatus({
        status: "UNCONFIGURED",
        expiresAt: null,
        lastRefreshedAt: null,
        configured: false,
        accountName: null,
        shopCount: null,
        storage: "API 未连接",
      });
    }
  }

  async function restoreQrSession(sessionId: string) {
    const generation = ++qrGeneration.current;
    setRecovering(true);
    try {
      const response = await fetch(`${API_URL}/fuduo/qr-sessions/${encodeURIComponent(sessionId)}`, {
        credentials: "include",
        cache: "no-store",
      });
      if (generation !== qrGeneration.current) return;
      if (response.status === 404 || response.status === 410) {
        clearStoredSession(sessionId);
        return;
      }
      if (!response.ok) throw new Error("二维码会话暂时无法恢复，请检查网络后刷新页面重试。");
      const body = await response.json() as { data?: QrSession };
      if (!body.data) throw new Error("二维码会话不存在。");
      if (body.data.status === "FAILED") {
        setError(body.data.error ? `${body.data.error.message}。${body.data.error.recovery}` : "扫码登录失败，请重新生成二维码。");
        clearStoredSession(sessionId);
        return;
      }
      if (body.data.status === "EXPIRED") {
        setError("二维码已失效，请重新生成。");
        clearStoredSession(sessionId);
        return;
      }
      if (body.data.status === "CANCELLED") {
        clearStoredSession(sessionId);
        return;
      }
      if (body.data.status === "SUCCESS") {
        clearStoredSession(sessionId);
        await loadStatus();
        return;
      }
      setNow(Date.now());
      updateQr(body.data);
    } catch (caught) {
      if (generation === qrGeneration.current) {
        setError(caught instanceof Error ? caught.message : "二维码会话暂时无法恢复。");
      }
    } finally {
      if (generation === qrGeneration.current) setRecovering(false);
    }
  }

  async function createQr() {
    ++qrGeneration.current;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/fuduo/qr-sessions`, { method: "POST", credentials: "include" });
      const body = await response.json() as { data?: QrSession; error?: { message?: string } };
      if (!response.ok || !body.data) throw new Error(body.error?.message ?? "二维码生成失败。");
      window.sessionStorage.setItem(QR_SESSION_STORAGE_KEY, body.data.id);
      setNow(Date.now());
      updateQr(body.data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "二维码生成失败。");
    } finally {
      setBusy(false);
    }
  }

  async function cancelQr() {
    if (!qr || busy) return;
    const sessionId = qr.id;
    ++qrGeneration.current;
    setBusy(true);
    try {
      const response = await fetch(`${API_URL}/fuduo/qr-sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok && response.status !== 404) throw new Error("取消扫码失败。");
      const body = response.ok ? await response.json() as { data?: QrSession } : null;
      clearStoredSession(sessionId);
      updateQr(null);
      if (body?.data?.status === "SUCCESS") {
        setError("授权已在取消操作生效前完成，当前凭证已安全保存。");
        await loadStatus();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "取消扫码失败。");
    } finally {
      setBusy(false);
    }
  }

  async function revokeCredential() {
    if (busy || !window.confirm("撤销后后台同步会立即暂停，历史数据仍可查询。确定撤销富多授权吗？")) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/fuduo/credential`, { method: "DELETE", credentials: "include" });
      const body = await response.json() as { data?: CredentialStatus; error?: { message?: string } };
      if (!response.ok || !body.data) throw new Error(body.error?.message ?? "撤销授权失败。");
      setStatus(body.data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "撤销授权失败。");
    } finally {
      setBusy(false);
    }
  }

  async function importToken() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/fuduo/credential/import`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authorization }),
      });
      const body = await response.json() as { data?: CredentialStatus; error?: { message?: string } };
      if (!response.ok || !body.data) throw new Error(body.error?.message ?? "授权同步失败。");
      setStatus(body.data);
      setAuthorization("");
      updateQr(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "授权同步失败。");
    } finally {
      setBusy(false);
    }
  }

  const remainingSeconds = qr ? Math.max(0, Math.ceil((new Date(qr.expiresAt).getTime() - now) / 1_000)) : 0;

  return (
    <div className="auth-grid">
      <section className="panel auth-primary">
        <div className="panel-header">
          <div>
            <div className="panel-title">企业微信扫码登录富多</div>
            <div className="muted" style={{ fontSize: 12 }}>主授权方式 · 云端隔离登录会话</div>
          </div>
          <span className="status info"><ShieldCheck size={13} />隔离会话</span>
        </div>
        <div className="panel-body auth-content">
          {recovering ? (
            <div className="auth-empty">
              <LoaderCircle className="spin" size={42} />
              <h2>正在恢复扫码会话</h2>
              <p>正在读取上次扫码进度，请稍候。</p>
            </div>
          ) : qr ? (
            <div className="qr-state">
              <div className="qr-frame">
                {qr.qrImage
                  ? <img src={qr.qrImage} alt="富多企业微信登录二维码" />
                  : <LoaderCircle className="spin" aria-label="正在生成二维码" size={34} />}
              </div>
              <div>
                <span className="status info" role="status" aria-live="polite">
                  <LoaderCircle className="spin" aria-hidden="true" size={13} />
                  {qr.status === "VERIFYING" ? "正在验证" : qr.status === "SCANNED" ? "已扫码" : "等待扫码"}
                </span>
                <h2>使用企业微信确认登录</h2>
                <p className="muted">二维码剩余有效时间</p>
                <div className="qr-countdown" role="timer" aria-live="polite">
                  {formatCountdown(remainingSeconds)}
                </div>
                <button className="button" type="button" onClick={() => void cancelQr()} disabled={busy}>取消扫码</button>
              </div>
            </div>
          ) : status?.status === "REAUTH_REQUIRED" ? (
            <div className="auth-empty">
              <AlertTriangle size={42} />
              <h2>富多授权需要重新登录</h2>
              <p>后台同步已暂停，历史销售、订单和退款数据仍可查询。重新扫码后系统会自动恢复同步。</p>
              <button className="button primary" onClick={() => void createQr()} disabled={busy || recovering}>
                {busy ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}重新扫码
              </button>
            </div>
          ) : status?.configured && ["ACTIVE", "REFRESHING"].includes(status.status) ? (
            <div className="auth-success">
              <CheckCircle2 size={42} />
              <h2>富多授权已连接</h2>
              <p>凭证已加密保存，云端可直接执行店铺数据请求。</p>
              <div className="auth-meta">
                <span>账号<strong>{status.accountName ?? "未返回账号名"}</strong></span>
                <span>店铺数量<strong>{status.shopCount === null ? "未知" : `${status.shopCount} 家`}</strong></span>
                <span>Token 到期<strong>{formatDateTime(status.expiresAt)}</strong></span>
                <span>最近刷新<strong>{formatDateTime(status.lastRefreshedAt)}</strong></span>
                <span>自动刷新<strong>{status.status === "REFRESHING" ? "正在刷新" : "已启用"}</strong></span>
                <span>安全存储<strong>{status.storage}</strong></span>
              </div>
              <div className="button-row">
                <button className="button" type="button" onClick={() => void createQr()} disabled={busy}>
                  <RefreshCw size={17} />重新授权
                </button>
                <button className="button danger" type="button" onClick={() => void revokeCredential()} disabled={busy}>
                  <Trash2 size={17} />撤销授权
                </button>
              </div>
            </div>
          ) : (
            <div className="auth-empty">
              <KeyRound size={42} />
              <h2>尚未连接富多 ERP</h2>
              <p>扫码后系统将验证账号和店铺权限，并加密保存 Authorization。</p>
              <button className="button primary" onClick={() => void createQr()} disabled={busy || recovering}>
                {busy ? <LoaderCircle className="spin" size={17} /> : <ShieldCheck size={17} />}生成登录二维码
              </button>
            </div>
          )}
          {error ? <div className="banner" role="alert" style={{ marginTop: 16 }}>{error}</div> : null}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <div className="panel-title">使用本地插件同步授权</div>
            <div className="muted" style={{ fontSize: 12 }}>网站扫码不可用时的次级通道</div>
          </div>
          <Laptop size={18} aria-hidden="true" />
        </div>
        <div className="panel-body">
          <p className="muted">本地捕获插件登录富多后，只将新凭证通过 HTTPS 上传到同一凭证保险库，不转发销售请求。</p>
          <details className="plugin-sync-details">
            <summary>应急手动同步</summary>
            <div className="plugin-sync-form">
              <label className="field">
                <span>Authorization</span>
                <input
                  type="password"
                  value={authorization}
                  onChange={(event) => setAuthorization(event.target.value)}
                  placeholder="Bearer eyJ..."
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby="authorization-import-help"
                />
              </label>
              <p id="authorization-import-help" className="muted" style={{ fontSize: 12 }}>
                {qr
                  ? "请先取消正在进行的扫码会话，避免两个授权结果相互覆盖。"
                  : "内容只提交给 Credential Vault，页面不会回显原文。"}
              </p>
              <button
                className="button"
                type="button"
                onClick={() => void importToken()}
                disabled={busy || recovering || Boolean(qr) || authorization.trim().length < 20}
              >
                加密同步
              </button>
            </div>
          </details>
        </div>
      </section>
    </div>
  );
}

function clearStoredSession(sessionId: string) {
  if (window.sessionStorage.getItem(QR_SESSION_STORAGE_KEY) === sessionId) {
    window.sessionStorage.removeItem(QR_SESSION_STORAGE_KEY);
  }
}

function formatCountdown(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = (seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function formatDateTime(value: string | null) {
  if (!value) return "暂无";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
