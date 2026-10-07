// 使ったトークンの表示
import { test, expect, useProvider, say, card, tableRows, chipText } from './fixtures.js';
import { mockAI } from './mock-ai.js';

test.describe('スマホ', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('合計→要点の1回分→内訳→接続テスト→読み込み直し→記録を消す', async ({ page }) => {
    await mockAI(page);
    await useProvider(page, 'gemini', 'AIza-e2e');
    await expect(page.locator('#usageChip')).toBeHidden();

    // 自動判定1回: 入力800・出力50
    await say(page, '今回のEBPMの進め方について、KPIの設定をお願いしたいです。');
    await expect.poll(() => chipText(page)).toBe('850トークン');
    await say(page, 'NDAの話です。');
    await expect.poll(() => chipText(page)).toBe('1,700トークン');

    // 要点1回: 入力1,620・出力290(うち思考200)、検索1回
    await card(page, 'KPI').getByRole('button', { name: '要点' }).click();
    await expect(page.locator('#sumMeta')).toContainText('使ったトークン: 入力 1,620・出力 290(うち思考 200)・Google検索 1回');
    await page.click('#sheetDone');
    await expect.poll(() => chipText(page)).toBe('3,610トークン');

    // 押すと、設定の内訳へ
    await page.click('#usageChip');
    await expect(page.locator('#view-settings')).toBeVisible();
    await expect.poll(() => page.evaluate(() => {
      const r = document.querySelector('#usageGroup').getBoundingClientRect();
      return r.top >= 0 && r.top < window.innerHeight / 2;
    })).toBe(true);
    expect(await tableRows(page, '#usageSession')).toEqual([
      '種類 | 回数 | 入力 | 出力',
      '自動判定 | 2 | 1,600 | 100',
      '要点 | 1 | 1,620 | 290',
      '合計 | 3 | 3,220 | 390',
    ]);
    await expect(page.locator('#usageSession .note')).toHaveText('出力のうち、AIが考えた分 200。Google検索 1回。');
    expect(await tableRows(page, '#usageToday')).toEqual([
      'モデル | 回数 | 入力 | 出力',
      'gemini-3.5-flash-lite | 2 | 1,600 | 100',
      'gemini-3.5-flash | 1 | 1,620 | 290',
      '合計 | 3 | 3,220 | 390',
    ]);
    await expect(page.locator('#usageTodayTitle')).toHaveText(/^今日\(\d+月\d+日\)、モデルごと$/);

    // 接続テストの結果にも出し、内訳に増える
    await page.click('#testBtn');
    await expect(page.locator('#testResult')).toHaveClass(/is-ok/);
    await expect(page.locator('#testResult')).toContainText('使ったトークン: 入力 800・出力 50。');
    await expect.poll(() => tableRows(page, '#usageSession')).toContain('接続テスト | 1 | 800 | 50');

    // 読み込み直すと、この画面の分は0から。今日の分は残る
    const today = await tableRows(page, '#usageToday');
    await page.reload();
    await expect(page.locator('#usageChip')).toBeHidden();
    await page.click('.tab[data-view=settings]');
    await expect(page.locator('#usageSession')).toHaveText('まだ使っていません。');
    expect(await tableRows(page, '#usageToday')).toEqual(today);

    await page.click('#usageReset');
    await expect(page.locator('#usageToday')).toHaveText('まだ使っていません。');
    expect(await page.evaluate(() => localStorage.getItem('pl_usage'))).toBeNull();
  });

  test('日付が変わったら、今日の分は0から数える', async ({ page }) => {
    await page.goto('index.html');
    await page.evaluate(() => localStorage.setItem('pl_usage', JSON.stringify({
      date: '2000-01-01',
      models: { 'gemini/gemini-3.5-flash-lite': { provider: 'gemini', model: 'gemini-3.5-flash-lite', n: 9, input: 9000, output: 900 } },
    })));
    await page.reload();
    await page.click('.tab[data-view=settings]');
    await expect(page.locator('#usageToday')).toHaveText('まだ使っていません。');
  });
});

test.describe('動きを減らす設定', () => {
  test.use({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });

  test('数え上げずにすぐ出し、大きな数は「万」で出す', async ({ page }) => {
    await mockAI(page, { geminiUsage: { promptTokenCount: 6000, candidatesTokenCount: 150 } });
    await useProvider(page, 'gemini', 'AIza-e2e');
    await say(page, 'KPIの話です。');
    await expect(page.locator('#usageChip')).toBeVisible();
    expect(await chipText(page)).toBe('6,150トークン');
    await say(page, 'NDAの話です。');
    await expect.poll(() => chipText(page)).toBe('1.2万トークン');
  });
});

for (const colorScheme of ['light', 'dark']) {
  test.describe('PC幅(' + colorScheme + ')', () => {
    test.use({ viewport: { width: 1280, height: 800 }, colorScheme });

    test('トークンは、状態の行の右端に出る', async ({ page }) => {
      await mockAI(page);
      await useProvider(page, 'gemini', 'AIza-e2e');
      await say(page, 'KPIの話です。');
      await expect(page.locator('#usageChip')).toBeVisible();
      const [ai, chip, feed] = await Promise.all(['#aiToggle', '#usageChip', '#feedWrap'].map((s) => page.locator(s).boundingBox()));
      expect(Math.abs((ai.y + ai.height / 2) - (chip.y + chip.height / 2))).toBeLessThanOrEqual(2);
      expect(feed.x + feed.width - (chip.x + chip.width)).toBeLessThanOrEqual(30);
    });
  });
}
