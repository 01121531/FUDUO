"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, KeyRound, LoaderCircle, Pencil, Plus, Power, PowerOff, Save, Search, UserRound, X } from "lucide-react";
import { StatusBadge } from "./status-badge";
import { Tooltip } from "./tooltip";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";
type RoleCode = "ADMIN" | "OPERATOR" | "VIEWER";

interface Member {
  id: string;
  displayName: string;
  email: string;
  roleCode: RoleCode | null;
  roles: string[];
  permissions: string[];
  shopIds: string[];
  shops: string[];
  shopScope: string;
  wechat: string | null;
  active: boolean;
  lastPairedAt: string | null;
}

interface Options {
  roles: Array<{ code: RoleCode; name: string; permissions: string[] }>;
  shops: Array<{ id: string; fuduoShopId: string; name: string; status: string }>;
}

interface MemberForm {
  displayName: string;
  email: string;
  temporaryPassword: string;
  roleCode: RoleCode;
  shopIds: string[];
  active: boolean;
}

const EMPTY_FORM: MemberForm = { displayName: "", email: "", temporaryPassword: "", roleCode: "OPERATOR", shopIds: [], active: true };

export function MembersPanel() {
  const [members, setMembers] = useState<Member[]>([]);
  const [options, setOptions] = useState<Options>({ roles: [], shops: [] });
  const [form, setForm] = useState<MemberForm>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [resetId, setResetId] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [shopSearch, setShopSearch] = useState("");
  const [busy, setBusy] = useState<string | null>("load");
  const [notice, setNotice] = useState<{ kind: "success" | "danger"; text: string } | null>(null);

  const filteredShops = useMemo(() => {
    const query = shopSearch.trim().toLocaleLowerCase("zh-CN");
    return query ? options.shops.filter((shop) => shop.name.toLocaleLowerCase("zh-CN").includes(query) || shop.fuduoShopId.includes(query)) : options.shops;
  }, [options.shops, shopSearch]);

  useEffect(() => { void load(); }, []);

  async function load() {
    try {
      const [nextMembers, nextOptions] = await Promise.all([
        apiRequest<Member[]>(`${API_URL}/settings/members`),
        apiRequest<Options>(`${API_URL}/settings/members/options`),
      ]);
      setMembers(nextMembers);
      setOptions(nextOptions);
    } catch (error) {
      setNotice({ kind: "danger", text: message(error, "员工服务当前不可用") });
    } finally {
      setBusy(null);
    }
  }

  function openCreate() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setShopSearch("");
    setResetId(null);
    setShowForm(true);
    setNotice(null);
  }

  function openEdit(member: Member) {
    setEditingId(member.id);
    setForm({ displayName: member.displayName, email: member.email, temporaryPassword: "", roleCode: member.roleCode ?? "VIEWER", shopIds: member.shopIds, active: member.active });
    setShopSearch("");
    setResetId(null);
    setShowForm(true);
    setNotice(null);
  }

  function closeForm() {
    setShowForm(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  function toggleShop(id: string) {
    setForm((current) => ({ ...current, shopIds: current.shopIds.includes(id) ? current.shopIds.filter((shopId) => shopId !== id) : [...current.shopIds, id] }));
  }

  async function saveMember() {
    setBusy(editingId ? `edit:${editingId}` : "create");
    setNotice(null);
    try {
      if (editingId) {
        await apiRequest(`${API_URL}/settings/members/${editingId}`, { method: "PATCH", body: { displayName: form.displayName, roleCode: form.roleCode, shopIds: form.roleCode === "ADMIN" ? [] : form.shopIds, active: form.active } });
      } else {
        await apiRequest(`${API_URL}/settings/members`, { method: "POST", body: { displayName: form.displayName, email: form.email, temporaryPassword: form.temporaryPassword, roleCode: form.roleCode, shopIds: form.roleCode === "ADMIN" ? [] : form.shopIds } });
      }
      setNotice({ kind: "success", text: editingId ? "员工资料和权限已更新" : "员工账号已创建" });
      closeForm();
      await load();
    } catch (error) {
      setNotice({ kind: "danger", text: message(error, "员工保存失败") });
    } finally {
      setBusy(null);
    }
  }

  async function toggleMember(member: Member) {
    if (member.active && !window.confirm(`停用 ${member.displayName} 后，该员工的登录会话会立即失效。确定继续吗？`)) return;
    setBusy(`toggle:${member.id}`);
    setNotice(null);
    try {
      await apiRequest(`${API_URL}/settings/members/${member.id}`, { method: "PATCH", body: { active: !member.active } });
      setNotice({ kind: "success", text: `${member.displayName} 已${member.active ? "停用" : "启用"}` });
      await load();
    } catch (error) {
      setNotice({ kind: "danger", text: message(error, "账号状态更新失败") });
    } finally {
      setBusy(null);
    }
  }

  async function submitPasswordReset() {
    if (!resetId || resetPassword.length < 12) return;
    setBusy(`password:${resetId}`);
    setNotice(null);
    try {
      await apiRequest(`${API_URL}/settings/members/${resetId}/reset-password`, { method: "POST", body: { temporaryPassword: resetPassword } });
      setResetId(null);
      setResetPassword("");
      setNotice({ kind: "success", text: "临时密码已更新，该员工的其他会话已撤销" });
    } catch (error) {
      setNotice({ kind: "danger", text: message(error, "密码重置失败") });
    } finally {
      setBusy(null);
    }
  }

  const saving = busy === (editingId ? `edit:${editingId}` : "create");
  const formValid = Boolean(form.displayName.trim() && (editingId || (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email) && form.temporaryPassword.length >= 12)));

  return <div className="members-layout">
    {notice ? <div className={`inline-notice ${notice.kind}`} role={notice.kind === "danger" ? "alert" : "status"}>{notice.text}</div> : null}
    <div className="members-heading"><span>{members.length} 名员工</span><button className="button primary" onClick={openCreate} disabled={busy !== null}><Plus size={17} />添加员工</button></div>

      {showForm ? <section className="panel member-form-panel"><div className="panel-header"><div><h2 className="panel-title">{editingId ? "编辑员工" : "添加员工"}</h2><p className="panel-subtitle">{editingId ? "修改角色后立即按新的店铺范围生效" : "新账号首次登录后可在账号安全页绑定 TOTP"}</p></div><Tooltip label="关闭员工表单" side="left"><button className="icon-action" aria-label="关闭员工表单" onClick={closeForm}><X size={18} /></button></Tooltip></div><div className="panel-body"><div className="form-grid"><label className="field"><span>姓名</span><input autoFocus value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} placeholder="员工姓名" /></label><label className="field"><span>角色</span><select value={form.roleCode} onChange={(event) => setForm({ ...form, roleCode: event.target.value as RoleCode, shopIds: event.target.value === "ADMIN" ? [] : form.shopIds })}>{options.roles.map((role) => <option value={role.code} key={role.code}>{role.name}</option>)}</select></label><label className="field"><span>登录邮箱</span><input type="email" autoComplete="off" value={form.email} disabled={Boolean(editingId)} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="name@company.com" /></label>{!editingId ? <label className="field"><span>临时密码</span><input type="password" autoComplete="new-password" value={form.temporaryPassword} onChange={(event) => setForm({ ...form, temporaryPassword: event.target.value })} placeholder="至少 12 个字符" /></label> : <label className="field member-active-field"><span>账号状态</span><span className="toggle-row"><input type="checkbox" checked={form.active} onChange={(event) => setForm({ ...form, active: event.target.checked })} />允许登录和微信查询</span></label>}</div>

      <div className="member-scope"><div className="member-scope-header"><div><strong>店铺范围</strong><small>{form.roleCode === "ADMIN" ? "管理员可查看全部店铺" : `已选择 ${form.shopIds.length} 家`}</small></div>{form.roleCode !== "ADMIN" ? <label className="member-shop-search"><span className="sr-only">???????</span><Search aria-hidden="true" size={16} /><input value={shopSearch} onChange={(event) => setShopSearch(event.target.value)} placeholder="搜索店铺" /></label> : null}</div>{form.roleCode === "ADMIN" ? <div className="member-all-shops"><Check size={17} />全部店铺</div> : <div className="member-shop-grid">{filteredShops.map((shop) => <label className="member-shop-option" key={shop.id}><input type="checkbox" checked={form.shopIds.includes(shop.id)} onChange={() => toggleShop(shop.id)} /><span>{shop.name}<small>{shop.fuduoShopId}</small></span>{form.shopIds.includes(shop.id) ? <Check size={16} /> : null}</label>)}{filteredShops.length === 0 ? <div className="table-empty">没有匹配的店铺</div> : null}</div>}</div>

      <div className="toolbar member-form-actions"><button className="button primary" disabled={busy !== null || !formValid} onClick={() => void saveMember()}>{saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}{editingId ? "保存修改" : "创建员工"}</button><button className="button" onClick={closeForm} disabled={busy !== null}>取消</button></div></div></section> : null}

      {resetId ? <section className="panel password-reset-panel"><div className="panel-header"><div><h2 className="panel-title">重置临时密码</h2><p className="panel-subtitle">{members.find((member) => member.id === resetId)?.displayName}</p></div><Tooltip label="关闭密码重置" side="left"><button className="icon-action" aria-label="关闭密码重置" onClick={() => { setResetId(null); setResetPassword(""); }}><X size={18} /></button></Tooltip></div><div className="panel-body password-reset-body"><label className="field"><span>新临时密码</span><input autoFocus type="password" autoComplete="new-password" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} placeholder="至少 12 个字符" /></label><button className="button primary" disabled={busy !== null || resetPassword.length < 12} onClick={() => void submitPasswordReset()}>{busy === `password:${resetId}` ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}确认重置</button></div></section> : null}

    <div className="data-table-wrap member-desktop"><table className="data-table"><thead><tr><th>员工</th><th>角色</th><th>店铺范围</th><th>微信</th><th>状态</th><th>操作</th></tr></thead><tbody>{members.map((member) => <tr key={member.id}><td><span className="member-name"><UserRound size={17} />{member.displayName}</span><small className="member-email">{member.email}</small></td><td>{member.roles.join("、") || "未分配"}</td><td>{member.shopScope}<small className="member-email">{member.shops.slice(0, 2).join("、")}</small></td><td>{member.wechat ?? "未绑定"}</td><td><StatusBadge status={member.active ? "正常" : "已停用"} /></td><td><MemberActions member={member} busy={busy} onEdit={openEdit} onReset={(id) => { setResetId(id); setShowForm(false); setResetPassword(""); }} onToggle={toggleMember} /></td></tr>)}</tbody></table></div>
    <div className="member-mobile panel">{members.map((member) => <article className="member-mobile-row" key={member.id}><div className="member-mobile-head"><span className="member-name"><UserRound size={17} />{member.displayName}</span><StatusBadge status={member.active ? "正常" : "已停用"} /></div><p>{member.email}</p><dl><div><dt>角色</dt><dd>{member.roles.join("、") || "未分配"}</dd></div><div><dt>店铺范围</dt><dd>{member.shopScope}</dd></div><div><dt>微信</dt><dd>{member.wechat ?? "未绑定"}</dd></div></dl><MemberActions member={member} busy={busy} onEdit={openEdit} onReset={(id) => { setResetId(id); setShowForm(false); setResetPassword(""); }} onToggle={toggleMember} /></article>)}</div>
  </div>;
}

