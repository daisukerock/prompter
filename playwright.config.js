// 通しテスト(ブラウザで画面を動かし、AIの応答は模擬して確かめる)。実行: npx playwright test
import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.PORT || 8765);
// Playwright用のブラウザを入れられない環境では、PW_CHROMIUM にChromiumの場所を入れる
const executablePath = process.env.PW_CHROMIUM || undefined;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:' + PORT + '/',
    locale: 'ja-JP',
    trace: 'retain-on-failure',
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: {
    command: 'node tests/e2e/serve.mjs ' + (process.env.E2E_ROOT || 'prompter'),
    url: 'http://127.0.0.1:' + PORT + '/index.html',
    reuseExistingServer: !process.env.CI,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
