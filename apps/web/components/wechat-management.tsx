"use client";

import { useEffect, useState } from "react";
import { LoaderCircle, MessageCircle, PlugZap, QrCode, RefreshCw, ShieldCheck, UserMinus, UserRound, UserRoundCheck, X } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import { encodeWechatQr } from "@/components/wechat-qr";

export interface WechatMember {
  id: string;
  displayName: string;
  email: string;
  active: boolean;
}

export interface WechatSettings {
  gatewayStatus: "CONFIGURED" | "NOT_CONFIGURED";
  managementStatus: "CONNECTED" | "UNAVAILABLE" | "NOT_CONFIGURED";
  plugin: string;
  channel: string;
  directMessages: boolean;
  groupChats: boolean;
  pending: Array<{
    id: string;
    code: string;
    createdAt: string;
    lastSeenAt: string;
    meta: Record<string, string>;
    wechatNickname: string | null;
    pairingStatus: "PENDING";
  }>;
  approvedUnbound: Array<{
    externalUserId: string;
    wechatNickname: null;
    pairingStatus: "UNBOUND";
  }>;
  pairings: Array<{
    id: string;
    wechatNickname: string | null;
    internalUser: { id: string; displayName: string; email: string };
    externalUserId: string;
    pairingStatus: "PAIRED" | "NEEDS_REVIEW" | "UNKNOWN";
    pairedAt: string;
  }>;
  login: WechatLoginState | null;
}

interface WechatLoginState {
  sessionId: string | null;
  status: "IDLE" | "STARTING" | "PENDING" | "SCANNED" | "VERIFY_CODE_REQUIRED" | "COMMITTING" | "SUCCESS" | "FAILED" | "EXPIRED" | "CANCELLED";
  qrDataUrl: string | null;
  accountId: string | null;
  accounts: string[];
  expiresAt: string | null;
  message: string;
}

interface Props { initialSettings: WechatSettings; members: WechatMember[] }
interface ApiEnvelope<T> { success: boolean; data?: T; error?: { message?: string } }
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";
const POLLED_LOGIN_STATES = new Set<WechatLoginState["status"]>(["STARTING", "PENDING", "SCANNED", "VERIFY_CODE_REQUIRED", "COMMITTING"]);

