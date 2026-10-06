// 各AIサービスへの送り方を、fetchを差し替えて確かめる(実際には通信しない)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as AI from '../../prompter/ai/index.js';

const RESULT = {
  terms: [{ term: 'KPI', full: '重要業績評価指標', meaning: '目標の達成度を測る指標' }],
  risks: [{ label: '期限の確認', level: 'yellow', tip: '期限と担当を確認する', quote: '来週までに' }],
};

let calls = [];
let responder = null;

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

globalThis.fetch = (url, init = {}) => {
  const call = {
    url: String(url),
    method: init.method || 'GET',
    headers: new Headers(init.headers),
    body: init.body ? JSON.parse(init.body) : null,
  };
  calls.push(call);
  // 本物のfetchと同じく、中断されたら AbortError で失敗させる
  return new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
    if (init.signal) {
      if (init.signal.aborted) return abort();
      init.signal.addEventListener('abort', abort, { once: true });
    }
    Promise.resolve().then(() => responder(call, calls.length)).then(resolve, reject);
  });
};

const never = () => new Promise(() => {});

beforeEach(() => {
  calls = [];
  responder = null;
});

function claudeMessage(text, extra = {}) {
  return {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
    content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text }],
    stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 20 },
    ...extra,
  };
}

const input = { context: ['前の文'], utterance: '来週までにKPIの資料を', exclude: ['NDA'] };

test('準備ができているかの判定', () => {
  assert.equal(AI.isReady({ provider: 'claude', apiKey: '', model: 'claude-sonnet-5-5' }), false);
  assert.equal(AI.isReady({ provider: 'claude', apiKey: 'k', model: 'claude-sonnet-5-5' }), true);
  assert.equal(AI.isReady({ provider: 'compatible', apiKey: '', model: 'llama3', baseUrl: '' }), false);
  assert.equal(AI.isReady({ provider: 'compatible', apiKey: '', model: 'llama3', baseUrl: 'http://localhost:11434/v1' }), true);
  assert.equal(AI.isReady({ provider: 'unknown', apiKey: 'k', model: 'm' }), false);
});

test('Claude: 公式SDKで、構造化出力・effort・fallbacksを付けて送る', async () => {
  responder = () => json(200, claudeMessage(JSON.stringify(RESULT)));
  const out = await AI.analyze({ provider: 'claude', apiKey: 'sk-ant-test', model: 'claude-sonnet-5-5' }, input);
  assert.deepEqual(out, RESULT);
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.url, 'https://api.anthropic.com/v1/messages?beta=true');
  assert.equal(c.headers.get('x-api-key'), 'sk-ant-test');
  assert.equal(c.headers.get('anthropic-dangerous-direct-browser-access'), 'true');
  assert.match(c.headers.get('anthropic-beta'), /server-side-fallback-2026-07-01/);
  assert.equal(c.body.model, 'claude-sonnet-5-5');
  assert.equal(c.body.fallbacks, 'default');
  assert.equal(c.body.output_config.effort, 'low');
  assert.equal(c.body.output_config.format.type, 'json_schema');
  assert.equal(c.body.output_config.format.schema.additionalProperties, false);
  assert.deepEqual(c.body.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(c.body.betas, undefined);
  assert.equal(c.body.thinking, undefined);
  assert.match(c.body.messages[0].content, /<utterance>\n来週までにKPIの資料を\n<\/utterance>/);
});

test('Claude: Haiku 4.5には、effortとfallbacksを付けない', async () => {
  responder = () => json(200, claudeMessage(JSON.stringify(RESULT)));
  await AI.analyze({ provider: 'claude', apiKey: 'sk-ant-test', model: 'claude-haiku-4-5' }, input);
  const c = calls[0];
  assert.equal(c.body.model, 'claude-haiku-4-5');
  assert.equal(c.body.output_config.effort, undefined);
  assert.equal(c.body.output_config.format.type, 'json_schema');
  assert.equal(c.body.fallbacks, undefined);
  assert.equal(c.headers.get('anthropic-beta'), null);
});

