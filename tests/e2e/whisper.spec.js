// Whisperでの聞き取り。マイクは、合成した音(話す・黙る)に差し替え、Whisperの応答は模擬する
import { test, expect, useProvider, card } from './fixtures.js';
import { mockAI } from './mock-ai.js';

test.use({ viewport: { width: 390, height: 844 } });

// まねたマイク(window.__mic.speak(ミリ秒) で、その間だけ話し声らしい音を出す)と、まねた標準の聞き取り
function installFakeMic() {
  const mic = { calls: 0, deny: false };
  window.__mic = mic;
  navigator.mediaDevices.getUserMedia = async () => {
    mic.calls++;
    if (mic.deny) throw new DOMException('denied', 'NotAllowedError');
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 180;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gain).connect(dest);
    osc.start();
    await ctx.resume();
    mic.speak = (ms) => {
      const t = ctx.currentTime;
      gain.gain.setValueAtTime(0.3, t);
      gain.gain.setValueAtTime(0, t + ms / 1000);
    };
    return dest.stream;
  };

  const speech = { instances: [] };
  window.__speech = speech;
  class FakeRecognition {
    constructor() { speech.instances.push(this); }
    start() { setTimeout(() => this.onstart && this.onstart(), 10); }
    stop() { setTimeout(() => this.onend && this.onend(), 10); }
    abort() {}
    say(text) {
      const result = [{ transcript: text }];
      result.isFinal = true;
      if (this.onresult) this.onresult({ resultIndex: 0, results: [result] });
    }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
}

const whisperCalls = (log) => log.filter((l) => l.url.includes('/audio/transcriptions'));
const speak = (page, ms) => page.evaluate((m) => window.__mic.speak(m), ms);
const label = (page) => page.locator('#listenLabel');
const lines = (page) => page.locator('#transcript .line:not(.interim)');

// GeminiとGroqのキーを入れて開く
function useWhisper(page, settings = {}) {
  return useProvider(page, 'gemini', 'AIza-e2e', { sttHints: 'パーパス経営、シン・業務改革', ...settings }, { groq: 'gsk_e2e' });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installFakeMic);
});

