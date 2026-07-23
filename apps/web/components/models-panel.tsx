"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlaskConical, KeyRound, LoaderCircle, Pencil, Plus, Power, PowerOff, RefreshCw, Save, Sparkles, X } from "lucide-react";
import { StatusBadge } from "./status-badge";
import { Tooltip } from "./tooltip";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";
const PROFILE_KEYS = ["default_chat_model", "analysis_model", "fallback_model"] as const;
type ProfileKey = typeof PROFILE_KEYS[number];

interface Provider {
  id: string;
  name: string;
  type: "openai-compatible" | "anthropic";
  baseUrl: string;
  defaultModel: string | null;
  active: boolean;
  configured: boolean;
  status: string;
  profiles: string[];
  lastTestedAt: string | null;
  requestCount: number;
  failureCount: number;
  failureRate: number | null;
  lastUsedAt: string | null;
}

interface ModelProfile {
  key: ProfileKey;
  providerId: string | null;
  model: string | null;
  active: boolean;
}

interface ProviderForm {
  name: string;
  type: Provider["type"];
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
}

interface Assignment { providerId: string; model: string }
type Notice = { kind: "success" | "danger"; text: string };

const EMPTY_FORM: ProviderForm = { name: "", type: "openai-compatible", baseUrl: "", apiKey: "", defaultModel: "" };
const profileLabels: Record<ProfileKey, { name: string; description: string }> = {
  default_chat_model: { name: "默认对话", description: "处理日常店铺查询和结果整理" },
  analysis_model: { name: "复杂分析", description: "处理排名、对比和多步骤经营分析" },
  fallback_model: { name: "备用模型", description: "主模型超时或限流时最多降级一次" },
};

