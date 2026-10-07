// 送る前の振り分け(Jev)。AIとJevの応答は模擬する
import { test, expect, useProvider, say, card, tableRows } from './fixtures.js';
import { mockAI } from './mock-ai.js';

test.use({ viewport: { width: 390, height: 844 } });

const analyzeCalls = (log) => log.filter((l) => l.url.includes(':generateContent'));
const jevCalls = (log) => log.filter((l) => l.url.includes('/systemone'));

// GeminiとJev(ふだんの接続先の、OpenRouter経由)を設定して開く
function useJev(page, settings = {}, keys = { openrouter: 'sk-or-e2e' }) {
  return useProvider(page, 'gemini', 'AIza-e2e', { jev: true, ...settings }, keys);
}

// 送った発言の処理(Jevの判定と、AIへの送信)が終わるまで待つ
async function settled(page, log, jevCount) {
  await expect.poll(() => jevCalls(log).length).toBe(jevCount);
  await expect(page.locator('#busyBar')).not.toHaveClass(/is-on/);
}

test('あいさつや雑談はAIに送らず、知らない言葉や気をつけたい点がありそうな発言だけを送る', async ({ page }) => {
  const log = await mockAI(page);
  await useJev(page);
  await expect(page.locator('#aiToggle')).toHaveAttribute('title', /送る前に、Jevで振り分けています/);

  await say(page, 'お疲れさまです。今日は、いい天気ですね。');
  await settled(page, log, 1);
  const req = jevCalls(log)[0];
  expect(req.url).toBe('https://openrouter.ai/api/v1/systemone');
  expect(req.headers.authorization).toBe('Bearer sk-or-e2e');
  expect(req.body.state).toBe('お疲れさまです。今日は、いい天気ですね。');
  expect(req.body.model).toBe('jev-latest');
  expect(Object.keys(req.body.questions)).toEqual(['terms', 'risks']);
  expect(analyzeCalls(log)).toHaveLength(0);
  await expect(page.locator('#cards .card')).toHaveCount(0);

  await say(page, 'パーパス経営を、来月末までに浸透させたいです。');
  await expect(card(page, 'パーパス経営')).toBeVisible();
  await expect(card(page, '期限の確認')).toBeVisible();
  expect(jevCalls(log)).toHaveLength(2);
  expect(analyzeCalls(log)).toHaveLength(1);
  // AIには、前の発言も手がかりとして送る(Jevには、新しい発言だけ)
  expect(analyzeCalls(log)[0].body.contents[0].parts[0].text).toContain('お疲れさまです。');
  expect(jevCalls(log)[1].body.state).toBe('パーパス経営を、来月末までに浸透させたいです。');

  // 送らずに済んだ回数と、Jevで使ったトークンを出す
  await page.click('.tab[data-view="settings"]');
  const rows = await tableRows(page, '#usageSession');
  expect(rows).toContain('振り分け(Jev) | 2 | 300 | 4');
  await expect(page.locator('#usageSession')).toContainText('Jevの振り分けで、AIに送らずに済んだ発言: 1回(判定 2回のうち)。');
  await expect(page.locator('#usageToday')).toContainText('typesafe/jev-1.13');
});

test('まだAIに送っていない英字の略語があれば、Jevに聞かずにAIに送る', async ({ page }) => {
  // Jevは、どの発言も「送らなくてよい」と答える
  const log = await mockAI(page, { jev: () => ({ terms: 0.02, risks: 0.02 }) });
  await useJev(page);
  await say(page, 'KPIの話です。');
  await expect(card(page, 'KPI')).toBeVisible();
  expect(jevCalls(log)).toHaveLength(0);
  expect(analyzeCalls(log)).toHaveLength(1);

  // 一度送った略語は、Jevに任せる
  await say(page, 'KPIの話に戻ります。');
  await settled(page, log, 1);
  expect(analyzeCalls(log)).toHaveLength(1);

  // 「消す」と、また最初から扱う
  await page.click('#clearBtn');
  await expect(page.locator('#cards .card')).toHaveCount(0);
  await say(page, 'KPIの話です。');
  await expect.poll(() => analyzeCalls(log).length).toBe(2);
  await expect(card(page, 'KPI')).toBeVisible();
  expect(jevCalls(log)).toHaveLength(1);
});

test('オフのとき・キーがないときは、Jevに送らない(すべてAIに送る)', async ({ page }) => {
  const log = await mockAI(page, { jev: () => ({ terms: 0.02, risks: 0.02 }) });
  await useJev(page, { jev: false });
  await say(page, 'お疲れさまです。');
  await expect.poll(() => analyzeCalls(log).length).toBe(1);

  await useJev(page, {}, {});
  await say(page, 'お疲れさまです。');
  await expect.poll(() => analyzeCalls(log).length).toBe(2);
  await expect(page.locator('#aiToggle')).not.toHaveAttribute('title', /Jev/);
  expect(jevCalls(log)).toHaveLength(0);
});