test('Claude: effortなどを受け付けないと言われたら、外して1回だけ送り直す', async () => {
  responder = (call, n) => (n === 1
    ? json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'output_config.effort: not supported' } })
    : json(200, claudeMessage(JSON.stringify(RESULT))));
  const out = await AI.analyze({ provider: 'claude', apiKey: 'k', model: 'claude-opus-5-5' }, input);
  assert.deepEqual(out, RESULT);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.output_config.effort, undefined);
  assert.equal(calls[1].body.fallbacks, undefined);
  assert.equal(calls[1].body.output_config.format.type, 'json_schema');
});

test('Claude: キーの誤り・拒否・途中切れを、利用者向けのエラーにする', async () => {
  const cfg = { provider: 'claude', apiKey: 'bad', model: 'claude-sonnet-5-5' };
  responder = () => json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
  await assert.rejects(AI.analyze(cfg, input), (e) => e.code === 'auth');

  responder = () => json(200, claudeMessage('', { stop_reason: 'refusal' }));
  await assert.rejects(AI.analyze(cfg, input), (e) => e.code === 'refusal');

  responder = () => json(200, claudeMessage('{"terms":[', { stop_reason: 'max_tokens' }));
  await assert.rejects(AI.analyze(cfg, input), (e) => e.code === 'parse');

  responder = () => json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low' } });
  await assert.rejects(AI.analyze(cfg, input), (e) => e.code === 'badrequest' && /credit balance/.test(e.message));
});

