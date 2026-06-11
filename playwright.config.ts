import { defineConfig, devices } from "@playwright/test";

const CI = !!process.env.CI;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 2 : 1,
  workers: 1,
  reporter: CI
    ? [
        ["github"],
        ["list"],
        ["json", { outputFile: "playwright-report/results.json" }],
      ]
    : "list",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    // Firefox + WebKit are excluded from the default CI run (workers: 1, serial)
    // to keep the e2e job under its 15-min timeout. The cross-browser workflow at
    // .github/workflows/e2e-cross-browser.yml runs the matrix nightly and on
    // workflow_dispatch. Run locally via `pnpm test:e2e --project firefox`.
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: !CI,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
