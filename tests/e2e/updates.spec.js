// 更新の直後に壊れないための仕組み: 版をそろえる読み込み直しと、起動できないときの案内
import { test, expect } from './fixtures.js';

test.use({ viewport: { width: 390, height: 844 } });

test('画面とプログラムの版が違えば、1回だけ読み込み直し、その後は動かす', async ({ page }) => {
  let pages = 0;
  // 古い画面(index.html)が残っている状態をまねる
  await page.route(/\/(index\.html)?(\?.*)?$/, async (route) => {
    if (route.request().resourceType() !== 'document') return route.continue();
    pages++;
    const res = await route.fetch();
    const body = (await res.text()).replace(/(<meta name="app-version" content=")[^"]*"/, '$1old-version"');
    return route.fulfill({ response: res, body });
  });
  await page.goto('index.html');
  await expect(page.locator('#aiToggle')).toHaveText('AI未設定');
  expect(pages).toBe(2);
  const build = await page.evaluate(() => sessionStorage.getItem('pl_reload_for'));
  await expect(page.locator('#appVersion')).toHaveText('版: ' + build);
  await expect(page.locator('#bootError')).toBeHidden();
});

test('読み込み直したことを記録できない端末では、版が違っても読み込み直さずに動かす(繰り返さない)', async ({ page }) => {
  let pages = 0;
  await page.addInitScript(() => {
    Object.defineProperty(window, 'sessionStorage', { configurable: true, get() { throw new DOMException('blocked', 'SecurityError'); } });
  });
  await page.route(/\/(index\.html)?(\?.*)?$/, async (route) => {
    if (route.request().resourceType() !== 'document') return route.continue();
    pages++;
    const res = await route.fetch();
    const body = (await res.text()).replace(/(<meta name="app-version" content=")[^"]*"/, '$1old-version"');
    return route.fulfill({ response: res, body });
  });
  await page.goto('index.html');
  await expect(page.locator('#aiToggle')).toHaveText('AI未設定');
  await page.waitForTimeout(500);
  expect(pages).toBe(1);
});

test('版がそろっていれば、読み込み直さない', async ({ page }) => {
  let pages = 0;
  page.on('request', (r) => { if (r.resourceType() === 'document') pages++; });
  await page.goto('index.html');
  await expect(page.locator('#aiToggle')).toHaveText('AI未設定');
  expect(pages).toBe(1);
  await expect(page.locator('#appVersion')).toHaveText(/^版: \S+$/);
});

test.describe('起動できないとき', () => {
  test.use({ allowedErrors: [/SyntaxError|Unexpected|status of 404|Failed to load|Failed to fetch dynamically/] });

  test('プログラムが壊れていたら案内を出し、直ったあとは「読み込み直す」で起動する', async ({ page }) => {
    await page.route(/\/app\.js(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: 'this is (not javascript' }));
    await page.goto('index.html');
    await expect(page.locator('#bootError')).toBeVisible();
    await expect(page.locator('#bootError')).toContainText('うまく起動できませんでした');

    await page.unroute(/\/app\.js(\?.*)?$/);
    await page.click('#bootReload');
    await expect(page.locator('#aiToggle')).toHaveText('AI未設定');
    await expect(page.locator('#bootError')).toBeHidden();
  });

  test('読み込むファイルが見つからなくても(404)、案内を出す', async ({ page }) => {
    await page.route(/\/detect\.js(\?.*)?$/, (route) => route.fulfill({ status: 404, body: 'not found' }));
    await page.goto('index.html');
    await expect(page.locator('#bootError')).toBeVisible();
  });
});
