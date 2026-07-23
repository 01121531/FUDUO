"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Bell,
  Bot,
  Building2,
  ChevronDown,
  FileText,
  History,
  KeyRound,
  LogOut,
  MessageCircle,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import { StatusBadge } from "./status-badge";
import { Tooltip } from "./tooltip";

interface NavItem {
  href: string;
  label: string;
  mobileLabel?: string;
  icon: LucideIcon;
}

const primary: NavItem[] = [
  { href: "/dashboard", label: "经营概览", mobileLabel: "概览", icon: BarChart3 },
  { href: "/shops", label: "店铺", icon: Building2 },
  { href: "/reports", label: "报表", icon: FileText },
  { href: "/chat", label: "对话助手", mobileLabel: "对话", icon: Bot },
  { href: "/sync", label: "同步中心", mobileLabel: "同步", icon: RefreshCw },
];

const settings: NavItem[] = [
  { href: "/settings/erp", label: "富多授权", icon: KeyRound },
  { href: "/settings/models", label: "模型管理", icon: Sparkles },
  { href: "/settings/wechat", label: "微信接入", icon: MessageCircle },
  { href: "/settings/members", label: "员工与权限", icon: Users },
  { href: "/settings/security", label: "账号安全", icon: ShieldCheck },
  { href: "/settings/audit", label: "审计日志", icon: History },
];

function NavLink({ item, pathname, collapsed = false }: { item: NavItem; pathname: string; collapsed?: boolean }) {
  const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
  const Icon = item.icon;
  const link = (
    <Link className={`nav-link${active ? " active" : ""}`} href={item.href} aria-current={active ? "page" : undefined}>
      <Icon aria-hidden="true" size={18} strokeWidth={1.8} />
      <span>{item.label}</span>
    </Link>
  );
  return collapsed ? <Tooltip label={item.label} side="right" className="nav-tooltip">{link}</Tooltip> : link;
}

