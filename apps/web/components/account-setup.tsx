"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, LoaderCircle, LockKeyhole } from "lucide-react";
import { TotpSecurity } from "./totp-security";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";
type NextAction = "CHANGE_PASSWORD" | "TOTP_ENROLL" | "NONE";

export function AccountSetup({ returnTo = "/dashboard" }: { returnTo?: string | undefined }) {
  const router = useRouter();
  const [action, setAction] = useState<NextAction | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetch(`${API_URL}/auth/me`, { credentials: "include", cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { success: boolean; data?: { nextAction?: NextAction } };
        if (!response.ok || !body.success || !body.data?.nextAction) throw new Error("无法读取账号状态");
        if (body.data.nextAction === "NONE") { router.replace(safeReturnTo(returnTo)); return; }
        setAction(body.data.nextAction);
      })
      .catch(() => router.replace("/login"));
  }, [returnTo, router]);

  async function changePassword() {
    setBusy(true);
    setError(null);
    try {
      if (newPassword !== confirmation) throw new Error("两次输入的新密码不一致");
      const response = await fetch(`${API_URL}/auth/password/change`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const body = await response.json() as { success: boolean; data?: { nextAction?: NextAction }; error?: { message?: string } };
      if (!response.ok || !body.success || !body.data?.nextAction) throw new Error(body.error?.message ?? "密码修改失败");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      if (body.data.nextAction === "NONE") { router.replace(safeReturnTo(returnTo)); router.refresh(); return; }
      setAction(body.data.nextAction);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "密码修改失败");
    } finally {
      setBusy(false);
    }
  }

  if (!action) return <div className="security-loading"><LoaderCircle className="spin" size={20} />正在读取账号状态</div>;
  if (action === "TOTP_ENROLL") return <TotpSecurity onCompleted={() => { router.replace(safeReturnTo(returnTo)); router.refresh(); }} />;

  return <section className="panel account-password-panel">
    <div className="panel-header"><div><div className="panel-title">设置新密码</div><div className="panel-subtitle">首次登录需要更换临时密码</div></div><LockKeyhole size={18} /></div>
    <form className="panel-body security-form" aria-busy={busy} onSubmit={(event) => { event.preventDefault(); void changePassword(); }}>
      <label className="field"><span>当前临时密码</span><input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required minLength={8} aria-invalid={Boolean(error)} aria-describedby={error ? "account-password-error" : undefined} /></label>
      <label className="field"><span>新密码</span><input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required minLength={12} aria-describedby={`new-password-help${error ? " account-password-error" : ""}`} aria-invalid={Boolean(error)} /><small id="new-password-help" className="field-help">至少 12 个字符</small></label>
      <label className="field"><span>确认新密码</span><input type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required minLength={12} aria-invalid={Boolean(confirmation && confirmation !== newPassword) || Boolean(error)} aria-describedby={error ? "account-password-error" : undefined} /></label>
      {error ? <div id="account-password-error" className="inline-notice danger" role="alert">{error}</div> : null}
      <button className="button primary" type="submit" disabled={busy || currentPassword.length < 8 || newPassword.length < 12 || confirmation.length < 12}>{busy ? <LoaderCircle className="spin" aria-hidden="true" size={17} /> : <KeyRound aria-hidden="true" size={17} />}{busy ? "正在修改…" : "确认修改"}</button>
    </form>
  </section>;
}

function safeReturnTo(value: string) {
  return value.startsWith("/") && !value.startsWith("//") ? value : "/dashboard";
}
