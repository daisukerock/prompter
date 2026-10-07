// Whisper(Groq・OpenAI)への送り方と、結果・エラーの読み方を、fetchを差し替えて確かめる(実際には通信しない)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as Whisper from '../../prompter/ai/whisper.js';
import { encodeWav } from '../../prompter/audio.js';

let calls = [];
let responder = null;

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

globalThis.fetch = (url, init = {}) => {
  const form = init.body;
  const fields = {};
  for (const [k, v] of form.entries()) fields[k] = v;
  const call = { url: String(url), method: init.method, headers: new Headers(init.headers), fields };
  calls.push(call);
  return new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
    if (init.signal) {
      if (init.signal.aborted) return abort();
      init.signal.addEventListener('abort', abort, { once: true });
    }
    Promise.resolve().then(() => responder(call, calls.length)).then(resolve, reject);
  });
};

beforeEach(() => {
  calls = [];
  responder = null;
});

const GROQ = { provider: 'groq', apiKey: 'gsk_test', model: 'whisper-large-v3' };
const OPENAI = { provider: 'openai', apiKey: 'sk-test', model: 'gpt-transcribe' };
const wav = (seconds) => encodeWav(new Float32Array(seconds * 16000));

test('ヒント: よく出る言葉(重複なし、長すぎない分)と、直前の発言の終わり', () => {
  assert.equal(Whisper.buildPrompt({ hints: ['KPI', ' EBPM ', 'KPI', ''], previous: '前の発言です。' }), '用語: KPI、EBPM。前の発言です。');
  assert.equal(Whisper.buildPrompt({}), '');
  const long = Whisper.buildPrompt({ hints: Array.from({ length: 50 }, (_, i) => '専門用語' + i), previous: 'あ'.repeat(100) });
  assert.ok(long.length <= 200);
  assert.ok(long.endsWith('あ'.repeat(60)));
  assert.ok(!long.includes('あ'.repeat(61)));
});

test('結果を整える: 決まり文句・音の説明・同じ文字の繰り返し・ヒントのくり返しは捨てる', () => {
  for (const t of ['ご視聴ありがとうございました', 'ご視聴ありがとうございました。', '最後までご覧いただきありがとうございました!', 'チャンネル登録お願いします',
    '字幕:山田', 'Thanks for watching!', '(拍手)', '[音楽]', '♪〜', 'ああああ', '。。。', '  ']) {
    assert.equal(Whisper.cleanTranscript(t), '', t);
  }
  const prompt = '用語: パーパス経営、シン・業務改革。前の発言です。';
  assert.equal(Whisper.cleanTranscript('パーパス経営、シン・業務改革', prompt), '', 'ヒントをそのまま返しただけ');
  assert.equal(Whisper.cleanTranscript('パーパス経営', prompt), 'パーパス経営', '短い語は、本当に話したこともあるので残す');
  assert.equal(Whisper.cleanTranscript('  KPIの  資料を共有します。 '), 'KPIの 資料を共有します。');
  assert.equal(Whisper.cleanTranscript('ご視聴ありがとうございました。では次の議題です。'), 'ご視聴ありがとうございました。では次の議題です。', '文の一部なら残す');
});

