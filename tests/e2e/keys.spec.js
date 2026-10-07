// APIキーの保存。読み込み直しても、キーは消えない
import { test, expect } from './fixtures.js';

test.use({ viewport: { width: 390, height: 844 } });

// 設定画面で、AIのキーとJevのキーを入れる
async function enterKeys(page) {
  await page.goto('index.html');
  await page.click('.tab[data-view="settings"]');
  await page.selectOption('#providerSelect', 'gemini');
  await page.fill('#keyInput', 'AIza-typed');
  await page.fill('#jevKeyInput', 'sk-or-typed');
}

async function shownKeys(page) {
  await page.click('.tab[data-view="settings"]');
  return { ai: await page.inputValue('#keyInput'), jev: await page.inputValue('#jevKeyInput') };
}

test('「この端末に保存する」がオンなら、読み込み直しても、開き直しても残る', async ({ page, context }) => {
  await enterKeys(page);
  await page.reload();
  expect(await shownKeys(page)).toEqual({ ai: 'AIza-typed', jev: 'sk-or-typed' });
  // 別のタブで開いても残る
  const other = await context.newPage();
  await other.goto('index.html');
  expect(await shownKeys(other)).toEqual({ ai: 'AIza-typed', jev: 'sk-or-typed' });
});

test('オフでも、読み込み直しでは消えない。タブを閉じると消える(端末には残さない)', async ({ page, context }) => {
  await enterKeys(page);
  await page.uncheck('#rememberKey');
  await expect(page.locator('#toast')).toContainText('このタブを閉じると消えます');
  expect(await page.evaluate(() => localStorage.getItem('pl_keys'))).toBeNull();

  await page.reload();
  await expect(page.locator('#rememberKey')).not.toBeChecked();
  expect(await shownKeys(page)).toEqual({ ai: 'AIza-typed', jev: 'sk-or-typed' });
  // 読み込み直したあとに入れ直しても、端末には残さない
  await page.fill('#keyInput', 'AIza-changed');
  expect(await page.evaluate(() => localStorage.getItem('pl_keys'))).toBeNull();

  // 新しいタブ(閉じて開き直したのと同じ)では、消えている
  await page.close();
  const fresh = await context.newPage();
  await fresh.goto('index.html');
  expect(await shownKeys(fresh)).toEqual({ ai: '', jev: '' });
});

test.describe('端末に保存できないとき', () => {
  test('読み込み直しても、このタブの控えからキーを戻す', async ({ page }) => {
    // 保存領域がいっぱいで、端末(localStorage)には書けない
    await page.addInitScript(() => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (this === window.localStorage && key === 'pl_keys') throw new DOMException('full', 'QuotaExceededError');
        return setItem.call(this, key, value);
      };
    });
    await enterKeys(page);
    await expect(page.locator('#storageBanner')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('pl_keys'))).toBeNull();
    await page.reload();
    expect(await shownKeys(page)).toEqual({ ai: 'AIza-typed', jev: 'sk-or-typed' });
  });
});

test('キーを削除したら、読み込み直しても戻らない', async ({ page }) => {
  await enterKeys(page);
  await page.click('#keyClearBtn');
  await page.click('#jevKeyClearBtn');
  await page.reload();
  expect(await shownKeys(page)).toEqual({ ai: '', jev: '' });
});
