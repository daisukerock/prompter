// まだ広く定着していない言葉(新語・造語・流行語など)のカード
import { test, expect, useProvider, say, card } from './fixtures.js';
import { mockAI } from './mock-ai.js';

test.use({ viewport: { width: 390, height: 844 } });

test('まだ定着していない言葉にもカードを出し、新しい言葉か・意味が確かかを示す', async ({ page }) => {
  await mockAI(page);
  await useProvider(page, 'gemini', 'AIza-e2e');
  await say(page, 'パーパス経営とシン・業務改革について、KPIも決めたい。');

  const purpose = card(page, 'パーパス経営');
  await expect(purpose).toBeVisible();
  await expect(purpose.locator('.tag-new')).toHaveText('新しい言葉');
  await expect(purpose.locator('.tag-unsure')).toHaveCount(0);
  await expect(purpose.locator('.card-body')).toHaveText('企業の存在意義を軸に据えた経営の考え方');

  // 意味に自信がない語は、意味を作らずに「要確認」とし、確かめ方を添える
  const shin = card(page, 'シン・業務改革');
  await expect(shin.locator('.tag-new')).toHaveText('新しい言葉');
  await expect(shin.locator('.tag-unsure')).toHaveText('意味は要確認');
  await expect(shin.locator('.card-body')).toHaveText('意味は、まだはっきりしません。「要点」で、Google検索して確かめられます。');
  await expect(shin.getByRole('button', { name: '要点' })).toBeVisible();

  // ふつうの専門用語には、印を付けない
  await expect(card(page, 'KPI').locator('.tag-new, .tag-unsure')).toHaveCount(0);

  // 保存しても、読み込み直しても、印は残る
  await shin.getByRole('button', { name: '保存', exact: true }).click();
  await page.reload();
  await page.click('.tab[data-view=saved]');
  const saved = page.locator('#savedList .card').first();
  await expect(saved.locator('.tag-new')).toHaveText('新しい言葉');
  await expect(saved.locator('.tag-unsure')).toHaveText('意味は要確認');
});