export function ModelsPanel() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [assignments, setAssignments] = useState<Record<ProfileKey, Assignment>>(emptyAssignments());
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, string[]>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<ProviderForm>(EMPTY_FORM);
  const [busy, setBusy] = useState<string | null>("load");
  const [notice, setNotice] = useState<Notice | null>(null);
  const drawerTriggerRef = useRef<HTMLElement | null>(null);

  const activeProviders = useMemo(() => providers.filter((provider) => provider.active && provider.configured), [providers]);

  useEffect(() => { void load(); }, []);

  async function load() {
    setBusy((value) => value ?? "load");
    try {
      const [nextProviders, nextProfiles] = await Promise.all([
        apiRequest<Provider[]>(`${API_URL}/model-providers`),
        apiRequest<ModelProfile[]>(`${API_URL}/model-providers/profiles`),
      ]);
      setProviders(nextProviders);
      const nextAssignments = emptyAssignments();
      for (const profile of nextProfiles) nextAssignments[profile.key] = { providerId: profile.providerId ?? "", model: profile.model ?? "" };
      setAssignments(nextAssignments);
    } catch (error) {
      setNotice({ kind: "danger", text: errorMessage(error, "模型服务当前不可用") });
    } finally {
      setBusy(null);
    }
  }

  function openCreate() {
    drawerTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditingId(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
    setNotice(null);
  }

  function openEdit(provider: Provider) {
    drawerTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditingId(provider.id);
    setForm({ name: provider.name, type: provider.type, baseUrl: provider.baseUrl, apiKey: "", defaultModel: provider.defaultModel ?? "" });
    setShowForm(true);
    setNotice(null);
  }

  const closeForm = useCallback(() => {
    setShowForm(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
    window.setTimeout(() => drawerTriggerRef.current?.focus(), 0);
  }, []);

  async function submitProvider() {
    const action = editingId ? `update:${editingId}` : "create";
    setBusy(action);
    setNotice(null);
    try {
      if (editingId) {
        const body: Partial<ProviderForm> = { name: form.name, type: form.type, baseUrl: form.baseUrl, defaultModel: form.defaultModel };
        if (form.apiKey.trim()) body.apiKey = form.apiKey;
        await apiRequest(`${API_URL}/model-providers/${editingId}`, { method: "PATCH", body });
      } else {
        await apiRequest(`${API_URL}/model-providers`, { method: "POST", body: form });
      }
      setNotice({ kind: "success", text: editingId ? "供应商配置已更新" : "供应商已保存，API Key 已加密" });
      closeForm();
      await load();
    } catch (error) {
      setNotice({ kind: "danger", text: errorMessage(error, "保存失败") });
    } finally {
      setBusy(null);
    }
  }

  async function testProvider(provider: Provider) {
    setBusy(`test:${provider.id}`);
    setNotice(null);
    try {
      const result = await apiRequest<{ success: boolean; message: string; latencyMs: number }>(`${API_URL}/model-providers/${provider.id}/test`, { method: "POST" });
      setNotice({ kind: result.success ? "success" : "danger", text: `${provider.name}：${result.message}，耗时 ${result.latencyMs}ms` });
      await load();
    } catch (error) {
      setNotice({ kind: "danger", text: errorMessage(error, "连接测试失败") });
    } finally {
      setBusy(null);
    }
  }

  async function discoverModels(provider: Provider) {
    setBusy(`models:${provider.id}`);
    setNotice(null);
    try {
      const result = await apiRequest<{ models: string[] }>(`${API_URL}/model-providers/${provider.id}/models`);
      setModelsByProvider((current) => ({ ...current, [provider.id]: result.models }));
      setNotice({ kind: "success", text: `${provider.name} 已发现 ${result.models.length} 个可用模型` });
    } catch (error) {
      setNotice({ kind: "danger", text: errorMessage(error, "无法获取模型列表") });
    } finally {
      setBusy(null);
    }
  }

  async function toggleProvider(provider: Provider) {
    if (provider.active && !window.confirm(`停用 ${provider.name} 后，关联的模型角色也会停用。确定继续吗？`)) return;
    setBusy(`toggle:${provider.id}`);
    setNotice(null);
    try {
      if (provider.active) await apiRequest(`${API_URL}/model-providers/${provider.id}`, { method: "DELETE" });
      else await apiRequest(`${API_URL}/model-providers/${provider.id}`, { method: "PATCH", body: { active: true } });
      setNotice({ kind: "success", text: `${provider.name} 已${provider.active ? "停用" : "启用"}` });
      await load();
    } catch (error) {
      setNotice({ kind: "danger", text: errorMessage(error, "状态更新失败") });
    } finally {
      setBusy(null);
    }
  }

  async function saveProfile(key: ProfileKey) {
    const assignment = assignments[key];
    if (!assignment.providerId || !assignment.model.trim()) {
      setNotice({ kind: "danger", text: `请为${profileLabels[key].name}选择供应商并填写模型` });
      return;
    }
    setBusy(`profile:${key}`);
    setNotice(null);
    try {
      await apiRequest(`${API_URL}/model-providers/profiles/${key}`, { method: "PATCH", body: assignment });
      setNotice({ kind: "success", text: `${profileLabels[key].name}已更新` });
      await load();
    } catch (error) {
      setNotice({ kind: "danger", text: errorMessage(error, "模型角色更新失败") });
    } finally {
      setBusy(null);
    }
  }

  function selectProfileProvider(key: ProfileKey, providerId: string) {
    const provider = providers.find((item) => item.id === providerId);
    setAssignments((current) => ({ ...current, [key]: { providerId, model: provider?.defaultModel ?? "" } }));
  }

  const formValid = Boolean(form.name.trim() && form.baseUrl.trim() && form.defaultModel.trim() && (editingId || form.apiKey.trim().length >= 8));

  return (
    <div className="models-layout">
      {notice ? <div className={`inline-notice ${notice.kind}`} role={notice.kind === "danger" ? "alert" : "status"}>{notice.text}</div> : null}

      <section className="panel">
        <div className="panel-header"><div><h2 className="panel-title">模型角色</h2><p className="panel-subtitle">模型切换不会改变经营数据与只读工具</p></div></div>
        <div className="model-profile-list">
          {PROFILE_KEYS.map((key) => {
            const assignment = assignments[key];
            const provider = providers.find((item) => item.id === assignment.providerId);
            const availableModels = assignment.providerId ? modelsByProvider[assignment.providerId] ?? [] : [];
            return <div className="model-profile-row" key={key}>
              <div className="model-profile-copy"><strong>{profileLabels[key].name}</strong><small>{profileLabels[key].description}</small></div>
              <label><span className="sr-only">{profileLabels[key].name}供应商</span><select value={assignment.providerId} disabled={busy !== null} onChange={(event) => selectProfileProvider(key, event.target.value)}><option value="">选择供应商</option>{activeProviders.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
              <label><span className="sr-only">{profileLabels[key].name}模型</span><input list={`models-${key}`} value={assignment.model} disabled={busy !== null || !assignment.providerId} onChange={(event) => setAssignments((current) => ({ ...current, [key]: { ...current[key], model: event.target.value } }))} placeholder="输入模型名称" /><datalist id={`models-${key}`}>{availableModels.map((model) => <option value={model} key={model} />)}</datalist></label>
              <div className="model-profile-actions">
                {provider ? <Tooltip label="从供应商刷新模型列表"><button className="icon-action" aria-label={`刷新 ${provider.name} 模型列表`} disabled={busy !== null} onClick={() => void discoverModels(provider)}>{busy === `models:${provider.id}` ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}</button></Tooltip> : null}
                <button className="button primary" disabled={busy !== null || !assignment.providerId || !assignment.model.trim()} onClick={() => void saveProfile(key)}>{busy === `profile:${key}` ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}保存</button>
              </div>
            </div>;
          })}
        </div>
      </section>

      <section className="models-provider-section">
        <div className="section-heading"><div><h2>供应商</h2><p>API Key 保存后不会再次回显</p></div><button className="button primary" onClick={openCreate} disabled={busy !== null}><Plus size={17} />添加供应商</button></div>

        {showForm ? <ProviderDrawer
          editing={Boolean(editingId)}
          form={form}
          busy={busy}
          formValid={formValid}
          onChange={setForm}
          onClose={closeForm}
          onSubmit={submitProvider}
        /> : null}

        <div className="data-table-wrap model-provider-desktop"><table className="data-table"><thead><tr><th>供应商</th><th>默认模型</th><th>角色</th><th>调用情况</th><th>连接状态</th><th>操作</th></tr></thead><tbody>{providers.map((provider) => <tr key={provider.id}><td><span className="provider-name"><Sparkles size={17} />{provider.name}</span><small className="provider-url">{provider.baseUrl}</small></td><td>{provider.defaultModel ?? "—"}</td><td>{provider.profiles.length ? provider.profiles.map(profileName).join("、") : "未分配"}</td><td><span className="provider-metric">{provider.requestCount} 次</span><small className="provider-url">失败率 {formatRate(provider.failureRate)}</small></td><td><StatusBadge status={provider.status} /><small className="provider-url">{provider.lastTestedAt ? formatDateTime(provider.lastTestedAt) : "尚未测试"}</small></td><td><ProviderActions provider={provider} busy={busy} onEdit={openEdit} onTest={testProvider} onDiscover={discoverModels} onToggle={toggleProvider} /></td></tr>)}</tbody></table>{providers.length === 0 ? <EmptyProviders /> : null}</div>

        <div className="model-provider-mobile panel">{providers.map((provider) => <article className="model-provider-mobile-row" key={provider.id}><div className="model-provider-mobile-head"><span className="provider-name"><Sparkles size={17} />{provider.name}</span><StatusBadge status={provider.status} /></div><p>{provider.baseUrl}</p><dl><div><dt>默认模型</dt><dd>{provider.defaultModel ?? "—"}</dd></div><div><dt>模型角色</dt><dd>{provider.profiles.length ? provider.profiles.map(profileName).join("、") : "未分配"}</dd></div><div><dt>调用情况</dt><dd>{provider.requestCount} 次 / 失败率 {formatRate(provider.failureRate)}</dd></div><div><dt>最近测试</dt><dd>{provider.lastTestedAt ? formatDateTime(provider.lastTestedAt) : "尚未测试"}</dd></div></dl><ProviderActions provider={provider} busy={busy} onEdit={openEdit} onTest={testProvider} onDiscover={discoverModels} onToggle={toggleProvider} /></article>)}{providers.length === 0 ? <EmptyProviders /> : null}</div>
      </section>
    </div>
  );
}

function ProviderDrawer({ editing, form, busy, formValid, onChange, onClose, onSubmit }: {
  editing: boolean;
  form: ProviderForm;
  busy: string | null;
  formValid: boolean;
  onChange: (form: ProviderForm) => void;
  onClose: () => void;
  onSubmit: () => Promise<void>;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    firstFieldRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const controls = [...dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.offsetParent !== null);
      if (!controls.length) return;
      const first = controls[0]!;
      const last = controls.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const title = editing ? "编辑供应商" : "添加供应商";
  const saving = busy === (editing ? "update" : "create") || busy?.startsWith("update:") === true;

  return (
    <div className="drawer-backdrop model-drawer-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <aside
        ref={dialogRef}
        className="report-drawer model-provider-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-provider-drawer-title"
        aria-describedby="model-provider-drawer-description"
      >
        <div className="drawer-header">
          <div>
            <h2 id="model-provider-drawer-title">{title}</h2>
            <p id="model-provider-drawer-description">仅允许 HTTPS 和服务器白名单中的公网域名</p>
          </div>
          <Tooltip label={`关闭${title}`} side="left"><button type="button" className="icon-action" aria-label={`关闭${title}`} onClick={onClose}><X size={18} /></button></Tooltip>
        </div>
        <form className="drawer-body model-drawer-form" onSubmit={(event) => {
          event.preventDefault();
          void onSubmit();
        }}>
          <div className="form-grid">
            <label className="field"><span>名称</span><input ref={firstFieldRef} value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} placeholder="DeepSeek" /></label>
            <label className="field"><span>接口类型</span><select value={form.type} onChange={(event) => onChange({ ...form, type: event.target.value as Provider["type"] })}><option value="openai-compatible">OpenAI-compatible</option><option value="anthropic">Anthropic</option></select></label>
            <label className="field"><span>Base URL</span><input type="url" value={form.baseUrl} onChange={(event) => onChange({ ...form, baseUrl: event.target.value })} placeholder="https://api.deepseek.com" /></label>
            <label className="field"><span>默认模型</span><input value={form.defaultModel} onChange={(event) => onChange({ ...form, defaultModel: event.target.value })} placeholder="deepseek-chat" /></label>
            <label className="field model-key-field"><span>{editing ? "更换 API Key（选填）" : "API Key"}</span><div className="input-with-icon"><KeyRound size={16} /><input type="password" autoComplete="new-password" value={form.apiKey} onChange={(event) => onChange({ ...form, apiKey: event.target.value })} placeholder={editing ? "留空则保持现有密钥" : "保存后不会再次回显"} /></div></label>
          </div>
          <div className="drawer-actions">
            <button type="button" className="button" onClick={onClose} disabled={busy !== null}>取消</button>
            <button className="button primary" disabled={busy !== null || !formValid}>{saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}{editing ? "保存修改" : "保存供应商"}</button>
          </div>
        </form>
      </aside>
    </div>
  );
}

function ProviderActions({ provider, busy, onEdit, onTest, onDiscover, onToggle }: {
  provider: Provider;
  busy: string | null;
  onEdit: (provider: Provider) => void;
  onTest: (provider: Provider) => Promise<void>;
  onDiscover: (provider: Provider) => Promise<void>;
  onToggle: (provider: Provider) => Promise<void>;
}) {
  return <div className="provider-actions"><Tooltip label="编辑配置或轮换 API Key"><button className="icon-action" aria-label={`编辑 ${provider.name}`} disabled={busy !== null} onClick={() => onEdit(provider)}><Pencil size={16} /></button></Tooltip><Tooltip label="测试连接"><button className="icon-action" aria-label={`测试 ${provider.name}`} disabled={busy !== null || !provider.active || !provider.configured} onClick={() => void onTest(provider)}>{busy === `test:${provider.id}` ? <LoaderCircle className="spin" size={16} /> : <FlaskConical size={16} />}</button></Tooltip><Tooltip label="获取模型列表"><button className="icon-action" aria-label={`获取 ${provider.name} 模型列表`} disabled={busy !== null || !provider.active || !provider.configured} onClick={() => void onDiscover(provider)}>{busy === `models:${provider.id}` ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}</button></Tooltip><Tooltip label={provider.active ? "停用供应商" : "启用供应商"} side="left"><button className={`icon-action ${provider.active ? "danger-action" : ""}`} aria-label={`${provider.active ? "停用" : "启用"} ${provider.name}`} disabled={busy !== null} onClick={() => void onToggle(provider)}>{busy === `toggle:${provider.id}` ? <LoaderCircle className="spin" size={16} /> : provider.active ? <PowerOff size={16} /> : <Power size={16} />}</button></Tooltip></div>;
}

function EmptyProviders() {
  return <div className="auth-empty compact-empty"><Sparkles size={26} /><strong>尚未配置模型供应商</strong><span>添加供应商后再配置三个模型角色</span></div>;
}

function emptyAssignments(): Record<ProfileKey, Assignment> {
  return { default_chat_model: { providerId: "", model: "" }, analysis_model: { providerId: "", model: "" }, fallback_model: { providerId: "", model: "" } };
}

function profileName(value: string) {
  return value in profileLabels ? profileLabels[value as ProfileKey].name : value;
}

function formatRate(value: number | null) {
  return value === null ? "—" : new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 }).format(value);
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

async function apiRequest<T = unknown>(url: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const init: RequestInit = {
    method: options.method ?? "GET",
    credentials: "include",
  };
  if (options.body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(url, init);
  const payload = await response.json() as { success: boolean; data?: T; error?: { message?: string } };
  if (!response.ok || !payload.success || payload.data === undefined) throw new Error(payload.error?.message ?? `请求失败（${response.status}）`);
  return payload.data;
}
