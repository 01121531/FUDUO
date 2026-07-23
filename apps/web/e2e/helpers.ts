import { expect, type Page } from "@playwright/test";

export async function waitForAppReady(page: Page) {
  await expect(page.locator(".app-shell")).toHaveAttribute("data-app-ready", "true");
}