function MemberActions({ member, busy, onEdit, onReset, onToggle }: { member: Member; busy: string | null; onEdit: (member: Member) => void; onReset: (id: string) => void; onToggle: (member: Member) => Promise<void> }) {
  return <div className="member-actions"><Tooltip label="编辑员工"><button className="icon-action" aria-label={`编辑 ${member.displayName}`} disabled={busy !== null} onClick={() => onEdit(member)}><Pencil size={16} /></button></Tooltip><Tooltip label="重置临时密码"><button className="icon-action" aria-label={`重置 ${member.displayName} 密码`} disabled={busy !== null} onClick={() => onReset(member.id)}><KeyRound size={16} /></button></Tooltip><Tooltip label={member.active ? "停用账号" : "启用账号"} side="left"><button className={`icon-action ${member.active ? "danger-action" : ""}`} aria-label={`${member.active ? "停用" : "启用"} ${member.displayName}`} disabled={busy !== null} onClick={() => void onToggle(member)}>{busy === `toggle:${member.id}` ? <LoaderCircle className="spin" size={16} /> : member.active ? <PowerOff size={16} /> : <Power size={16} />}</button></Tooltip></div>;
}

function message(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }

async function apiRequest<T = unknown>(url: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const init: RequestInit = { method: options.method ?? "GET", credentials: "include" };
  if (options.body !== undefined) { init.headers = { "Content-Type": "application/json" }; init.body = JSON.stringify(options.body); }
  const response = await fetch(url, init);
  const payload = await response.json() as { success: boolean; data?: T; error?: { message?: string } };
  if (!response.ok || !payload.success || payload.data === undefined) throw new Error(payload.error?.message ?? `请求失败（${response.status}）`);
  return payload.data;
}
