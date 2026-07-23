import { expect, test } from "@playwright/test";
import { waitForAppReady } from "./helpers";

test("shop table headers expose and update sorting state", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/shops", { waitUntil: "domcontentloaded" });
  await waitForAppReady(page);

  const salesHeader = page.getByRole("columnheader", { name: /今日销售额/ });
  await expect(salesHeader).toHaveAttribute("aria-sort", "descending");

  await salesHeader.getByRole("button").click();
  await expect(salesHeader).toHaveAttribute("aria-sort", "ascending");
  await expect(page).toHaveURL(/sort=SALES_ASC/);

  const nameHeader = page.getByRole("columnheader", { name: /店铺/ }).first();
  await nameHeader.getByRole("button").click();
  await expect(nameHeader).toHaveAttribute("aria-sort", "ascending");
  await expect(salesHeader).not.toHaveAttribute("aria-sort");
  await expect(page).toHaveURL(/sort=NAME_ASC/);
});

test("empty filtered shop results provide a clear recovery action", async ({ page }) => {
  await page.goto("/shops", { waitUntil: "domcontentloaded" });
  await waitForAppReady(page);
  await page.getByRole("textbox", { name: "搜索店铺" }).fill("definitely-no-matching-shop");

  await expect(page.getByText("没有符合当前筛选条件的店铺")).toBeVisible();
  await page.getByRole("button", { name: "清除筛选" }).click();

  await expect(page.getByRole("textbox", { name: "搜索店铺" })).toHaveValue("");
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page).not.toHaveURL(/(?:\?|&)q=/);
});
