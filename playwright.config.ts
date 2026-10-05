import { defineConfig } from '@playwright/test';

// Drives the installed Microsoft Edge against the real Darkroom + ComfyUI.
// Start Darkroom first (npm run dev, or start-darkroom.bat and set DR_E2E_URL=http://127.0.0.1:5178).
export default defineConfig({
  testDir: 'e2e',
  timeout: 20 * 60 * 1000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: 'proof/e2e-report', open: 'never' }]],
  use: {
    baseURL: process.env.DR_E2E_URL ?? 'http://127.0.0.1:5173',
    channel: 'msedge',
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    // a control that never appears fails the test in a minute instead of hanging it (DECISIONS 124)
    actionTimeout: 60_000,
    trace: 'retain-on-failure',
  },
  outputDir: 'proof/e2e-artifacts',
});
