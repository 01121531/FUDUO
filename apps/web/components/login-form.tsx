"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, LoaderCircle, LockKeyhole } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

interface LoginErrors {
  form?: string;
  email?: string;
  password?: string;
  code?: string;
}

export function LoginForm({ returnTo = "/dashboard" }: { returnTo?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<LoginErrors>({});

  async function submit() {
    setBusy(true);
    setErrors({});
    try {
      const response = await fetch(challengeId ? `${API_URL}/auth/totp/verify` : `${API_URL}/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(challengeId ? { challengeId, code } : { email, password }),
      });
      const body = await response.json() as {
        success: boolean;
        data?: { requiresTotp?: boolean; challengeId?: string; nextAction?: string };
        error?: { code?: string; message?: string; fieldErrors?: Partial<Record<keyof LoginErrors, string>> };
      };
      if (!response.ok || !body.success || !body.data) {
        const next = classifyLoginError(response.status, body.error);
        setErrors(next);
        return;
      }
      if (body.data.requiresTotp && body.data.challengeId) {
        setChallengeId(body.data.challengeId);
        setPassword("");
        return;
      }
      const destination = safeReturnTo(returnTo);
      router.replace(body.data.nextAction === "CHANGE_PASSWORD" || body.data.nextAction === "TOTP_ENROLL"
        ? `/account-setup?returnTo=${encodeURIComponent(destination)}`
        : destination);
      router.refresh();
    } catch {
      setErrors({ form: "登录服务暂时不可用，请检查网络后重试。" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="login-form">
      <div className="brand-block" style={{ border: 0, padding: 0, marginBottom: 28 }}><span className="brand-mark">FD</span><span>富多店铺智能助手</span></div>
      <div>
        <h1 className="page-title">{challengeId ? "二次验证" : "登录内部工作区"}</h1>
        <p className="page-description">{challengeId ? "输入身份验证器中的 6 位动态码" : "使用公司分配的账号继续"}</p>
      </div>
      <form style={{ marginTop: 24 }} aria-busy={busy} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        {challengeId ? (
          <label className="field">
            <span>动态验证码</span>
            <input
              value={code}
              onChange={(event) => { setCode(event.target.value.replace(/\D/g, "").slice(0, 6)); setErrors((current) => omitLoginError(current, "code")); }}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              pattern="[0-9]{6}"
              required
              aria-invalid={Boolean(errors.code)}
              aria-describedby={errors.code ? "login-code-error" : undefined}
              autoFocus
            />
            {errors.code ? <span id="login-code-error" className="field-error">{errors.code}</span> : null}
          </label>
        ) : (
          <>
            <label className="field">
              <span>账号</span>
              <input value={email} onChange={(event) => { setEmail(event.target.value); setErrors((current) => omitLoginError(current, "email")); }} type="email" autoComplete="username" placeholder="name@company.com" required aria-invalid={Boolean(errors.email)} aria-describedby={errors.email ? "login-email-error" : undefined} />
              {errors.email ? <span id="login-email-error" className="field-error">{errors.email}</span> : null}
            </label>
            <label className="field">
              <span>密码</span>
              <input value={password} onChange={(event) => { setPassword(event.target.value); setErrors((current) => omitLoginError(current, "password")); }} type="password" autoComplete="current-password" placeholder="输入密码" required minLength={8} aria-invalid={Boolean(errors.password)} aria-describedby={errors.password ? "login-password-error" : undefined} />
              {errors.password ? <span id="login-password-error" className="field-error">{errors.password}</span> : null}
            </label>
          </>
        )}
        {errors.form ? <div className="banner" role="alert" style={{ marginBottom: 14 }}>{errors.form}</div> : null}
        <button className="button primary" style={{ width: "100%", marginTop: 8 }} type="submit" disabled={busy || (challengeId ? code.length !== 6 : !email || password.length < 8)}>
          {busy ? <LoaderCircle className="spin" aria-hidden="true" size={17} /> : challengeId ? <KeyRound aria-hidden="true" size={17} /> : <LockKeyhole aria-hidden="true" size={17} />}
          {busy ? "正在验证…" : challengeId ? "验证并登录" : "登录"}
        </button>
      </form>
      <p className="muted" style={{ marginTop: 20, fontSize: 12 }}>仅限公司内部员工使用</p>
    </section>
  );
}

function classifyLoginError(
  status: number,
  error?: { code?: string; message?: string; fieldErrors?: Partial<Record<keyof LoginErrors, string>> },
): LoginErrors {
  if (error?.fieldErrors && Object.keys(error.fieldErrors).length) return error.fieldErrors;
  if (status >= 500) return { form: error?.message ?? "登录服务暂时不可用，请稍后重试。" };
  if (error?.code === "AUTH_TOTP_INVALID" || error?.code === "AUTH_TOTP_REQUIRED") return { code: error.message ?? "动态验证码无效。" };
  if (error?.code === "AUTH_INVALID_CREDENTIALS" || status === 401) return { password: "账号或密码不正确。" };
  if (status === 400 || status === 422) return { email: error?.message ?? "账号格式不正确。" };
  return { form: error?.message ?? "登录失败，请重试。" };
}

function safeReturnTo(value: string) {
  return value.startsWith("/") && !value.startsWith("//") ? value : "/dashboard";
}

function omitLoginError(errors: LoginErrors, field: keyof LoginErrors): LoginErrors {
  const next = { ...errors };
  delete next[field];
  return next;
}
