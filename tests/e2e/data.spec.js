// 保存カードを失わないための仕組み: 書き出し・読み込み、保存できないときの知らせ
import { readFile } from 'node:fs/promises';
import { test, expect, say } from './fixtures.js';

test.use({ viewport: { width: 390, height: 844 } });

async function saveAll(page) {
  const buttons = page.locator('#cards').getByRole('button', { name: '保存', exact: true });
  while (await buttons.count()) {
    const before = await buttons.count();
    await buttons.first().click();
    await expect(buttons).toHaveCount(before - 1);
  }
}

async function exportFile(page, trigger) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click(trigger)]);
  expect(download.suggestedFilename()).toMatch(/^prompter-backup-\d{4}-\d{2}-\d{2}\.json$/);
  return { path: await download.path(), text: await readFile(await download.path(), 'utf8') };
}

test('書き出し→全部削除→読み込みで元に戻る。同じカードは足さない。APIキーは書き出さない', async ({ page }) => {
  await page.goto('index.html');
  await page.evaluate(() => localStorage.setItem('pl_keys', JSON.stringify({ gemini: 'AIza-secret-key' })));
  await page.reload();
  await say(page, 'NDAとSLAの話です。');
  await expect(page.locator('#cards .card')).toHaveCount(2);
  await saveAll(page);
  await expect(page.locator('#savedCount')).toHaveText('2');

  // 保存カードの画面で、まだ書き出していないことを知らせる
  await page.click('.tab[data-view=saved]');
  await expect(page.locator('#backupHint')).toBeVisible();
  await expect(page.locator('#backupHint')).toContainText('まだ書き出していないカードが、2枚あります。');
  const order = await page.locator('#savedList .card-title').allTextContents();

  await page.click('.tab[data-view=settings]');
  await expect(page.locator('#backupStatus')).toContainText('保存カード 2枚');
  await expect(page.locator('#backupStatus')).toContainText('まだ書き出していません。');
  await expect(page.locator('#evictionNote')).toBeVisible();
  const file = await exportFile(page, '#backupExport');
  const data = JSON.parse(file.text);
  expect(data.app).toBe('prompter');
  expect(data.saved.map((c) => c.title).sort()).toEqual(['NDA', 'SLA']);
  expect(file.text).not.toContain('AIza-secret-key');
  await expect(page.locator('#backupStatus')).toContainText('最後の書き出し:');
  await page.click('.tab[data-view=saved]');
  await expect(page.locator('#backupHint')).toBeHidden();

  // 全部削除してから、読み込む
  await page.click('.tab[data-view=settings]');
  page.once('dialog', (d) => d.accept());
  await page.click('#resetAll');
  await expect(page.locator('#savedCount')).toHaveText('0');
  await page.setInputFiles('#backupFile', file.path);
  await expect(page.locator('#toast')).toHaveText('2枚を読み込みました');
  await expect(page.locator('#savedCount')).toHaveText('2');
  await page.setInputFiles('#backupFile', file.path);
  await expect(page.locator('#toast')).toHaveText('0枚を読み込みました(2枚は、すでにありました)');
  await expect(page.locator('#savedCount')).toHaveText('2');

  // 読み込み直しても残っている
  await page.reload();
  await expect(page.locator('#savedCount')).toHaveText('2');
  await page.click('.tab[data-view=saved]');
  // 同じカードが、同じ順(新しい順)に戻る
  await expect(page.locator('#savedList .card-title')).toHaveText(order);

  // 別のファイルは読み込まない
  await page.click('.tab[data-view=settings]');
  await page.setInputFiles('#backupFile', { name: 'other.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":1}') });
  await expect(page.locator('#toast')).toHaveText('読み込めませんでした。プロンプターで書き出したファイルを選んでください');
  await expect(page.locator('#savedCount')).toHaveText('2');
});

test('端末に保存できないときは、画面の上で知らせ、その場で書き出せる', async ({ page }) => {
  // 保存領域がいっぱいの状態をまねる
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'pl_saved') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      return setItem.call(this, key, value);
    };
  });
  await page.goto('index.html');
  await expect(page.locator('#storageBanner')).toBeHidden();
  await say(page, 'NDAの話です。');
  await page.locator('#cards').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('画面には残しましたが、端末に保存できませんでした');
  await expect(page.locator('#storageBanner')).toBeVisible();
  await expect(page.locator('#storageText')).toContainText('保存領域がいっぱい');

  const file = await exportFile(page, '#storageExport');
  expect(JSON.parse(file.text).saved.map((c) => c.title)).toEqual(['NDA']);
  await page.click('#storageClose');
  await expect(page.locator('#storageBanner')).toBeHidden();
});
