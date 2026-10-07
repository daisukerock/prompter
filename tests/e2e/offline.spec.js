// AIを使わない簡易判定と、AIのオン・オフ
import { test, expect, say } from './fixtures.js';

test.use({ viewport: { width: 390, height: 844 } });

test('AI未設定: 英字の略語と、気をつけたい言葉を拾う', async ({ page }) => {
  await page.goto('index.html');
  await expect(page.locator('#cardsEmpty')).toBeVisible();
  await expect(page.locator('#setupBanner')).toBeVisible();
  await expect(page.locator('#aiToggle')).toHaveText('AI未設定');

  await page.click('#transcriptToggle');
  await page.fill('#typeInput', '契約条件はNDAを結んだうえで、必ず今週中に回答をお願いします。');
  await page.press('#typeInput', 'Enter');
  await expect(page.locator('#cards .card-title').filter({ hasText: /^NDA$/ })).toHaveCount(1);
  // 同じ1文の注意点は1枚にまとめ、赤(要注意)を含めば赤にする
  await expect(page.locator('#cards .card.risk-red')).toHaveCount(1);
  await expect(page.locator('#cardsEmpty')).toBeHidden();
  await expect(page.locator('#transcript .line mark', { hasText: 'NDA' })).toHaveCount(1);
});

test.describe('動きを減らす設定', () => {
  test.use({ reducedMotion: 'reduce' });

  test('AIオフでは会話を送らず、要点のボタンはGeminiを選んだときだけ出る', async ({ page }) => {
    await page.route(/https:\/\/(api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com)\/.*/, (route) => {
      throw new Error('AIオフなのに送った: ' + route.request().url());
    });
    await page.goto('index.html');
    await page.evaluate(() => {
      localStorage.setItem('pl_settings', JSON.stringify({ version: 3, provider: 'claude', aiEnabled: false, rememberKey: true }));
      localStorage.setItem('pl_keys', JSON.stringify({ claude: 'sk-ant-x' }));
    });
    await page.reload();
    await expect(page.locator('#aiToggle')).toHaveText('AIオフ');
    await say(page, 'NDAとSLAの話です。');
    await expect(page.locator('#cards .card')).toHaveCount(2);
    await expect(page.locator('#cards').getByRole('button', { name: '要点' })).toHaveCount(0);

    await page.click('.tab[data-view=settings]');
    await page.selectOption('#providerSelect', 'gemini');
    await expect(page.locator('#summaryRow')).toBeVisible();
    await expect(page.locator('#summarySelect')).toHaveValue('gemini-3.5-flash');
    await page.click('.tab[data-view=live]');
    await expect(page.locator('#cards').getByRole('button', { name: '要点' })).toHaveCount(2);
  });
});