test('Groq: whisper-large-v3 に、日本語・ヒント・詳しい結果の指定を付けて、WAVを送る', async () => {
  responder = () => json(200, { text: 'KPIの話です。', segments: [{ text: 'KPIの話です。', no_speech_prob: 0.01, avg_logprob: -0.2, compression_ratio: 1.1 }] });
  const usage = [];
  const text = await Whisper.transcribe(GROQ, wav(2), { prompt: '用語: KPI。', onUsage: (u) => usage.push(u) });
  assert.equal(text, 'KPIの話です。');
  const c = calls[0];
  assert.equal(c.url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(c.method, 'POST');
  assert.equal(c.headers.get('authorization'), 'Bearer gsk_test');
  assert.equal(c.headers.get('content-type'), null, '区切りは、ブラウザに任せる');
  assert.equal(c.fields.model, 'whisper-large-v3');
  assert.equal(c.fields.language, 'ja');
  assert.equal(c.fields.response_format, 'verbose_json');
  assert.equal(c.fields.temperature, '0');
  assert.equal(c.fields.prompt, '用語: KPI。');
  assert.equal(c.fields.file.type, 'audio/wav');
  assert.equal(c.fields.file.name, 'speech.wav');
  assert.equal(c.fields.file.size, 44 + 2 * 32000);
  assert.deepEqual(usage, [{ provider: 'groq', model: 'whisper-large-v3', seconds: 2 }]);
});

test('Groq: 話していない区切り・繰り返しの作り話は除く', async () => {
  responder = () => json(200, {
    text: 'ご視聴ありがとうございました 契約は来週です。',
    segments: [
      { text: 'ご視聴ありがとうございました', no_speech_prob: 0.9, avg_logprob: -1.4, compression_ratio: 1.0 },
      { text: 'はいはいはいはいはいはい', no_speech_prob: 0.1, avg_logprob: -0.3, compression_ratio: 3.1 },
      { text: '契約は来週です。', no_speech_prob: 0.05, avg_logprob: -0.3, compression_ratio: 1.2 },
    ],
  });
  assert.equal(await Whisper.transcribe(GROQ, wav(1)), '契約は来週です。');
});

test('OpenAI: gpt-transcribe には、ふつうの結果(json)を頼む。キーはChatGPTと同じ', async () => {
  responder = () => json(200, { text: 'PoCを進めます。' });
  assert.equal(await Whisper.transcribe(OPENAI, wav(1), { prompt: 'p' }), 'PoCを進めます。');
  assert.equal(calls[0].url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(calls[0].headers.get('authorization'), 'Bearer sk-test');
  assert.equal(calls[0].fields.model, 'gpt-transcribe');
  assert.equal(calls[0].fields.response_format, 'json');
});

test('受け付けない指定があれば、ヒントなどを外して1回だけ送り直し、次からは外して送る', async () => {
  responder = (call, n) => (n === 1 ? json(400, { error: { message: "Unsupported parameter: 'prompt'" } }) : json(200, { text: 'こんにちは。' }));
  const cfg = { provider: 'openai', apiKey: 'sk-test', model: 'gpt-plain-test' };
  assert.equal(await Whisper.transcribe(cfg, wav(1), { prompt: 'ヒント' }), 'こんにちは。');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].fields.prompt, undefined);
  assert.equal(calls[1].fields.temperature, undefined);
  await Whisper.transcribe(cfg, wav(1), { prompt: 'ヒント' });
  assert.equal(calls.length, 3);
  assert.equal(calls[2].fields.prompt, undefined);
});

test('エラーを分ける: キーの誤り・モデルなし・混雑(待ち時間)・1日の上限・大きすぎ・不具合', async () => {
  const cases = [
    [401, { error: { message: 'Invalid API Key' } }, {}, { code: 'auth', message: /GroqのAPIキーが正しくない/ }],
    [404, { error: { message: 'model not found' } }, {}, { code: 'notfound', message: /モデルが見つかりません/ }],
    [429, { error: { message: 'Rate limit reached ... requests per minute (RPM): Limit 20. Please try again in 1m2.5s.', code: 'rate_limit_exceeded' } }, {}, { code: 'ratelimit', retryAfterMs: 62500 }],
    [429, { error: { message: 'slow down' } }, { 'retry-after': '3' }, { code: 'ratelimit', retryAfterMs: 3000 }],
    [429, { error: { message: 'Rate limit reached ... on audio seconds per day (ASD): Limit 28800, Used 28795', code: 'rate_limit_exceeded' } }, {}, { code: 'quota', message: /1日の上限/ }],
    [413, { error: { message: 'Request Entity Too Large' } }, {}, { code: 'badrequest', message: /大きすぎ/ }],
    [500, { error: { message: 'oops' } }, {}, { code: 'server' }],
  ];
  for (const [status, body, headers, expected] of cases) {
    responder = () => json(status, body, headers);
    await assert.rejects(Whisper.transcribe({ ...GROQ, model: 'whisper-err-' + status }, wav(1)), expected, String(status));
  }
});

test('つながらない(ブラウザが止めた場合も)・時間切れ・キーなし', async () => {
  responder = () => Promise.reject(new TypeError('Failed to fetch'));
  await assert.rejects(Whisper.transcribe(GROQ, wav(1)), { code: 'network', message: /Groqに接続できませんでした/ });
  responder = () => new Promise(() => {});
  await assert.rejects(Whisper.transcribe(GROQ, wav(1), { timeoutMs: 50 }), { code: 'timeout' });
  const before = calls.length;
  await assert.rejects(Whisper.transcribe({ ...GROQ, apiKey: ' ' }, wav(1)), { code: 'config', message: /GroqのAPIキーが入っていません/ });
  await assert.rejects(Whisper.transcribe({ provider: 'browser', apiKey: 'x', model: 'm' }, wav(1)), { code: 'config' });
  assert.equal(calls.length, before, '設定が足りなければ、送らない');
});

test('接続テスト: 1秒の無音を送って、呼べるかを確かめる', async () => {
  responder = () => json(200, { text: '' });
  const usage = [];
  const out = await Whisper.testConnection(GROQ, { onUsage: (u) => usage.push(u) });
  assert.ok(out.ms >= 0);
  assert.equal(calls[0].fields.file.size, 44 + 32000);
  assert.equal(usage[0].seconds, 1);
});
