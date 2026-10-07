// 上限・通信の失敗のときに、止まらずに続ける仕組み
import { test, expect, useProvider, say } from './fixtures.js';
import { mockAI } from './mock-ai.js';

test.use({ viewport: { width: 390, height: 844 } });

const analyzeCalls = (log) => log.filter((l) => l.url.includes(':generateContent'));

test.describe('1分あたりの上限', () => {
  test.use({ allowedErrors: [/status of 429/] });

  test('示された時間だけ待ち、そのあいだの発言は簡易判定で拾い、その後AIで再開する', async ({ page }) => {
    const log = await mockAI(page, {
      geminiFail: [{ status: 429, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'retry later', details: [{ retryDelay: '3s' }] } } }],
    });
    await useProvider(page, 'gemini', 'AIza-e2e');
    await say(page, 'NDAとSLAの話です。');
    await expect(page.locator('#status')).toHaveText('利用上限か混雑のため、約3秒待ってから再開します。');
    // AIで確かめられなかった文は、簡易判定(意味は未取得)で拾う
    await expect(page.locator('#cards .card-sub', { hasText: '意味は未取得' })).toHaveCount(2);
    await expect(page.locator('#aiToggle')).toContainText('AIオン');

    await say(page, 'PoCの話です。');
    await expect(page.locator('#cards .card-body', { hasText: '本格導入の前に小さく試すこと' })).toBeVisible();
    await expect(page.locator('#status')).toHaveText('');
    const calls = analyzeCalls(log);
    expect(calls.length).toBe(2);
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(2900);
  });
});

test.describe('1日の上限', () => {
  test.use({ allowedErrors: [/status of 429/] });

  test('AIを止めて案内し、それ以上は送らない', async ({ page }) => {
    const log = await mockAI(page, {
      geminiFail: [{ status: 429, body: { error: {
        code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota exceeded',
        details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }],
      } } }],
    });
    await useProvider(page, 'gemini', 'AIza-e2e');
    await say(page, 'NDAの話です。');
    await expect(page.locator('#aiToggle')).toHaveText('AI停止中');
    await expect(page.locator('#status')).toContainText('利用上限に達しました');
    await expect(page.locator('#status')).toContainText('いまは簡易判定で動いています');
    await say(page, 'KPIの話です。');
    await expect(page.locator('#cards .card-title').filter({ hasText: /^KPI$/ })).toHaveCount(1);
    await page.waitForTimeout(2000);
    expect(analyzeCalls(log).length).toBe(1);
  });
});

test.describe('通信の失敗', () => {
  test.use({ allowedErrors: [/Failed to load resource|net::ERR_FAILED/] });

  test('待ち時間を示して、あとでもう一度送る', async ({ page }) => {
    const log = await mockAI(page, { geminiFail: [{ abort: true }] });
    await useProvider(page, 'gemini', 'AIza-e2e');
    await say(page, 'NDAの話です。');
    await expect(page.locator('#status')).toContainText('約5秒後に、もう一度試します。');
    await say(page, 'KPIの話です。');
    await expect(page.locator('#cards .card-body', { hasText: '目標の達成度を測る数値の指標' })).toBeVisible({ timeout: 15_000 });
    const calls = analyzeCalls(log);
    expect(calls.length).toBe(2);
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(4900);
  });
});
