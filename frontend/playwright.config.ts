import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: "http://127.0.0.1:5175",
    trace: "on-first-retry",
  },
  webServer: [
    {
      command:
        "cd .. && PYTHONPATH=. RESOLVEIQ_DATA_DIR=/private/tmp/resolveiq-e2e-data RESOLVEIQ_AUTH_USERNAME=e2e-agent RESOLVEIQ_AUTH_PASSWORD=e2e-password /Users/phanee/Downloads/Projects/ResolveIQ/.venv/bin/uvicorn backend.app.main:app --host 127.0.0.1 --port 8020",
      url: "http://127.0.0.1:8020/docs",
      reuseExistingServer: false,
    },
    {
      command:
        "RESOLVEIQ_API_TARGET=http://127.0.0.1:8020 npm run dev -- --host 127.0.0.1 --port 5175",
      url: "http://127.0.0.1:5175",
      reuseExistingServer: false,
    },
  ],
});
