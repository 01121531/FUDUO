import { spawn } from "node:child_process";
import { createServer } from "node:net";

const host = "127.0.0.1";
const port = await availablePort();
const child = spawn(
  process.execPath,
  ["--conditions=production", "apps/api/dist/main.js"],
  {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      API_HOST: host,
      API_PORT: String(port),
      DEMO_MODE: "true",
      REQUIRE_AUTH: "false",
      WEB_ORIGIN: "http://127.0.0.1:3100",
    },
    stdio: "ignore",
    windowsHide: true,
  },
);

let exited = false;
child.once("exit", () => {
  exited = true;
});

try {
  const deadline = Date.now() + 30_000;
  let healthy = false;
  while (Date.now() < deadline && !exited) {
    try {
      const response = await fetch(`http://${host}:${port}/api/health/live`);
      if (response.ok) {
        healthy = true;
        break;
      }
    } catch {
      // The compiled server is still starting.
    }
    await delay(250);
  }
  if (!healthy) {
    throw new Error(exited
      ? "Built API process exited before becoming healthy"
      : "Built API did not become healthy within 30 seconds");
  }
  console.log("Built API runtime smoke passed.");
} finally {
  if (!exited) {
    child.kill();
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      delay(5_000),
    ]);
  }
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a runtime smoke-test port"));
        return;
      }
      const selectedPort = address.port;
      server.close((error) => error ? reject(error) : resolve(selectedPort));
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