test.describe('AIの上限で待ったあと', () => {
  test.use({ allowedErrors: [/status of 429/] });

  test('送らなくてよい発言だったときも、「待ってから再開します」の表示を消す', async ({ page }) => {
    const log = await mockAI(page, {
      geminiFail: [{ status: 429, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'retry later', details: [{ retryDelay: '2s' }] } } }],
    });
    await useJev(page);
    await say(page, 'パーパス経営の話です。');
    await expect(page.locator('#status')).toHaveText('利用上限か混雑のため、約2秒待ってから再開します。');
    await say(page, 'お疲れさまです。');
    await settled(page, log, 2);
    await expect(page.locator('#status')).toHaveText('');
    expect(analyzeCalls(log)).toHaveLength(1);
  });
});

test.describe('Jevのキーの誤り', () => {
  test.use({ allowedErrors: [/status of 401/] });

  test('Jevを止めて知らせ、発言は振り分けずにAIに送る。接続テストが通ると再開する', async ({ page }) => {
    const log = await mockAI(page, { jevFail: [{ status: 401, body: { detail: 'Invalid API key' } }] });
    await useJev(page);
    await say(page, 'パーパス経営の話です。');
    await expect(page.locator('#toast')).toContainText('Jevを止めました');
    // 判定できなかった発言も、AIには送る
    await expect(card(page, 'パーパス経営')).toBeVisible();
    await expect(page.locator('#aiToggle')).toContainText('AIオン');

    // 止めている間は、Jevに聞かずにAIに送る
    await say(page, 'お疲れさまです。');
    await expect.poll(() => analyzeCalls(log).length).toBe(2);
    expect(jevCalls(log)).toHaveLength(1);

    await page.click('.tab[data-view="settings"]');
    await expect(page.locator('#jevResult')).toHaveClass(/is-error/);
    await expect(page.locator('#jevResult')).toContainText('OpenRouterのAPIキーが正しくないようです');
    await page.click('#jevTestBtn');
    await expect(page.locator('#jevResult')).toContainText('つながりました');

    await page.click('.tab[data-view="live"]');
    await say(page, 'それでは、よろしくお願いいたします。');
    await settled(page, log, 4);
    expect(analyzeCalls(log)).toHaveLength(2);
  });
});

test.describe('Jevにつながらないとき', () => {
  test.use({ allowedErrors: [/net::ERR_FAILED/] });

  // ブラウザからの接続が許可されていないとき(CORS)も、ページからは同じ「つながらない」エラーに見える
  test('振り分けずにAIに送る', async ({ page }) => {
    const log = await mockAI(page, { jevFail: [{ abort: true }] });
    await useJev(page);
    await say(page, 'お疲れさまです。今日は、いい天気ですね。');
    // 判定できなかったので、AIに送る(取りこぼさないように)
    await expect.poll(() => analyzeCalls(log).length).toBe(1);
    await expect(page.locator('#busyBar')).not.toHaveClass(/is-on/);
    expect(jevCalls(log)).toHaveLength(1);
    // 1回だけなら、まだ知らせない(少し待ってから、また聞く)
    await expect(page.locator('#toast')).not.toContainText('Jev');
    await expect(page.locator('#aiToggle')).toContainText('AIオン');
  });
});

test('設定: 接続テストで、例文の判定と送るかどうかを出し、オン・強さ・キーを覚えておく', async ({ page }) => {
  const log = await mockAI(page, { jev: (text) => (text.includes('ステークホルダー') ? { terms: 0.93, risks: 0.4 } : { terms: 0.2, risks: 0.1 }) });
  await useProvider(page, 'gemini', 'AIza-e2e');
  await page.click('.tab[data-view="settings"]');
  await expect(page.locator('#jevEnabled')).not.toBeChecked();
  await expect(page.locator('#jevLevel')).toHaveValue('normal');
  // ふだんの接続先は、OpenRouter経由(TypeSafeは、ブラウザからの接続を受け付けないため)
  await expect(page.locator('#jevRouteSelect')).toHaveValue('openrouter');
  await expect(page.locator('#jevKeyLabel')).toHaveText('OpenRouterのAPIキー');
  await expect(page.locator('#jevKeyInput')).toHaveAttribute('placeholder', 'sk-or-で始まるキー');
  await expect(page.locator('#jevKeyNote a')).toHaveAttribute('href', 'https://openrouter.ai/settings/keys');

  await page.check('#jevEnabled');
  await expect(page.locator('#toast')).toContainText('OpenRouterのAPIキーを入れると、振り分けを始めます');
  await page.fill('#jevKeyInput', 'sk-or-typed');
  await page.click('#jevTestBtn');
  const result = page.locator('#jevResult');
  await expect(result).toHaveClass(/is-ok/);
  await expect(result).toContainText('つながりました');
  await expect(result).toContainText('「ステークホルダーとのコンセンサスが取れていないので、いったんペンディングです。」知らない言葉 93%・気をつけたい点 40% → AIに送ります');
  await expect(result).toContainText('「お疲れさまです。今日は、いい天気ですね。」知らない言葉 20%・気をつけたい点 10% → AIに送りません');
  // 例文ごとに、行を分けて出す
  expect((await result.textContent()).split('\n')).toHaveLength(4);
  await expect(result).toContainText('使ったトークン: 入力 300・出力 4');
  expect(jevCalls(log).map((c) => c.headers.authorization)).toEqual(['Bearer sk-or-typed', 'Bearer sk-or-typed']);
  expect(jevCalls(log).every((c) => c.url === 'https://openrouter.ai/api/v1/systemone')).toBe(true);

  // 強さを「取りこぼしを減らす」にすると、2つ目の例文も送る
  await page.selectOption('#jevLevel', 'more');
  await page.click('#jevTestBtn');
  await expect(result).toContainText('知らない言葉 20%・気をつけたい点 10% → AIに送ります');

  // 読み込み直しても、覚えている(キーは、AIのキーと同じ場所に保存する)
  await page.reload();
  await page.click('.tab[data-view="settings"]');
  await expect(page.locator('#jevEnabled')).toBeChecked();
  await expect(page.locator('#jevLevel')).toHaveValue('more');
  await expect(page.locator('#jevRouteSelect')).toHaveValue('openrouter');
  await expect(page.locator('#jevKeyInput')).toHaveValue('sk-or-typed');
  const keys = await page.evaluate(() => JSON.parse(localStorage.getItem('pl_keys')));
  expect(keys).toEqual({ gemini: 'AIza-e2e', openrouter: 'sk-or-typed' });

  // キーを消すと、振り分けない
  await page.click('#jevKeyClearBtn');
  await expect(page.locator('#toast')).toContainText('OpenRouterのAPIキーを削除しました');
  await expect(page.locator('#jevKeyInput')).toHaveValue('');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pl_keys')).openrouter)).toBe('');
  await page.click('.tab[data-view="live"]');
  await expect(page.locator('#aiToggle')).not.toHaveAttribute('title', /Jev/);
});

