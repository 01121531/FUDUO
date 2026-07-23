import { expect, test } from "@playwright/test";
import { waitForAppReady } from "./helpers";

test("global icon tooltips are visible by keyboard and mouse", async ({ page }) => {
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  await waitForAppReady(page);

  const notification = page.getByRole("link", { name: /数据通知/ });
  const notificationTooltip = page.getByRole("tooltip", { name: "查看数据通知" });
  await expect(notificationTooltip).toBeHidden();
  await notification.focus();
  await expect(notificationTooltip).toBeVisible();

  const logout = page.getByRole("button", { name: "退出登录" }).first();
  await logout.hover();
  await expect(page.getByRole("tooltip", { name: "退出登录" })).toBeVisible();
});

test("covered icon controls use custom tooltips instead of native titles", async ({ page }) => {
  test.setTimeout(180_000);
  for (const route of ["/dashboard", "/shops", "/chat", "/sync", "/reports", "/settings/models", "/settings/members", "/settings/security", "/settings/audit"]) {
    await page.goto(route, { waitUntil: "domcontentloaded" });
    await expect(page.locator("button[title], a[title]"), `${route} should not use native title tooltips`).toHaveCount(0);
  }
});