export function WechatManagement({ initialSettings, members }: Props) {
  const [settings, setSettings] = useState(initialSettings);
  const [selectedUsers, setSelectedUsers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: "success" | "danger"; text: string } | null>(null);
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [verificationCode, setVerificationCode] = useState("");
  const configured = settings.gatewayStatus === "CONFIGURED";

  useEffect(() => {
    const content = settings.login?.qrDataUrl;
    if (!content) {
      setQrImage(null);
      return;
    }
    let disposed = false;
    void encodeWechatQr(content).then((image) => { if (!disposed) setQrImage(image); }).catch(() => {
      if (!disposed) setNotice({ type: "danger", text: "二维码生成失败，请重新登录" });
    });
    return () => { disposed = true; };
  }, [settings.login?.qrDataUrl]);

  useEffect(() => {
    const status = settings.login?.status;
    if (!status || !POLLED_LOGIN_STATES.has(status)) return;
    let disposed = false;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    let consecutiveFailures = 0;
    const poll = async () => {
      controller = new AbortController();
      try {
        const login = await refreshLogin(controller.signal);
        consecutiveFailures = 0;
        if (!disposed) setSettings((current) => ({ ...current, login }));
      } catch (error) {
        if (controller.signal.aborted) return;
        consecutiveFailures += 1;
        if (!disposed && consecutiveFailures >= 3) {
          setNotice({ type: "danger", text: error instanceof Error ? error.message : "微信登录状态刷新失败" });
        }
      } finally {
        if (!disposed) timer = window.setTimeout(() => { void poll(); }, 1_500);
      }
    };
    timer = window.setTimeout(() => { void poll(); }, 1_000);
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
    };
  }, [settings.login?.status]);

  async function refreshLogin(signal?: AbortSignal) {
    const response = await fetch(`${API_URL}/settings/wechat/login/status`, { credentials: "include", cache: "no-store", ...(signal ? { signal } : {}) });
    const body = await response.json() as ApiEnvelope<WechatLoginState>;
    if (!response.ok || !body.success || !body.data) throw new Error(body.error?.message ?? "微信登录状态刷新失败");
    return body.data;
  }

  async function refresh() {
    const response = await fetch(`${API_URL}/settings/wechat`, { credentials: "include", cache: "no-store" });
    const body = await response.json() as ApiEnvelope<WechatSettings>;
    if (!response.ok || !body.success || !body.data) throw new Error(body.error?.message ?? "微信状态刷新失败");
    setSettings(body.data);
  }

  async function approve(code: string) {
    const userId = selectedUsers[code] ?? members[0]?.id;
    if (!userId) return setNotice({ type: "danger", text: "没有可绑定的启用员工" });
    setBusy(`approve:${code}`);
    setNotice(null);
    try {
      await post("/settings/wechat/pairings/approve", { code, userId });
      await refresh();
      setNotice({ type: "success", text: "配对已批准并绑定员工" });
    } catch (error) {
      setNotice({ type: "danger", text: error instanceof Error ? error.message : "配对批准失败" });
    } finally {
      setBusy(null);
    }
  }

  async function revoke(externalUserId: string) {
    setBusy(`revoke:${externalUserId}`);
    setNotice(null);
    try {
      await post("/settings/wechat/pairings/revoke", { externalUserId });
      await refresh();
      setConfirmRevoke(null);
      setNotice({ type: "success", text: "微信访问权限已撤销" });
    } catch (error) {
      setNotice({ type: "danger", text: error instanceof Error ? error.message : "撤销失败" });
    } finally {
      setBusy(null);
    }
  }

  async function startLogin() {
    setBusy("login");
    setNotice(null);
    try {
      const accountId = settings.login?.accountId ?? settings.login?.accounts[0];
      const login = await post<WechatLoginState>("/settings/wechat/login/start", accountId ? { accountId } : {});
      setSettings((current) => ({ ...current, login }));
    } catch (error) {
      setNotice({ type: "danger", text: error instanceof Error ? error.message : "微信登录启动失败" });
    } finally {
      setBusy(null);
    }
  }

  async function submitVerificationCode() {
    setBusy("login-verify");
    setNotice(null);
    try {
      const login = await post<WechatLoginState>("/settings/wechat/login/verify", { code: verificationCode.trim() });
      setSettings((current) => ({ ...current, login }));
      setVerificationCode("");
    } catch (error) {
      setNotice({ type: "danger", text: error instanceof Error ? error.message : "验证码提交失败" });
    } finally {
      setBusy(null);
    }
  }

  async function cancelLogin() {
    setBusy("login-cancel");
    try {
      const login = await post<WechatLoginState>("/settings/wechat/login/cancel", {});
      setSettings((current) => ({ ...current, login }));
    } catch (error) {
      setNotice({ type: "danger", text: error instanceof Error ? error.message : "取消登录失败" });
    } finally {
      setBusy(null);
    }
  }

  async function post<T = unknown>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${API_URL}${path}`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json() as ApiEnvelope<unknown>;
    if (!response.ok || !payload.success || payload.data === undefined) throw new Error(payload.error?.message ?? `请求失败（${response.status}）`);
    return payload.data as T;
  }

  return (
    <div className="page">
      <div className="page-header"><div><h1 className="page-title">微信接入</h1><p className="page-description">OpenClaw 微信私聊、员工配对和访问控制</p></div></div>
      {notice ? <div className={`inline-notice ${notice.type}`}>{notice.text}</div> : null}
      {settings.managementStatus === "UNAVAILABLE" ? <div className="banner"><MessageCircle size={18} /><span>OpenClaw 管理服务暂不可用，配对操作已暂停。</span></div> : null}
      {settings.approvedUnbound.length > 0 ? <div className="banner"><ShieldCheck size={18} /><span>发现 {settings.approvedUnbound.length} 个未绑定内部员工的微信授权，请在下方撤销后重新配对。</span></div> : null}
      <div className="two-column">
        <section className="panel">
          <div className="panel-header"><div><div className="panel-title">OpenClaw Gateway</div><div className="muted" style={{ fontSize: 12 }}>{settings.plugin}</div></div><StatusBadge status={settings.managementStatus === "CONNECTED" ? "已连接" : configured ? "已配置" : "未配置"} /></div>
          <div className="panel-body"><div className="auth-empty wechat-login-panel" style={{ minHeight: 260 }}>
            {settings.login?.qrDataUrl && ["PENDING", "SCANNED", "VERIFY_CODE_REQUIRED"].includes(settings.login.status) ? <>
              {qrImage ? <img className="wechat-login-qr" src={qrImage} alt="微信账号登录二维码" width={220} height={220} /> : <div className="wechat-login-qr" style={{ width: 220, height: 220, display: "grid", placeItems: "center" }}><LoaderCircle className="spin" size={28} /></div>}
              <h2>{settings.login.status === "PENDING" ? "使用微信扫码并确认" : settings.login.status === "SCANNED" ? "已扫码，等待手机确认" : "输入手机验证码"}</h2>
              <p>{settings.login.message}{settings.login.expiresAt ? `，二维码有效至 ${new Date(settings.login.expiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : ""}</p>
              {settings.login.status === "VERIFY_CODE_REQUIRED" ? <div className="pairing-actions">
                <input className="input" inputMode="numeric" autoComplete="one-time-code" aria-label="微信数字验证码" placeholder="手机显示的数字" value={verificationCode} onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, "").slice(0, 8))} />
                <button className="button primary" onClick={() => void submitVerificationCode()} disabled={busy !== null || verificationCode.length < 4}>{busy === "login-verify" ? <LoaderCircle className="spin" size={17} /> : <ShieldCheck size={17} />}提交</button>
              </div> : null}
              <button className="button" onClick={() => void cancelLogin()} disabled={busy !== null}>{busy === "login-cancel" ? <LoaderCircle className="spin" size={17} /> : <X size={17} />}取消登录</button>
            </> : <>
              {settings.login?.status === "STARTING" || settings.login?.status === "COMMITTING" ? <LoaderCircle className="spin" size={42} /> : settings.login?.status === "SUCCESS" ? <ShieldCheck size={42} /> : configured ? <PlugZap size={42} /> : <MessageCircle size={42} />}
              <h2>{settings.login?.status === "STARTING" ? "正在生成二维码" : settings.login?.status === "COMMITTING" ? "正在保存微信账号" : settings.login?.status === "SUCCESS" ? "微信账号已登录" : configured ? "Gateway 已接入" : "尚未接入 Gateway"}</h2>
              <p>{settings.login?.message ?? (configured ? "登录公司微信账号后，员工可以通过私聊查询经营数据。" : "部署 OpenClaw Gateway 后，可连接公司微信账号。")}</p>
              {settings.login?.accounts.length ? <span className="status success"><span className="status-dot" />已连接 {settings.login.accounts.length} 个账号</span> : <span className={`status ${configured ? "info" : "neutral"}`}><span className="status-dot" />{configured ? settings.channel : "等待配置"}</span>}
              {settings.managementStatus === "CONNECTED" ? <button className="button primary" onClick={() => void startLogin()} disabled={busy !== null}>{busy === "login" ? <LoaderCircle className="spin" size={17} /> : settings.login?.status === "SUCCESS" ? <RefreshCw size={17} /> : <QrCode size={17} />}{settings.login?.status === "SUCCESS" ? "重新登录" : "生成登录二维码"}</button> : null}
            </>}
          </div></div>
        </section>
        <section className="panel">
          <div className="panel-header"><span className="panel-title">访问策略</span><ShieldCheck size={18} /></div>
          <div className="panel-body"><div className="list-stack">
            <div className="setting-row"><span><strong>消息类型</strong><small>当前渠道允许的会话范围</small></span><span className="status success">{settings.directMessages && !settings.groupChats ? "仅私聊" : "已自定义"}</span></div>
            <div className="setting-row"><span><strong>新用户访问</strong><small>首次发送消息需要管理员批准</small></span><span className="status info">Pairing</span></div>
            <div className="setting-row"><span><strong>会话隔离</strong><small>按账号、渠道和发送者隔离</small></span><code>per-account-channel-peer</code></div>
          </div></div>
        </section>
      </div>

      <section className="section">
        <div className="section-header"><h2 className="section-title">待审批</h2><span className="muted">{settings.pending.length} 项</span></div>
        <div className="panel"><div className="panel-body">
          {settings.pending.length === 0 ? <div className="auth-empty compact-empty"><UserRoundCheck size={28} /><strong>暂无待审批请求</strong></div> : (
            <div className="list-stack">{settings.pending.map((request) => (
              <div className="pairing-row" key={`${request.id}:${request.code}`}>
                <span>
                  <strong>{request.wechatNickname ?? "微信昵称未提供"}</strong>
                  <StatusBadge status={request.pairingStatus} />
                  <small>微信 ID：{request.id}</small>
                  <small>配对码 {request.code} · {new Date(request.createdAt).toLocaleString("zh-CN", { hour12: false })}</small>
                </span>
                <select aria-label="选择绑定员工" value={selectedUsers[request.code] ?? members[0]?.id ?? ""} onChange={(event) => setSelectedUsers((current) => ({ ...current, [request.code]: event.target.value }))}>{members.map((member) => <option value={member.id} key={member.id}>{member.displayName} · {member.email}</option>)}</select>
                <button className="button primary" onClick={() => void approve(request.code)} disabled={busy !== null || members.length === 0}><UserRoundCheck size={16} />{busy === `approve:${request.code}` ? "正在批准" : "批准"}</button>
              </div>
            ))}</div>
          )}
        </div></div>
      </section>

      {settings.approvedUnbound.length > 0 ? <section className="section">
        <div className="section-header"><h2 className="section-title">异常授权</h2><span className="muted">{settings.approvedUnbound.length} 项</span></div>
        <div className="panel"><div className="panel-body"><div className="list-stack">{settings.approvedUnbound.map((pairing) => (
          <div className="pairing-row" key={pairing.externalUserId}>
            <span><strong style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><ShieldCheck size={16} />{pairing.wechatNickname ?? "微信昵称未提供"}</strong><small>微信 ID：{pairing.externalUserId}</small></span>
            <span>
              <StatusBadge status={pairing.pairingStatus} />
              <small>OpenClaw 已授权，但尚未绑定内部用户</small>
            </span>
            <div className="pairing-actions">{confirmRevoke === pairing.externalUserId ? <><button className="button danger-button" onClick={() => void revoke(pairing.externalUserId)} disabled={busy !== null}>{busy === `revoke:${pairing.externalUserId}` ? "正在撤销" : "确认撤销"}</button><button className="button" onClick={() => setConfirmRevoke(null)} disabled={busy !== null}>取消</button></> : <button className="button" onClick={() => setConfirmRevoke(pairing.externalUserId)} disabled={busy !== null}><UserMinus size={16} />撤销授权</button>}</div>
          </div>
        ))}</div></div></div>
      </section> : null}

      <section className="section">
        <div className="section-header"><h2 className="section-title">已配对员工</h2><span className="muted">{settings.pairings.length} 人</span></div>
        <div className="panel"><div className="panel-body">
          {settings.pairings.length === 0 ? <div className="auth-empty compact-empty"><ShieldCheck size={28} /><strong>暂无配对记录</strong></div> : (
            <div className="list-stack">{settings.pairings.map((pairing) => (
              <div className="pairing-row" key={pairing.id}>
                <span>
                  <strong style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><UserRound size={16} />{pairing.wechatNickname ?? "微信昵称未提供"}</strong>
                  <small>微信 ID：{pairing.externalUserId}</small>
                  <small>内部用户：{pairing.internalUser.displayName} · {pairing.internalUser.email}</small>
                </span>
                <span>
                  <StatusBadge status={pairing.pairingStatus === "UNKNOWN" ? "待确认" : pairing.pairingStatus} />
                  <small>首次配对：{new Date(pairing.pairedAt).toLocaleString("zh-CN", { hour12: false })}</small>
                  <small>{pairing.pairingStatus === "PAIRED" ? "允许名单与内部绑定一致" : pairing.pairingStatus === "NEEDS_REVIEW" ? "OpenClaw 允许名单未确认此用户" : "管理服务不可用，暂无法核对"}</small>
                </span>
                <div className="pairing-actions">{confirmRevoke === pairing.externalUserId ? <><button className="button danger-button" onClick={() => void revoke(pairing.externalUserId)} disabled={busy !== null}>{busy === `revoke:${pairing.externalUserId}` ? "正在撤销" : "确认撤销"}</button><button className="button" onClick={() => setConfirmRevoke(null)} disabled={busy !== null}>取消</button></> : <button className="button" onClick={() => setConfirmRevoke(pairing.externalUserId)} disabled={busy !== null}><UserMinus size={16} />撤销</button>}</div>
              </div>
            ))}</div>
          )}
        </div></div>
      </section>
    </div>
  );
}
