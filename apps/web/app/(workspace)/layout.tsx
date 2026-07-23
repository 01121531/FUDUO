import { AppShell } from "@/components/app-shell";
import { apiGet } from "@/lib/api";
import { redirect } from "next/navigation";
import type { Shop } from "@fuduo/shared";

export const dynamic = "force-dynamic";

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const user = await apiGet<{ id: string; email: string; displayName: string; permissions: string[]; sessionState: string }>("/auth/me").catch(() => null);
  if (!user && process.env.REQUIRE_AUTH === "true") redirect("/login");
  if (user && user.sessionState !== "ACTIVE") redirect("/account-setup");
  const canRead = Boolean(user?.permissions.includes("*") || user?.permissions.includes("data:read") || process.env.REQUIRE_AUTH !== "true");
  const shops = canRead ? await apiGet<Shop[]>("/shops").catch(() => []) : [];
  return <AppShell demo={process.env.DEMO_MODE !== "false"} user={user} globalState={summarizeGlobalState(shops)}>{children}</AppShell>;
}

function summarizeGlobalState(shops: Shop[]) {
  if (!shops.length) return { freshness: "UNKNOWN", notificationCount: 0 };
  const order = ["LIVE", "RECENT", "STALE", "UNKNOWN"];
  const statuses = shops.map((shop) => shop.freshness ?? "UNKNOWN");
  const freshness = statuses.reduce(
    (worst, current) => order.indexOf(current) > order.indexOf(worst) ? current : worst,
    "LIVE",
  );
  const notificationCount = shops.filter((shop) => {
    const status = shop.freshness ?? "UNKNOWN";
    return status === "STALE" || status === "UNKNOWN" || shop.partial === true;
  }).length;
  return { freshness, notificationCount };
}