export function AppShell({
  children,
  demo,
  user,
  globalState,
}: {
  children: React.ReactNode;
  demo: boolean;
  user: { displayName: string; permissions: string[] } | null;
  globalState: { freshness: string; notificationCount: number };
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [moreOpen, setMoreOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const moreDialogRef = useRef<HTMLElement>(null);
  const moreCloseRef = useRef<HTMLButtonElement>(null);
  const hasPermission = (permission: string) => Boolean(user?.permissions.includes("*") || user?.permissions.includes(permission));
  const canManage = Boolean(user?.permissions.includes("*"));
  const visiblePrimary = primary.filter((item) => {
    if (item.href === "/reports") return hasPermission("reports:read");
    if (item.href === "/chat") return hasPermission("chat:use");
    if (item.href === "/sync") return hasPermission("sync:run");
    return hasPermission("data:read");
  });
  const visibleSettings = settings.filter((item) => canManage || item.href === "/settings/security");
  const current = [...visiblePrimary, ...visibleSettings].find(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
  );

  useEffect(() => setMoreOpen(false), [pathname]);
  useEffect(() => {
    setSidebarCollapsed(window.localStorage.getItem("fuduo-sidebar-collapsed") === "true");
    setHydrated(true);
  }, []);
  useEffect(() => {
    if (!moreOpen) return;
    const dialog = moreDialogRef.current;
    const previousOverflow = document.body.style.overflow;
    const inertTargets = [
      document.querySelector<HTMLElement>(".workspace"),
      document.querySelector<HTMLElement>(".sidebar"),
      document.querySelector<HTMLElement>(".mobile-nav"),
    ].filter((target): target is HTMLElement => Boolean(target));
    document.body.style.overflow = "hidden";
    inertTargets.forEach((target) => target.setAttribute("inert", ""));
    moreCloseRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMore();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const controls = [...dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.offsetParent !== null);
      if (!controls.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
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
      inertTargets.forEach((target) => target.removeAttribute("inert"));
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [moreOpen]);

  function closeMore() {
    setMoreOpen(false);
    window.setTimeout(() => moreButtonRef.current?.focus(), 0);
  }

  function toggleSidebar() {
    setSidebarCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem("fuduo-sidebar-collapsed", String(next));
      return next;
    });
  }

  async function logout() {
    setLoggingOut(true);
    try {
      await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? "/api"}/auth/logout`, {
        method: "POST",
        credentials: "include",
      });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  return (
    <div className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`} data-app-ready={hydrated ? "true" : "false"}>
      <a className="skip-link" href="#workspace-main">跳到主要内容</a>
      <aside className="sidebar" aria-label="主导航">
        <div className="brand-block">
          <span className="brand-mark">FD</span>
          <span className="brand-name">富多智能助手</span>
          <Tooltip label={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"} side="right">
            <button
              className="icon-button sidebar-toggle"
              type="button"
              aria-label={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
              aria-expanded={!sidebarCollapsed}
              aria-controls="desktop-sidebar-nav"
              onClick={(event) => {
                toggleSidebar();
                if (event.detail > 0) event.currentTarget.blur();
              }}
            >
              {sidebarCollapsed ? <PanelLeftOpen aria-hidden="true" size={17} /> : <PanelLeftClose aria-hidden="true" size={17} />}
            </button>
          </Tooltip>
        </div>
        <nav className="nav-scroll" id="desktop-sidebar-nav">
          {visiblePrimary.map((item) => <NavLink item={item} pathname={pathname} collapsed={sidebarCollapsed} key={item.href} />)}
          <div className="nav-label">系统设置</div>
          {visibleSettings.map((item) => <NavLink item={item} pathname={pathname} collapsed={sidebarCollapsed} key={item.href} />)}
        </nav>
        <div className="sidebar-footer">
          <div className="user-block">
            <span className="avatar">{user?.displayName.trim().slice(0, 1) || "?"}</span>
            <span className="sidebar-user-copy" style={{ minWidth: 0, flex: 1 }}>
              <strong style={{ display: "block", fontSize: 13 }}>{user?.displayName ?? "未登录"}</strong>
              <span className="muted" style={{ display: "block", fontSize: 12 }}>内部工作区</span>
            </span>
            <Tooltip label="退出登录" side="top"><button className="icon-button shell-logout" type="button" aria-label="退出登录" disabled={loggingOut} onClick={() => void logout()}>
              <LogOut aria-hidden="true" size={16} />
            </button></Tooltip>
          </div>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="topbar-title">{current?.label ?? "富多店铺智能助手"}</div>
          <div className="topbar-actions">
            <span className="topbar-freshness"><StatusBadge status={globalState.freshness} /></span>
            <Tooltip label="查看数据通知" side="bottom"><Link className="button icon-button notification-button" href="/sync" aria-label={`数据通知 ${globalState.notificationCount} 条`}>
              <Bell aria-hidden="true" size={18} />
              {globalState.notificationCount ? <span>{Math.min(globalState.notificationCount, 99)}</span> : null}
            </Link></Tooltip>
            <span className={`status environment-status ${demo ? "warning" : "success"}`}>
              <span className="status-dot" aria-hidden="true" />{demo ? "演示数据" : "生产数据"}
            </span>
            <details className="topbar-user-menu">
              <summary aria-label="打开当前用户菜单">
                <span className="avatar">{user?.displayName.trim().slice(0, 1) || "?"}</span>
                <span>{user?.displayName ?? "未登录"}</span>
                <ChevronDown aria-hidden="true" size={14} />
              </summary>
              <div>
                <Link href="/settings/security"><Settings2 aria-hidden="true" size={16} />账号安全</Link>
                <button type="button" disabled={loggingOut} onClick={() => void logout()}><LogOut aria-hidden="true" size={16} />退出登录</button>
              </div>
            </details>
          </div>
        </header>
        <main id="workspace-main" tabIndex={-1}>{children}</main>
      </div>

      <nav className="mobile-nav" aria-label="移动端导航">
        {visiblePrimary.slice(0, 4).map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link className={active ? "active" : ""} href={item.href} key={item.href} aria-current={active ? "page" : undefined}>
              <Icon aria-hidden="true" size={20} />
              <span>{item.mobileLabel ?? item.label}</span>
            </Link>
          );
        })}
        <button
          ref={moreButtonRef}
          className={pathname.startsWith("/settings") || pathname === "/sync" ? "active" : ""}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          aria-controls="mobile-more-menu"
          onClick={() => setMoreOpen(true)}
        >
          <MoreHorizontal aria-hidden="true" size={20} />
          <span>更多</span>
        </button>
      </nav>

      {moreOpen ? (
        <div className="mobile-more-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeMore();
        }}>
          <section
            ref={moreDialogRef}
            id="mobile-more-menu"
            className="mobile-more-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-more-title"
            tabIndex={-1}
          >
            <header>
              <strong id="mobile-more-title">更多</strong>
              <Tooltip label="关闭更多导航" side="bottom"><button ref={moreCloseRef} className="icon-button" type="button" aria-label="关闭更多导航" onClick={closeMore}><X aria-hidden="true" size={18} /></button></Tooltip>
            </header>
            <nav>{[...visiblePrimary.slice(4), ...visibleSettings].map((item) => <NavLink item={item} pathname={pathname} key={item.href} />)}</nav>
            <button className="button mobile-logout" type="button" disabled={loggingOut} onClick={() => void logout()}><LogOut size={17} />退出登录</button>
          </section>
        </div>
      ) : null}
    </div>
  );
}
