import { expect, test } from "@playwright/test";
import { waitForAppReady } from "./helpers";

test("dashboard filters stay in the URL and a manual sync reports success", async ({ page }) => {
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  await waitForAppReady(page);

  const sevenDayPeriod = page.getByRole("link", { name: "近 7 天" });
  await sevenDayPeriod.click();
  await expect(page).toHaveURL(/\/dashboard\?period=7d/);
  await expect(sevenDayPeriod).toHaveAttribute("aria-current", "page");

  await page.getByRole("button", { name: "自定义" }).click();
  const startDate = page.getByLabel("开始日期");
  await expect(startDate).toBeVisible();
  await startDate.fill("2026-01-05");
  await page.getByLabel("结束日期").fill("2026-01-01");
  await page.getByRole("button", { name: "应用日期" }).click();
  await expect(page.getByText("开始日期不能晚于结束日期", { exact: true })).toBeVisible();

  await startDate.fill("2026-01-01");
  await page.getByRole("button", { name: "应用日期" }).click();
  await expect(page).toHaveURL(/period=custom/);
  await expect(page).toHaveURL(/start=2026-01-01/);
  await expect(page).toHaveURL(/end=2026-01-01/);

  await page.locator("details.store-filter > summary").click();
  await page.getByPlaceholder("搜索店铺名称或 ID").fill("10218");
  const shopOption = page.locator(".store-filter-option").filter({ hasText: "10218" });
  await expect(shopOption).toHaveCount(1);
  await shopOption.getByRole("checkbox").check();
  await page.getByRole("button", { name: "应用筛选" }).click();
  await expect(page).toHaveURL(/shops=10218/);

  await page.getByRole("button", { name: "立即同步" }).click();
  await expect(page.getByText(/同步任务已创建/)).toBeVisible();
});

test("sync center exposes filters, recovery, and an accessible detail drawer", async ({ page }) => {
  await page.goto("/sync", { waitUntil: "domcontentloaded" });
  await waitForAppReady(page);
  await expect(page.getByRole("heading", { name: "最近同步" })).toBeVisible();

  const runRows = page.locator(".sync-desktop-table tbody tr");
  await expect(runRows.first()).toBeVisible();
  const initialRunCount = await runRows.count();
  await page.getByRole("button", { name: "立即同步" }).click();
  await expect(page.getByText("同步任务已加入队列", { exact: true })).toBeVisible();
  await expect(runRows).toHaveCount(initialRunCount + 1);
  await expect(runRows.first()).toContainText("销售数据");
  await expect(runRows.first()).toContainText("排队中");

  await page.getByLabel("按记录类型筛选").selectOption("credential-refresh");
  await expect(page.getByText("没有符合筛选条件的记录")).toBeVisible();
  await page.getByRole("button", { name: "清除筛选" }).click();

  const detailButton = page.getByRole("button", { name: /查看 .* 同步详情/ }).first();
  await detailButton.click();
  const drawer = page.getByRole("dialog", { name: /销售数据|订单数据|退款数据|店铺目录|近 7 天经营校正|授权刷新/ });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "阶段时间线" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(detailButton).toBeFocused();
});

test("report schedule validation and creation work end to end", async ({ page }) => {
  await page.goto("/reports", { waitUntil: "domcontentloaded" });
  await waitForAppReady(page);
  await page.getByRole("button", { name: "新建定时报表" }).click();

  const drawer = page.getByRole("dialog", { name: "新建定时报表" });
  await expect(drawer).toBeVisible();
  await drawer.locator(".channel-options label").filter({ hasText: "Web" }).click();
  await drawer.locator(".channel-options label").filter({ hasText: "微信" }).click();
  await drawer.getByRole("button", { name: "创建计划" }).click();
  await expect(drawer.getByRole("alert")).toContainText("请选择至少一个投递渠道");

  await drawer.locator(".channel-options label").filter({ hasText: "Web" }).click();
  await drawer.getByRole("button", { name: "创建计划" }).click();
  await expect(drawer).toBeHidden();
  await expect(page.getByRole("button", { name: "新建定时报表" })).toBeFocused();

  const reportRows = page.locator(".report-desktop tbody tr");
  await expect(reportRows.first()).toBeVisible();
  const initialReportCount = await reportRows.count();
  await page.getByRole("button", { name: "生成日报" }).click();
  await expect(reportRows).toHaveCount(initialReportCount + 1);
  await expect(reportRows.first()).toContainText("经营日报");
  await expect(reportRows.first()).toContainText("未推送");
});

test("chat answers a business question with a data cutoff", async ({ page }) => {
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  await waitForAppReady(page);
  const question = "今天所有店铺销售额是多少？";
  await page.getByRole("button", { name: question, exact: true }).click();

  await expect(page.locator(".message.user").filter({ hasText: question })).toBeVisible();
  const answer = page.locator(".message.assistant").filter({ hasText: "数据截止" }).last();
  await expect(answer).toBeVisible({ timeout: 20_000 });
  await expect(answer).toContainText(/销售额|店铺/);
});
