const { chromium } = require("../apps/api/node_modules/playwright-core");

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  });
  const errors = [];
  for (const config of [
    { name: "mobile", width: 390, height: 844 },
    { name: "desktop", width: 1440, height: 1000 },
  ]) {
    const page = await browser.newPage({ viewport: { width: config.width, height: config.height } });
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`${config.name}:${message.text()}`);
    });
    await page.goto("http://127.0.0.1:3000/sync", { waitUntil: "networkidle" });
    const metrics = await page.evaluate(() => ({
      viewport: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      hasContent: document.body.innerText.includes("最近同步"),
    }));
    console.log(`${config.name}:${JSON.stringify(metrics)}`);
    await page.screenshot({ path: `D:/project/富多/artifacts/sync-${config.name}.png`, fullPage: true });

    const detail = page.getByRole("button", { name: /查看.*详情/ }).last();
    if (await detail.count()) {
      await detail.click();
      await page.waitForTimeout(250);
      const dialog = page.getByRole("dialog");
      const bounds = await dialog.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width, viewport: innerWidth };
      });
      console.log(`${config.name}-dialog:${JSON.stringify(bounds)}`);
      await page.screenshot({ path: `D:/project/富多/artifacts/sync-${config.name}-detail.png` });
    }
    await page.close();
  }
  console.log(`consoleErrors:${JSON.stringify(errors)}`);
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