test('Claude: 詳しい説明と、モデル一覧', async () => {
  responder = (call) => (call.url.includes('/v1/models')
    ? json(200, {
      data: [{ type: 'model', id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', created_at: '2026-09-01T00:00:00Z' }],
      has_more: false, first_id: 'claude-sonnet-5-5', last_id: 'claude-sonnet-5-5',
    })
    : json(200, claudeMessage('  KPIは、目標の達成度を測る指標です。  ')));
  const cfg = { provider: 'claude', apiKey: 'k', model: 'claude-sonnet-5-5' };
  assert.equal(await AI.explain(cfg, 'KPI', '来週までにKPIの資料を'), 'KPIは、目標の達成度を測る指標です。');
  assert.equal(calls[0].body.output_config.format, undefined);
  assert.match(calls[0].body.messages[0].content, /言葉: KPI/);
  assert.deepEqual(await AI.listModels(cfg), [{ id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' }]);
});

test('OpenAI: JSONモードと、考える量を指定して送る', async () => {
  responder = () => json(200, { choices: [{ message: { content: JSON.stringify(RESULT) }, finish_reason: 'stop' }] });
  const out = await AI.analyze({ provider: 'openai', apiKey: 'sk-test', model: 'gpt-5.6-luna' }, input);
  assert.deepEqual(out, RESULT);
  const c = calls[0];
  assert.equal(c.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(c.headers.get('authorization'), 'Bearer sk-test');
  assert.deepEqual(c.body.response_format, { type: 'json_object' });
  assert.equal(c.body.reasoning_effort, 'low');
  assert.equal(c.body.messages[0].role, 'system');
});

test('OpenAI: 受け付けない指定があれば、外して送り直す', async () => {
  responder = (call, n) => (n === 1
    ? json(400, { error: { message: "Unsupported parameter: 'reasoning_effort'" } })
    : json(200, { choices: [{ message: { content: JSON.stringify(RESULT) }, finish_reason: 'stop' }] }));
  await AI.analyze({ provider: 'openai', apiKey: 'k', model: 'gpt-5.6-test' }, input);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.reasoning_effort, undefined);
  assert.equal(calls[1].body.response_format, undefined);
});

test('OpenAI互換: 接続先URLを使い、キーが空なら認証ヘッダーを付けない', async () => {
  responder = () => json(200, { choices: [{ message: { content: '```json\n{"terms":[],"risks":[]}\n```' }, finish_reason: 'stop' }] });
  const out = await AI.analyze({ provider: 'compatible', apiKey: '', model: 'llama3', baseUrl: 'http://localhost:11434/v1/' }, input);
  assert.deepEqual(out, { terms: [], risks: [] });
  assert.equal(calls[0].url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(calls[0].headers.get('authorization'), null);
  assert.equal(calls[0].body.reasoning_effort, undefined);
});

test('OpenAI: キーの誤りと、モデル一覧の絞り込み', async () => {
  responder = () => json(401, { error: { message: 'Incorrect API key provided' } });
  await assert.rejects(AI.analyze({ provider: 'openai', apiKey: 'bad', model: 'gpt-5.6-luna' }, input), (e) => e.code === 'auth');
  responder = () => json(200, { data: [{ id: 'gpt-5.6-luna' }, { id: 'text-embedding-3-small' }, { id: 'gpt-realtime' }, { id: 'o4-mini' }] });
  const models = await AI.listModels({ provider: 'openai', apiKey: 'k', model: '' });
  assert.deepEqual(models.map((m) => m.id), ['gpt-5.6-luna', 'o4-mini']);
});

test('Gemini: JSONの形と考える量を指定し、考えた過程は読まない', async () => {
  responder = () => json(200, {
    candidates: [{
      content: { parts: [{ text: '考え中…', thought: true }, { text: JSON.stringify(RESULT) }] },
      finishReason: 'STOP',
    }],
  });
  const out = await AI.analyze({ provider: 'gemini', apiKey: 'AIza-test', model: 'models/gemini-3.5-flash' }, input);
  assert.deepEqual(out, RESULT);
  const c = calls[0];
  assert.equal(c.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent');
  assert.equal(c.headers.get('x-goog-api-key'), 'AIza-test');
  assert.equal(c.body.generationConfig.responseMimeType, 'application/json');
  assert.equal(c.body.generationConfig.responseJsonSchema.type, 'object');
  assert.deepEqual(c.body.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
  assert.ok(c.body.systemInstruction.parts[0].text.includes('プロンプター'));
});

test('Gemini: 安全のために止まったら、拒否として扱う。モデル一覧はgeminiだけ', async () => {
  responder = () => json(200, { candidates: [{ finishReason: 'SAFETY' }] });
  await assert.rejects(AI.analyze({ provider: 'gemini', apiKey: 'k', model: 'gemini-3.5-flash' }, input), (e) => e.code === 'refusal');
  responder = () => json(200, {
    models: [
      { name: 'models/gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
    ],
  });
  assert.deepEqual(await AI.listModels({ provider: 'gemini', apiKey: 'k', model: '' }), [{ id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' }]);
});

test('Gemini: Flash-Liteは考える量を最小にする', async () => {
  responder = () => json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(RESULT) }] }, finishReason: 'STOP' }] });
  await AI.analyze({ provider: 'gemini', apiKey: 'k', model: 'gemini-3.5-flash-lite' }, input);
  assert.deepEqual(calls[0].body.generationConfig.thinkingConfig, { thinkingLevel: 'minimal' });
  assert.equal(AI.PROVIDERS.gemini.defaultModel, 'gemini-3.5-flash-lite');
});

test('応答が遅すぎるときは、時間切れのエラーにして、速いモデルを案内する', async () => {
  responder = never;
  for (const cfg of [
    { provider: 'gemini', apiKey: 'k', model: 'gemini-3.5-flash' },
    { provider: 'openai', apiKey: 'k', model: 'gpt-5.6-luna' },
    { provider: 'claude', apiKey: 'k', model: 'claude-haiku-4-5' },
  ]) {
    await assert.rejects(
      AI.analyze(cfg, input, { timeoutMs: 50 }),
      (e) => e.code === 'timeout' && /Flash-Lite/.test(e.message),
      cfg.provider,
    );
  }
});

// SSE(少しずつ届く応答)を作る
function sse(chunks, status = 200) {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    start(c) {
      chunks.forEach((obj) => c.enqueue(enc.encode('data: ' + JSON.stringify(obj) + '\r\n\r\n')));
      c.close();
    },
  }), { status, headers: { 'content-type': 'text/event-stream' } });
}

test('Gemini 要点: Google検索つきで、少しずつ受け取り、情報源と検索候補を返す', async () => {
  responder = () => sse([
    { candidates: [{ content: { parts: [{ text: '考え中', thought: true }, { text: '何の話: 米国の関税政策。\n' }] } }] },
    { candidates: [{ content: { parts: [{ text: 'いまの状況: 2026年10月時点で…\n注目点: 交渉の行方' }] } }] },
    { candidates: [{
      finishReason: 'STOP',
      groundingMetadata: {
        webSearchQueries: ['トランプ 関税 現状'],
        groundingChunks: [
          { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/a', title: 'example.com' } },
          { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/b', title: 'example.com' } },
          { web: { uri: 'javascript:alert(1)', title: 'bad' } },
          { web: { uri: 'https://news.example.jp/x', title: 'news.example.jp' } },
        ],
        searchEntryPoint: { renderedContent: '<style>.c{}</style><div class="c">Google</div>' },
      },
    }] },
  ]);
  const seen = [];
  const out = await AI.summarize({ provider: 'gemini', apiKey: 'AIza-k', model: 'gemini-3.5-flash-lite' }, 'トランプ大統領の関税', '関税はどうなってる', {
    model: 'gemini-3.5-flash', today: '2026-10-07', onText: (t) => seen.push(t),
  });
  const c = calls[0];
  assert.equal(c.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse');
  assert.equal(c.headers.get('x-goog-api-key'), 'AIza-k');
  assert.deepEqual(c.body.tools, [{ google_search: {} }]);
  assert.deepEqual(c.body.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
  assert.match(c.body.contents[0].parts[0].text, /話題: トランプ大統領の関税[\s\S]*今日の日付: 2026-10-07/);
  assert.ok(c.body.systemInstruction.parts[0].text.includes('Google検索'));
  assert.equal(seen.length, 2, '届いた分ずつ知らせる');
  assert.ok(seen[0].startsWith('何の話'));
  assert.equal(out.text, '何の話: 米国の関税政策。\nいまの状況: 2026年10月時点で…\n注目点: 交渉の行方');
  assert.deepEqual(out.sources.map((s) => s.title), ['example.com', 'news.example.jp']);
  assert.deepEqual(out.queries, ['トランプ 関税 現状']);
  assert.match(out.suggestionHtml, /Google/);
  assert.equal(out.model, 'gemini-3.5-flash');
});

test('Gemini 要点: エラー・拒否・時間切れを、利用者向けのエラーにする', async () => {
  const cfg = { provider: 'gemini', apiKey: 'k', model: 'gemini-3.5-flash-lite' };
  responder = () => json(429, { error: { code: 429, message: 'Resource exhausted' } });
  await assert.rejects(AI.summarize(cfg, 'X', ''), (e) => e.code === 'ratelimit');

  responder = () => sse([{ error: { code: 503, message: 'overloaded' } }]);
  await assert.rejects(AI.summarize(cfg, 'X', ''), (e) => e.code === 'server');

  responder = () => sse([{ candidates: [{ finishReason: 'SAFETY' }] }]);
  await assert.rejects(AI.summarize(cfg, 'X', ''), (e) => e.code === 'refusal');

  responder = never;
  await assert.rejects(AI.summarize(cfg, 'X', '', { timeoutMs: 50 }), (e) => e.code === 'timeout');
});

test('要点はGeminiだけ(ほかのサービスでは、呼ばずに案内する)', async () => {
  responder = () => { throw new Error('呼ばれてはいけない'); };
  assert.equal(AI.canSummarize({ provider: 'gemini' }), true);
  assert.equal(AI.canSummarize({ provider: 'claude' }), false);
  await assert.rejects(AI.summarize({ provider: 'claude', apiKey: 'k', model: 'claude-sonnet-5-5' }, 'X', ''), (e) => e.code === 'config');
  assert.equal(calls.length, 0);
});

test('通信できないときは、ネットワークのエラーにする', async () => {
  responder = () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(AI.analyze({ provider: 'gemini', apiKey: 'k', model: 'gemini-3.5-flash' }, input), (e) => e.code === 'network');
});

test('設定が足りないときは、呼ばずにエラーにする', async () => {
  responder = () => { throw new Error('呼ばれてはいけない'); };
  await assert.rejects(AI.analyze({ provider: 'claude', apiKey: '', model: 'claude-sonnet-5-5' }, input), (e) => e.code === 'config');
  assert.equal(calls.length, 0);
});
