import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { waitForAppReady } from "./helpers";

const routes = [
  "/dashboard",
  "/shops",
  "/shops/10218",
  "/reports",
  "/reports/demo-daily",
  "/chat",
  "/sync",
  "/settings/erp",
  "/settings/models",
  "/settings/extensions",
  "/settings/update",
  "/settings/wechat",
  "/settings/members",
  "/settings/security",
  "/settings/audit",
];

const viewports = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1024, height: 768 },
  { name: "wide", width: 1440, height: 900 },
];

for (const viewport of viewports) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const route of routes) {
      test(`${route} has no overflow or serious accessibility violations`, async ({ page }) => {
        test.setTimeout(90_000);
        const response = await page.goto(route, { waitUntil: "domcontentloaded" });
        expect(response?.status(), `${route} should return a successful document`).toBeLessThan(400);
        await waitForAppReady(page);
        await expect(page.locator("#workspace-main")).toBeVisible();

        const overflow = await page.evaluate(() => {
          const offenders = [...document.querySelectorAll<HTMLElement>("body *")]
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              return rect.width > 0 && (rect.right > document.documentElement.clientWidth + 1 || rect.left < -1);
            })
            .slice(0, 8)
            .map((element) => `${element.tagName.toLowerCase()}.${element.className} right=${Math.round(element.getBoundingClientRect().right)}`);
          return {
            document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            body: document.body.scrollWidth - document.body.clientWidth,
            offenders,
          };
        });
        expect(overflow.document, `${route} document overflow: ${overflow.offenders.join(", ")}`).toBeLessThanOrEqual(1);
        expect(overflow.body, `${route} body overflow: ${overflow.offenders.join(", ")}`).toBeLessThanOrEqual(1);

        const accessibility = await new AxeBuilder({ page })
          .disableRules(["color-contrast"])
          .withTags(["wcag2a", "wcag2aa"])
          .analyze();
        const serious = accessibility.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious");
        expect(serious, serious.map((violation) => `${violation.id}: ${violation.help}`).join("\n")).toEqual([]);
      });
    }
  });
}

test("mobile chat exposes accessible conversation and context sheets", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  await waitForAppReady(page);

  const historyButton = page.getByRole("button", { name: "打开会话列表" });
  await historyButton.click();
  await expect(historyButton).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("dialog", { name: "会话" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "会话" })).toBeHidden();

  const contextButton = page.getByRole("button", { name: "打开上下文" });
  await contextButton.click();
  await expect(page.getByRole("button", { name: "关闭上下文" }).first()).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("dialog", { name: "上下文" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "上下文" })).toBeHidden();
});

test("shop tabs support arrow-key navigation", async ({ page }) => {
  await page.goto("/shops/10218", { waitUntil: "domcontentloaded" });
  await waitForAppReady(page);
  await expect(page.getByRole("tablist", { name: "店铺数据视图" })).toHaveAttribute("data-tabs-ready", "true");
  const overview = page.getByRole("tab", { name: "概览" });
  await overview.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "销售" })).toBeFocused();
  await expect(page.getByRole("tab", { name: "销售" })).toHaveAttribute("aria-selected", "true");
});

test("desktop sidebar collapses, persists, and exposes icon tooltips", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/shops");
  await expect(page.locator('[data-app-ready="true"]')).toBeVisible();

  const sidebar = page.locator(".sidebar");
  const workspace = page.locator(".workspace");
  const collapse = page.getByRole("button", { name: "收起侧边栏" });
  await expect(sidebar).toHaveCSS("width", "244px");
  await collapse.click();
  await expect(page.getByRole("button", { name: "展开侧边栏" })).toHaveAttribute("aria-expanded", "false");
  await expect(sidebar).toHaveCSS("width", "76px");
  await expect(workspace).toHaveCSS("margin-left", "76px");

  await page.getByRole("link", { name: "经营概览" }).focus();
  await expect(page.getByRole("tooltip", { name: "经营概览" })).toBeVisible();

  await page.reload();
  await expect(page.locator('[data-app-ready="true"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "展开侧边栏" })).toBeVisible();
  await expect(sidebar).toHaveCSS("width", "76px");

  await page.getByRole("button", { name: "展开侧边栏" }).click();
  await expect(page.getByRole("button", { name: "收起侧边栏" })).toHaveAttribute("aria-expanded", "true");
  await expect(sidebar).toHaveCSS("width", "244px");
});
