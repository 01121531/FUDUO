import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 1,
  failOnFlakyTests: true,
  reporter: [["list"], ["html", { outputFolder: "../../artifacts/playwright-report", open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:3100",
    channel: "chrome",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "pnpm --filter @fuduo/api exec tsx src/main.ts",
      cwd: "../..",
      url: "http://127.0.0.1:3001/api/health/live",
      timeout: 180_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        API_HOST: "127.0.0.1",
        API_PORT: "3001",
        DEMO_MODE: "true",
        REQUIRE_AUTH: "false",
        WEB_ORIGIN: "http://127.0.0.1:3100",
      },
    },
    {
      command: "pnpm --filter @fuduo/web exec next start --hostname 127.0.0.1 --port 3100",
      cwd: "../..",
      url: "http://127.0.0.1:3100/dashboard",
      timeout: 180_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        DEMO_MODE: "true",
        REQUIRE_AUTH: "false",
        API_INTERNAL_URL: "http://127.0.0.1:3001/api",
        API_PROXY_TARGET: "http://127.0.0.1:3001",
        NEXT_PUBLIC_API_URL: "/api",
      },
    },
  ],
});
