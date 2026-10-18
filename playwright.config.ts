import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "browser",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 2,
  use: {
    baseURL: "http://localhost:8798",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
  webServer: {
    command: "pnpm test:ui-server",
    url: "http://localhost:8798/readyz",
    env: {
      NODE_ENV: "test",
      PORT: "8798",
      BUILDFERRY_PUBLIC_URL: "http://localhost:8798",
    },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
