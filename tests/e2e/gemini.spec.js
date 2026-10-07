// Gemini: デモ→カード→要点(Google検索つき)→保存→書き出し
import { test, expect, useProvider, say, card, demoDone } from './fixtures.js';
import { mockAI } from './mock-ai.js';

test.use({ viewport: { width: 390, height: 844 } });

const summaryRequests = (log) => log.filter((l) => l.url.includes(':streamGenerateContent'));

test('デモ→要点→引っぱって閉じる→保存→書き出し→保存カードから開き直す→消す', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const log = await mockAI(page);
  await useProvider(page, 'gemini', 'AIza-e2e');
  await expect(page.locator('#aiToggle')).toContainText('AIオン・Gemini');

  await page.click('#demoBtn');
  await expect(page.locator('#cards .card').first()).toBeVisible({ timeout: 15_000 });
  // スマホ幅: 1行目にAIとトークン、状態の文(デモを再生中…)は2行目
  await expect(page.locator('#usageChip')).toBeVisible();
  await expect(page.locator('#status')).toHaveText('デモを再生中…');
  const [ai, chip, status] = await Promise.all(['#aiToggle', '#usageChip', '#status'].map((s) => page.locator(s).boundingBox()));
  expect(Math.round(chip.y)).toBe(Math.round(ai.y));
  expect(status.y).toBeGreaterThanOrEqual(ai.y + ai.height - 1);
  expect(chip.x + chip.width).toBeLessThanOrEqual(390);

  const trump = card(page, 'トランプ');
  await expect(trump).toBeVisible({ timeout: 20_000 });
  await trump.getByRole('button', { name: '要点' }).click();
  await expect(page.locator('#sumList .sum-item')).toHaveCount(3);
  await expect(page.locator('#sumSources')).toBeVisible();
  await expect(page.locator('#sumList')).toContainText('米国が輸入品に課す追加関税');
  const sum = summaryRequests(log)[0];
  expect(sum.url).toContain('/models/gemini-3.5-flash:streamGenerateContent');
  expect(sum.body.tools).toEqual([{ google_search: {} }]);
  await expect(page.locator('#sumSourceList a')).toHaveCount(2);
  await expect(page.locator('#sumSuggest iframe')).toHaveAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
  await expect(page.locator('#sumMeta')).toContainText('使ったトークン: 入力 1,620・出力 290(うち思考 200)・Google検索 1回');

  // 下に引っぱって閉じる
  const grip = await page.locator('#sheetGrip').boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(grip.x + grip.width / 2, grip.y + i * 30);
  await page.mouse.up();
  await expect(page.locator('#sheet')).toBeHidden();
  await expect(trump).toContainText('要点 ›');

  await demoDone(page);
  // 保存すると、保存カードにも要点が残る
  await trump.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('#savedCount')).toHaveText('1');
  await page.click('.tab[data-view=saved]');
  await expect(page.locator('#savedList')).toContainText('要点 ›');
  await page.click('#exportBtn');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/要点: 何の話: 米国が輸入品/);

  // 保存カードから要点を開くと、作り直さずにそのまま見せる
  const made = summaryRequests(log).length;
  await page.locator('#savedList .card-summary').first().click();
  await expect(page.locator('#sumList .sum-item')).toHaveCount(3);
  expect(summaryRequests(log).length).toBe(made);
  await page.click('#sheetDone');
  await expect(page.locator('#sheet')).toBeHidden();

  // ✕で1枚消し、「消す」で全部消す
  await page.click('.tab[data-view=live]');
  const before = await page.locator('#cards .card').count();
  await page.locator('#cards .card .card-x').first().click();
  await expect(page.locator('#cards .card')).toHaveCount(before - 1);
  await page.click('#clearBtn');
  await expect(page.locator('#cards .card')).toHaveCount(0);
  await expect(page.locator('#cardsEmpty')).toBeVisible();
});

test.describe('要点の失敗', () => {
  test.use({ allowedErrors: [/status of 503/] });

  test('失敗したら「速いモデルでやり直す」で、Flash-Liteで作り直す', async ({ page }) => {
    const log = await mockAI(page, { summaryFailFirst: true });
    await useProvider(page, 'gemini', 'AIza-e2e');
    await say(page, 'トランプ大統領の関税の影響を整理したい。');
    await card(page, 'トランプ').getByRole('button', { name: '要点' }).click();
    await expect(page.locator('#sumError')).toContainText('一時的な不具合');
    await expect(page.locator('#sheetFast')).toBeVisible();
    await page.click('#sheetFast');
    await expect(page.locator('#sumList .sum-item')).toHaveCount(3);
    await expect(page.locator('#sumError')).toBeHidden();
    expect(summaryRequests(log).pop().url).toContain('/models/gemini-3.5-flash-lite:');
  });
});
