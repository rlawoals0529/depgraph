import { defineConfig, devices } from "@playwright/test";

/**
 * The API is stubbed at the network boundary rather than run.
 *
 * A crawl walks the real npm registry, so a suite that needed one would be slow, would need
 * a database, and would change its answers whenever a package published. Stubbing the
 * responses keeps the thing under test where the bugs actually were: how the page reads
 * those numbers, and whether it says the true thing about them.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:4175",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Bind the host explicitly. Vite defaults to "localhost", which resolves to ::1 on some
    // machines, and then the 127.0.0.1 health check below waits out its whole timeout
    // against a server that is up and listening somewhere else.
    command: "npm run dev -- --host 127.0.0.1 --port 4175 --strictPort",
    url: "http://127.0.0.1:4175",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