test('接続先を切り替えると、その接続先のキーを使う。以前に入れたTypeSafeのキーは残す', async ({ page }) => {
  const log = await mockAI(page);
  // 以前の版の設定(接続先の設定がなく、TypeSafeのキーだけがある)
  await useJev(page, {}, { jev: 'ts-old' });
  await expect(page.locator('#aiToggle')).not.toHaveAttribute('title', /Jev/);
  await page.click('.tab[data-view="settings"]');
  await expect(page.locator('#jevRouteSelect')).toHaveValue('openrouter');
  await expect(page.locator('#jevKeyInput')).toHaveValue('');

  await page.selectOption('#jevRouteSelect', 'typesafe');
  await expect(page.locator('#jevKeyLabel')).toHaveText('TypeSafeのAPIキー');
  await expect(page.locator('#jevKeyInput')).toHaveValue('ts-old');
  await expect(page.locator('#jevKeyNote a')).toHaveAttribute('href', 'https://console.typesafe.ai/');
  await page.click('.tab[data-view="live"]');
  await say(page, 'お疲れさまです。');
  await settled(page, log, 1);
  expect(jevCalls(log)[0].url).toBe('https://api.typesafe.ai/v1/systemone');
  expect(jevCalls(log)[0].headers.authorization).toBe('Bearer ts-old');

  // OpenRouterに戻してキーを入れると、OpenRouterに送る(TypeSafeのキーは消さない)
  await page.click('.tab[data-view="settings"]');
  await page.selectOption('#jevRouteSelect', 'openrouter');
  await expect(page.locator('#jevKeyInput')).toHaveValue('');
  await page.fill('#jevKeyInput', 'sk-or-new');
  await page.click('.tab[data-view="live"]');
  await say(page, 'それでは、よろしくお願いいたします。');
  await settled(page, log, 2);
  expect(jevCalls(log)[1].url).toBe('https://openrouter.ai/api/v1/systemone');
  expect(jevCalls(log)[1].headers.authorization).toBe('Bearer sk-or-new');
  const saved = await page.evaluate(() => ({ settings: JSON.parse(localStorage.getItem('pl_settings')), keys: JSON.parse(localStorage.getItem('pl_keys')) }));
  expect(saved.settings.jevRoute).toBe('openrouter');
  expect(saved.keys).toEqual({ gemini: 'AIza-e2e', jev: 'ts-old', openrouter: 'sk-or-new' });
});

test.describe('TypeSafe(直接)につながらないとき', () => {
  test.use({ allowedErrors: [/net::ERR_FAILED/] });

  // TypeSafeは、ブラウザからの接続を受け付けない(ページからは「つながらない」に見える)
  test('接続テストで、OpenRouter経由にするよう案内する', async ({ page }) => {
    await mockAI(page, { jevFail: [{ abort: true }, { abort: true }] });
    await useJev(page, { jevRoute: 'typesafe' }, { jev: 'ts-e2e' });
    await page.click('.tab[data-view="settings"]');
    await expect(page.locator('#jevRouteSelect')).toHaveValue('typesafe');
    await page.click('#jevTestBtn');
    await expect(page.locator('#jevResult')).toHaveClass(/is-error/);
    await expect(page.locator('#jevResult')).toHaveText('TypeSafeに接続できませんでした。TypeSafeは、ブラウザ(このアプリ)からの直接の接続を受け付けていないようです。接続先を「OpenRouter経由」にしてください。');
  });
});
