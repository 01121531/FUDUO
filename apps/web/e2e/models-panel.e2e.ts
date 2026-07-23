import { expect, test } from "@playwright/test";
import { waitForAppReady } from "./helpers";

test.describe("model provider drawer", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/settings/models", { waitUntil: "domcontentloaded" });
    await waitForAppReady(page);
  });

  test("traps focus, closes on Escape, and restores the add button focus", async ({ page }) => {
    const addButton = page.getByRole("button", { name: "添加供应商" });
    await addButton.click();

    const drawer = page.getByRole("dialog", { name: "添加供应商" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByLabel("名称")).toBeFocused();

    const closeButton = drawer.getByRole("button", { name: "关闭添加供应商" });
    await closeButton.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(drawer.getByRole("button", { name: "取消" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(closeButton).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(addButton).toBeFocused();
  });

  test("opens edit in the same drawer and restores the row action focus", async ({ page }) => {
    const editButton = page.getByRole("button", { name: /^编辑 / }).first();
    await editButton.click();

    const drawer = page.getByRole("dialog", { name: "编辑供应商" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByLabel("名称")).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(editButton).toBeFocused();
  });
});
