// 画面の大きさ・配色ごとの見え方
import { test, expect, useProvider, say, card } from './fixtures.js';
import { mockAI } from './mock-ai.js';

const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

for (const colorScheme of ['light', 'dark']) {
  test.describe('PC幅(' + colorScheme + ')', () => {
    test.use({ viewport: { width: 1280, height: 800 }, colorScheme });

    test('文字起こしは右、要点は右から出てEscで閉じる', async ({ page }) => {
      await mockAI(page);
      await useProvider(page, 'gemini', 'AIza-e2e');
      await say(page, '今回のEBPMの進め方について、KPIの設定をお願いしたいです。');
      await say(page, 'トランプ大統領の関税の影響も、次の会議までに整理しておきたいですね。');
      const trump = card(page, 'トランプ');
      await expect(trump).toBeVisible();

      const [feed, transcript] = await Promise.all(['#feedWrap', '#transcriptPanel'].map((s) => page.locator(s).boundingBox()));
      expect(transcript.x).toBeGreaterThanOrEqual(feed.x + feed.width - 1);
      expect(await noOverflow(page)).toBe(true);

      await trump.getByRole('button', { name: '要点' }).click();
      await expect(page.locator('#sumList .sum-item')).toHaveCount(3);
      // 右から滑り込み、右端にぴったり止まる
      await expect.poll(async () => {
        const b = await page.locator('#sheet').boundingBox();
        return Math.round(b.x + b.width);
      }).toBe(1280);
      expect((await page.locator('#sheet').boundingBox()).x).toBeGreaterThan(1280 / 2);
      await page.keyboard.press('Escape');
      await expect(page.locator('#sheet')).toBeHidden();
    });
  });
}

test.describe('横向きのスマホ', () => {
  test.use({ viewport: { width: 844, height: 390 } });

  test('はみ出さない', async ({ page }) => {
    await page.goto('index.html');
    await expect(page.locator('#listenBtn')).toBeVisible();
    expect(await noOverflow(page)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true);
  });
});