test('話した区切りごとにWhisper(Groq)で文字にし、カードを出す。上限に合わせて間をあけて送る', async ({ page }) => {
  const texts = ['KPIの話です。', 'それでは、必ず今週中に回答します。'];
  const log = await mockAI(page, { whisper: (n) => ({ body: { text: texts[n - 1] || '', segments: [{ text: texts[n - 1] || '', no_speech_prob: 0.01, avg_logprob: -0.2, compression_ratio: 1.1 }] } }) });
  await useWhisper(page);
  await page.click('#listenBtn');
  await expect(label(page)).toHaveText('聞いています(押すと停止)');
  await expect(page.locator('#status')).toHaveText('聞いています…(Whisper・Groq。画面は点けたままにしてください)');

  await speak(page, 1200);
  await expect(page.locator('#interimLine')).toHaveText('…');
  await expect(lines(page)).toHaveText(['KPIの話です。']);
  await expect(card(page, 'KPI')).toBeVisible();
  const first = whisperCalls(log)[0];
  expect(first.url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
  expect(first.headers.authorization).toBe('Bearer gsk_e2e');
  expect(first.fields.model).toBe('whisper-large-v3');
  expect(first.fields.language).toBe('ja');
  expect(first.fields.response_format).toBe('verbose_json');
  expect(first.fields.prompt).toBe('用語: パーパス経営、シン・業務改革。');
  expect(first.fields.file.type).toBe('audio/wav');
  expect(first.fields.file.riff).toBe('RIFF');
  // 1.2秒の話し声に、前後の少しを足した長さ(16kHz・16bit)
  const seconds = (first.fields.file.size - 44) / 32000;
  expect(seconds).toBeGreaterThan(1.3);
  expect(seconds).toBeLessThan(2.2);

  await speak(page, 1000);
  await expect(lines(page)).toHaveText(['KPIの話です。', 'それでは、必ず今週中に回答します。'], { timeout: 15_000 });
  const second = whisperCalls(log)[1];
  expect(second.at - first.at).toBeGreaterThanOrEqual(4900);
  // カードに出た言葉と、直前の発言も、ヒントにする
  expect(second.fields.prompt).toBe('用語: パーパス経営、シン・業務改革、KPI。KPIの話です。');

  await page.click('#listenBtn');
  await expect(label(page)).toHaveText('聞き取り開始');
  await expect(page.locator('#interimLine')).toBeHidden();
  await page.click('.tab[data-view="settings"]');
  await expect(page.locator('#usageSession')).toContainText(/聞き取り\(Whisper\): whisper-large-v3 2回・音声 \d秒/);
});

test.describe('Whisperが使えないとき', () => {
  test.use({ allowedErrors: [/status of 401|net::ERR_FAILED/] });

  test('キーの誤りなら、標準の聞き取りに切り替えて、止まらずに続ける', async ({ page }) => {
    const log = await mockAI(page, { whisper: () => ({ status: 401, body: { error: { message: 'Invalid API Key' } } }) });
    await useWhisper(page);
    await page.click('#listenBtn');
    await expect(page.locator('#status')).toContainText('Whisper・Groq');
    await speak(page, 1000);
    await expect(page.locator('#toast')).toContainText('標準の聞き取りに切り替えました');
    await expect(page.locator('#status')).toHaveText('聞いています…(標準の聞き取り。Whisperは止めています)');
    await expect(label(page)).toHaveText('聞いています(押すと停止)');
    await page.evaluate(() => window.__speech.instances.at(-1).say('NDAの話です。'));
    await expect(lines(page)).toHaveText(['NDAの話です。']);
    expect(whisperCalls(log)).toHaveLength(1);

    await page.click('.tab[data-view="settings"]');
    await expect(page.locator('#sttResult')).toContainText('Whisperを止めています。GroqのAPIキーが正しくないようです');
  });

  test('一度もつながらないまま失敗が続けば(ブラウザから使えない場合など)、標準の聞き取りに切り替える', async ({ page }) => {
    const log = await mockAI(page, { whisper: () => ({ abort: true }) });
    await useWhisper(page);
    await page.click('#listenBtn');
    await expect(page.locator('#status')).toContainText('Whisper・Groq');
    await speak(page, 1000);
    await expect(page.locator('#status')).toContainText('約5秒後に、もう一度送ります。');
    await expect(page.locator('#status')).toHaveText('聞いています…(標準の聞き取り。Whisperは止めています)', { timeout: 15_000 });
    expect(whisperCalls(log)).toHaveLength(2);
    expect(await page.evaluate(() => window.__speech.instances.length)).toBe(1);
  });
});

test('マイクの許可がなければ、止めて理由を出す', async ({ page }) => {
  await mockAI(page);
  await useWhisper(page);
  await page.evaluate(() => { window.__mic.deny = true; });
  await page.click('#listenBtn');
  await expect(page.locator('#status')).toHaveText('マイクが許可されていません。ブラウザの設定で許可してください。');
  await expect(label(page)).toHaveText('聞き取り開始');
});

test('キーがなければ、標準の聞き取りを使う', async ({ page }) => {
  await mockAI(page);
  await useProvider(page, 'gemini', 'AIza-e2e');
  await page.click('#listenBtn');
  await expect(page.locator('#status')).toHaveText('聞いています…(画面は点けたままにしてください)');
  expect(await page.evaluate(() => window.__mic.calls)).toBe(0);
  expect(await page.evaluate(() => window.__speech.instances.length)).toBe(1);
});

test('設定: 方法・キー・モデル・ヒントを覚え、聞き取りテストで確かめる。OpenAIのキーはChatGPTと同じ', async ({ page }) => {
  const log = await mockAI(page, { whisper: () => ({ body: { text: '' } }) });
  await useProvider(page, 'openai', 'sk-shared');
  await page.click('.tab[data-view="settings"]');
  await expect(page.locator('#sttSelect')).toHaveValue('groq');
  await expect(page.locator('#sttKeyLabel')).toHaveText('GroqのAPIキー');
  await expect(page.locator('#sttModelSelect')).toHaveValue('whisper-large-v3');

  await page.fill('#sttKeyInput', 'gsk_typed');
  await page.selectOption('#sttModelSelect', 'whisper-large-v3-turbo');
  await page.fill('#sttHints', 'EBPM\nパーパス経営');
  await page.locator('#sttHints').blur();
  await page.click('#sttTestBtn');
  await expect(page.locator('#sttResult')).toHaveClass(/is-ok/);
  await expect(page.locator('#sttResult')).toContainText('つながりました');
  const test1 = whisperCalls(log)[0];
  expect(test1.headers.authorization).toBe('Bearer gsk_typed');
  expect(test1.fields.model).toBe('whisper-large-v3-turbo');
  expect(test1.fields.file.size).toBe(44 + 32000);

  // OpenAIを選ぶと、ChatGPTと同じキーが出る
  await page.selectOption('#sttSelect', 'openai');
  await expect(page.locator('#sttKeyLabel')).toHaveText('OpenAIのAPIキー');
  await expect(page.locator('#sttKeyInput')).toHaveValue('sk-shared');
  await expect(page.locator('#sttModelSelect')).toHaveValue('gpt-transcribe');
  // 標準を選ぶと、キーなどの欄は隠す
  await page.selectOption('#sttSelect', 'browser');
  await expect(page.locator('#sttKeyRow')).toBeHidden();
  await expect(page.locator('#sttTestRow')).toBeHidden();

  await page.selectOption('#sttSelect', 'groq');
  await page.reload();
  await page.click('.tab[data-view="settings"]');
  await expect(page.locator('#sttSelect')).toHaveValue('groq');
  await expect(page.locator('#sttKeyInput')).toHaveValue('gsk_typed');
  await expect(page.locator('#sttModelSelect')).toHaveValue('whisper-large-v3-turbo');
  await expect(page.locator('#sttHints')).toHaveValue('EBPM\nパーパス経営');
  const keys = await page.evaluate(() => JSON.parse(localStorage.getItem('pl_keys')));
  expect(keys).toEqual({ openai: 'sk-shared', groq: 'gsk_typed' });
});
