// Claude・ChatGPT: 設定→接続テスト→カード→詳しく→保存。キーの誤り
import { test, expect, say } from './fixtures.js';
import { mockAI } from './mock-ai.js';

test.describe('Claude', () => {
  test.use({ viewport: { width: 1180, height: 820 } });

  test('モデル一覧→接続テスト→カード→詳しく→保存→状態→削除', async ({ page }) => {
    const log = await mockAI(page);
    await page.goto('index.html');
    await page.click('.tab[data-view=settings]');
    await expect(page.locator('#modelInput')).toHaveValue('claude-sonnet-5-5');
    await expect(page.locator('#summaryRow')).toBeHidden();
    await page.fill('#keyInput', 'sk-ant-e2e-test');
    await page.click('#modelsBtn');
    await expect(page.locator('#modelNote')).toContainText('2件のモデル');
    await page.click('#testBtn');
    await expect(page.locator('#testResult')).toHaveClass(/is-ok/);
    await expect(page.locator('#testResult')).toContainText('使ったトークン: 入力 100・出力 50。');

    await page.click('.tab[data-view=live]');
    await say(page, '今回のEBPMの進め方について、KPIの設定をお願いしたいです。');
    await say(page, '契約条件についてはNDAを結んだうえで、必ず今週中に回答をお願いします。');
    await expect.poll(() => page.locator('#cards .card').count()).toBeGreaterThanOrEqual(4);
    const req = log.filter((l) => l.url.includes('/v1/messages')).pop();
    expect(req.headers['x-api-key']).toBe('sk-ant-e2e-test');
    expect(req.body.output_config.effort).toBe('low');
    await expect(page.locator('#cards').getByRole('button', { name: '要点' })).toHaveCount(0);

    const kpi = page.locator('#cards .card', { has: page.locator('.card-title', { hasText: /^KPI$/ }) });
    await kpi.getByRole('button', { name: '詳しく' }).click();
    await expect(kpi.locator('.card-detail')).toContainText('会議でよく使う言葉');
    await kpi.getByRole('button', { name: '保存', exact: true }).click();
    await page.click('.tab[data-view=saved]');
    await expect(page.locator('#savedList')).toContainText('会議でよく使う言葉');
    await page.getByRole('button', { name: '調べたにする' }).click();
    await expect(page.locator('#savedList .status-pill')).toHaveText('調べた');
    await page.locator('#savedList').getByRole('button', { name: '削除', exact: true }).click();
    await expect(page.locator('#savedCount')).toHaveText('0');
  });
});

test.describe('キーの誤り', () => {
  test.use({ viewport: { width: 390, height: 844 }, allowedErrors: [/status of 401/] });

  test('AIを止めて簡易判定で続け、その後は送らない', async ({ page }) => {
    const log = await mockAI(page, { claudeStatus: 401 });
    await page.goto('index.html');
    await page.click('.tab[data-view=settings]');
    await page.fill('#keyInput', 'sk-ant-bad');
    await page.click('.tab[data-view=live]');
    await say(page, 'PoCは必ず来月末までに終えます。');
    await expect(page.locator('#aiToggle')).toHaveText('AI停止中');
    await expect(page.locator('#status')).toContainText('APIキーが正しくない');
    // AIで確かめられなかった文は、簡易判定で拾う
    await expect(page.locator('#cards .card.risk-red')).toHaveCount(1);
    const sent = log.length;
    await say(page, 'もう一文。');
    await page.waitForTimeout(2000);
    expect(log.length).toBe(sent);
  });
});

test.describe('ChatGPT', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('JSONモードで送り、使った数を返さない接続先ではトークンを出さない', async ({ page }) => {
    const log = await mockAI(page);
    await page.goto('index.html');
    await page.click('.tab[data-view=settings]');
    await page.selectOption('#providerSelect', 'openai');
    await page.fill('#keyInput', 'sk-e2e');
    await page.click('.tab[data-view=live]');
    await say(page, 'RAGを使ったPoCを、来月末までに進めます。');
    await expect(page.locator('#cards .card-title').filter({ hasText: /^(RAG|PoC)$/ })).toHaveCount(2);
    const req = log.find((l) => l.url.includes('api.openai.com/v1/chat/completions'));
    expect(req.headers.authorization).toBe('Bearer sk-e2e');
    expect(req.body.response_format).toEqual({ type: 'json_object' });
    expect(req.body.reasoning_effort).toBe('low');
    await expect(page.locator('#usageChip')).toBeHidden();
  });
});
