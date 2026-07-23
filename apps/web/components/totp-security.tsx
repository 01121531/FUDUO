"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Check, Copy, KeyRound, LoaderCircle, RotateCw, ShieldCheck, ShieldEllipsis, X } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import { Tooltip } from "@/components/tooltip";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

interface SecurityStatus { totpEnabled: boolean; activeSessions: number; demo: boolean }
interface Enrollment { enrollmentId: string; secret: string; otpauthUri: string; expiresAt: string }
interface ApiEnvelope<T> { success: boolean; data?: T; error?: { message?: string } }

export function TotpSecurity({ onCompleted }: { onCompleted?: () => void } = {}) {
  const [status, setStatus] = useState<SecurityStatus | null>(null);
  const [password, setPassword] = useState("");
  const [currentCode, setCurrentCode] = useState("");
  const [newCode, setNewCode] = useState("");
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ type: "success" | "danger"; text: string } | null>(null);

  useEffect(() => {
    void fetch(`${API_URL}/auth/security`, { credentials: "include", cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as ApiEnvelope<SecurityStatus>;
        if (!response.ok || !body.success || !body.data) throw new Error(body.error?.message ?? "无法读取账号安全状态");
        setStatus(body.data);
      })
      .catch((error) => setNotice({ type: "danger", text: message(error, "无法读取账号安全状态") }));
  }, []);

  if (!status) return <div className="security-layout">{notice ? <div className="inline-notice danger" role="alert">{notice.text}</div> : null}<section className="panel security-loading" role="status" aria-live="polite"><LoaderCircle className="spin" aria-hidden="true" size={24} /><span>正在读取账号安全状态</span></section></div>;

  async function begin() {
    if (!status) return;
    setBusy(true);
    setNotice(null);
    try {
      const created = await request<Enrollment>("/auth/totp/setup", "POST", { currentPassword: password, ...(status.totpEnabled ? { currentCode } : {}) });
      const image = await QRCode.toDataURL(created.otpauthUri, { width: 240, margin: 1, errorCorrectionLevel: "M", color: { dark: "#142019", light: "#ffffff" } });
      setEnrollment(created);
      setQrDataUrl(image);
      setPassword("");
      setCurrentCode("");
      setNewCode("");
    } catch (error) {
      setNotice({ type: "danger", text: message(error, "无法创建 TOTP 绑定") });
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!enrollment) return;
    setBusy(true);
    setNotice(null);
    try {
      await request("/auth/totp/confirm", "POST", { enrollmentId: enrollment.enrollmentId, code: newCode });
      setEnrollment(null);
      setQrDataUrl(null);
      setNewCode("");
      setStatus((current) => current ? { ...current, totpEnabled: true, activeSessions: 1 } : { totpEnabled: true, activeSessions: 1, demo: false });
      setNotice({ type: "success", text: "TOTP 已启用，其他登录会话已撤销" });
      onCompleted?.();
    } catch (error) {
      setNotice({ type: "danger", text: message(error, "动态验证码确认失败") });
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!enrollment) return;
    setBusy(true);
    try {
      await request(`/auth/totp/setup/${enrollment.enrollmentId}`, "DELETE");
      setEnrollment(null);
      setQrDataUrl(null);
      setNewCode("");
      setNotice(null);
    } catch (error) {
      setNotice({ type: "danger", text: message(error, "取消绑定失败") });
    } finally {
      setBusy(false);
    }
  }

  async function copySecret() {
    if (!enrollment) return;
    try {
      await navigator.clipboard.writeText(enrollment.secret);
      setNotice({ type: "success", text: "手动密钥已复制" });
    } catch {
      setNotice({ type: "danger", text: "浏览器未允许访问剪贴板" });
    }
  }

  return <div className="security-layout">
    {notice ? <div className={`inline-notice ${notice.type}`} role={notice.type === "danger" ? "alert" : "status"}>{notice.text}</div> : null}
    <section className="panel">
      <div className="panel-header"><div><div className="panel-title">二次验证</div><div className="muted" style={{ fontSize: 12 }}>TOTP 身份验证器</div></div><StatusBadge status={status.totpEnabled ? "已启用" : "未启用"} /></div>
      <div className="panel-body">
        <div className="security-summary">
          <span className={status.totpEnabled ? "enabled" : "pending"}>{status.totpEnabled ? <ShieldCheck size={24} /> : <ShieldEllipsis size={24} />}</span>
          <div><strong>{status.totpEnabled ? "账号已受二次验证保护" : "账号尚未启用二次验证"}</strong><small>活动会话 {status.activeSessions} 个</small></div>
        </div>
      </div>
    </section>

    <section className="panel security-primary">
      <div className="panel-header"><span className="panel-title">{enrollment ? "绑定身份验证器" : status.totpEnabled ? "轮换身份验证器" : "启用身份验证器"}</span>{enrollment ? <span className="status warning">10 分钟有效</span> : <KeyRound size={18} />}</div>
      <div className="panel-body">
        {enrollment ? <div className="totp-setup-grid">
          <div className="totp-qr">{qrDataUrl ? <img src={qrDataUrl} alt="TOTP 二维码" width={240} height={240} /> : <LoaderCircle className="spin" size={28} />}</div>
          <div>
        <label className="field"><span>手动密钥</span><span className="secret-value"><code>{groupSecret(enrollment.secret)}</code><Tooltip label="复制手动密钥" side="left"><button className="button icon-button" type="button" onClick={() => void copySecret()} aria-label="复制手动密钥"><Copy size={16} /></button></Tooltip></span></label>
            <label className="field"><span>新动态验证码</span><input value={newCode} onChange={(event) => setNewCode(digits(event.target.value))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" pattern="[0-9]{6}" required /></label>
            <div className="toolbar"><button className="button primary" onClick={() => void confirm()} disabled={busy || newCode.length !== 6}>{busy ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}确认启用</button><button className="button" onClick={() => void cancel()} disabled={busy}><X size={17} />取消</button></div>
          </div>
        </div> : <div className="security-form">
          <label className="field"><span>当前密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required minLength={8} /></label>
          {status.totpEnabled ? <label className="field"><span>当前动态验证码</span><input value={currentCode} onChange={(event) => setCurrentCode(digits(event.target.value))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" pattern="[0-9]{6}" required /></label> : null}
          <button className="button primary" onClick={() => void begin()} disabled={busy || password.length < 8 || (status.totpEnabled && currentCode.length !== 6)}>{busy ? <LoaderCircle className="spin" size={17} /> : status.totpEnabled ? <RotateCw size={17} /> : <ShieldCheck size={17} />}{status.totpEnabled ? "验证并轮换" : "开始绑定"}</button>
        </div>}
      </div>
    </section>
  </div>;
}

async function request<T = unknown>(path: string, method: "POST" | "DELETE", body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "include" };
  if (body !== undefined) { init.headers = { "Content-Type": "application/json" }; init.body = JSON.stringify(body); }
  const response = await fetch(`${API_URL}${path}`, init);
  const payload = await response.json() as ApiEnvelope<T>;
  if (!response.ok || !payload.success || payload.data === undefined) throw new Error(payload.error?.message ?? `请求失败（${response.status}）`);
  return payload.data;
}

function digits(value: string) { return value.replace(/\D/g, "").slice(0, 6); }
function groupSecret(value: string) { return value.match(/.{1,4}/g)?.join(" ") ?? value; }
function message(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
