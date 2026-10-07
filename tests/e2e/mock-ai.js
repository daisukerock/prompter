// AIサービス(Claude・ChatGPT・Gemini)と、Jev(TypeSafe)、Whisper(Groq・OpenAI)の応答を模擬する。実際には通信しない。
// 発言に含まれる語を、決まった意味で返し、使ったトークン数も添える
export const MEANINGS = {
  EBPM: ['証拠に基づく政策立案', 'データなどの根拠を政策に生かす考え方'],
  KPI: ['重要業績評価指標', '目標の達成度を測る数値の指標'],
  PoC: ['概念実証', '本格導入の前に小さく試すこと'],
  NDA: ['秘密保持契約', '取引で知った情報を外に漏らさない約束'],
  SLA: ['サービス品質保証', 'サービスの水準について結ぶ約束'],
  RAG: ['検索拡張生成', '資料を検索して、その内容を根拠にAIが答える方式'],
  'トランプ大統領の関税': ['', '米国大統領が輸入品に課す関税と、その政策'],
};

// まだ広く定着していない語(sure: 意味に自信があるか)
export const NEW_WORDS = {
  'パーパス経営': { full: '', meaning: '企業の存在意義を軸に据えた経営の考え方', sure: true },
  'シン・業務改革': { full: '', meaning: '', sure: false },
};

export function analyzeFake(userText) {
  const utter = (userText.match(/<utterance>\n([\s\S]*?)\n<\/utterance>/) || [])[1] || '';
  const exclude = ((userText.match(/<exclude>([\s\S]*?)<\/exclude>/) || [])[1] || '').split('、').map((x) => x.toLowerCase());
  const said = (t) => utter.includes(t) && !exclude.includes(t.toLowerCase());
  // まだ定着していない語を優先し、最大4件
  const terms = [
    ...Object.entries(NEW_WORDS).filter(([t]) => said(t)).map(([term, w]) => ({ term, full: w.full, meaning: w.meaning, kind: 'new', sure: w.sure })),
    ...Object.entries(MEANINGS).filter(([t]) => said(t)).map(([term, [full, meaning]]) => ({ term, full, meaning, kind: 'established', sure: true })),
  ].slice(0, 4);
  const risks = [];
  if (utter.includes('必ず')) risks.push({ label: '約束の言質', level: 'red', tip: 'その場で約束せず、持ち帰って確認する', quote: '必ず今週中に回答' });
  const due = utter.match(/今週中|来月末/);
  if (due) risks.push({ label: '期限の確認', level: 'yellow', tip: '期限と担当を、その場で確認する', quote: due[0] });
  return { terms, risks };
}

// Jevの判定: AIの模擬が何かを見つける発言なら、高い確率を返す
export function jevFake(text) {
  const found = analyzeFake('<utterance>\n' + text + '\n</utterance>\n<exclude>なし</exclude>');
  return { terms: found.terms.length ? 0.94 : 0.03, risks: found.risks.length ? 0.88 : 0.05 };
}

const explainFake = (text) => ((text.match(/言葉: (.+)/) || [])[1] || 'この言葉') + 'は、会議でよく使う言葉です。ここでは、目標の達成度を測る数値を指します。';

export const SUMMARY_LINES = [
  '何の話: 米国が輸入品に課す追加関税の政策。\n',
  'いまの状況: 2026年10月時点で、主要国との交渉が続いている(模擬)。\n',
  '注目点: 自社の輸出入品目が対象かどうか。',
];

// 要点1回分: 入力 120+1500(検索結果)・出力 90+200(思考)、検索1回
function summaryChunks() {
  const chunks = SUMMARY_LINES.map((text) => ({ candidates: [{ content: { parts: [{ text }] } }] }));
  chunks[0].usageMetadata = { promptTokenCount: 120, candidatesTokenCount: 20, thoughtsTokenCount: 200 };
  chunks.push({
    candidates: [{
      finishReason: 'STOP',
      groundingMetadata: {
        webSearchQueries: ['トランプ 関税 現状'],
        groundingChunks: [
          { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/a', title: 'nikkei.com' } },
          { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/b', title: 'jetro.go.jp' } },
        ],
        searchEntryPoint: {
          renderedContent: '<style>.chip{display:inline-block;padding:6px 12px;border-radius:16px;border:1px solid #ccc;font:14px sans-serif;color:#333;text-decoration:none}</style>'
            + '<div><a class="chip" href="https://www.google.com/search?q=x">トランプ 関税 現状</a></div>',
        },
      },
    }],
    usageMetadata: { promptTokenCount: 120, toolUsePromptTokenCount: 1500, candidatesTokenCount: 90, thoughtsTokenCount: 200, totalTokenCount: 1910 },
  });
  return chunks.map((o) => 'data: ' + JSON.stringify(o) + '\r\n\r\n').join('');
}

// opts.geminiUsage: 自動判定1回で使った数(既定: 入力800・出力50)
// opts.summaryFailFirst: 要点の1回目を、混雑(503)で失敗させる
// opts.claudeStatus: Claudeへの送信を、この状態番号で失敗させる
// opts.geminiFail: Geminiの自動判定を、前から順にこの応答で失敗させる([{ status, body }] か [{ abort: true }])
// opts.jev: Jevの判定(発言 → { terms, risks })。既定は jevFake
// opts.jevFail: Jevを、前から順にこの応答で失敗させる([{ status, body }] か [{ abort: true }]。
//   ブラウザからの接続が許可されていないとき(CORS)も、ページからは abort と同じエラーに見える)
// 送られてきた multipart の各項目を読む(file は、大きさと種類だけ)
export function multipartFields(buffer) {
  const raw = buffer.toString('latin1');
  const boundary = raw.slice(0, raw.indexOf('\r\n'));
  const fields = {};
  for (const part of raw.split(boundary).slice(1, -1)) {
    const end = part.indexOf('\r\n\r\n');
    const head = part.slice(0, end);
    const value = part.slice(end + 4, -2);
    const name = (head.match(/name="([^"]+)"/) || [])[1];
    if (!name) continue;
    fields[name] = /filename=/.test(head)
      ? { size: value.length, type: (head.match(/Content-Type: ([^\r]+)/i) || [])[1], name: (head.match(/filename="([^"]+)"/) || [])[1], riff: value.slice(0, 4) }
      : Buffer.from(value, 'latin1').toString('utf8');
  }
  return fields;
}

// opts.whisper: Whisperの応答。(n回目, 送られた項目) → { status, body } か { abort: true }。既定は { text: '' }
export async function mockAI(page, opts = {}) {
  const log = [];
  const state = { summaryFailed: false, geminiFail: (opts.geminiFail || []).slice(), jevFail: (opts.jevFail || []).slice() };
  const geminiUsage = opts.geminiUsage || { promptTokenCount: 800, candidatesTokenCount: 50, totalTokenCount: 850 };
  let whisperCalls = 0;
  await page.route(/https:\/\/(api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com|api\.typesafe\.ai|api\.groq\.com)\/.*/, async (route) => {
    const req = route.request();
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': req.headers()['access-control-request-headers'] || '*',
    };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const url = req.url();
    if (url.includes('/audio/transcriptions')) {
      const fields = multipartFields(req.postDataBuffer());
      whisperCalls++;
      log.push({ url, method: req.method(), headers: req.headers(), fields, at: Date.now() });
      const r = opts.whisper ? opts.whisper(whisperCalls, fields) : { status: 200, body: { text: '' } };
      if (r.abort) return route.abort('failed');
      return route.fulfill({ status: r.status || 200, headers: { ...cors, 'content-type': 'application/json', ...(r.headers || {}) }, body: JSON.stringify(r.body) });
    }
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    log.push({ url, method: req.method(), headers: req.headers(), body, at: Date.now() });
    const reply = (status, obj) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(obj) });

    if (url.includes('api.anthropic.com')) {
      if (opts.claudeStatus) {
        return reply(opts.claudeStatus, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
      }
      if (url.includes('/v1/models')) {
        return reply(200, {
          data: [
            { type: 'model', id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', created_at: '2026-09-01T00:00:00Z' },
            { type: 'model', id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', created_at: '2025-10-01T00:00:00Z' },
          ],
          has_more: false, first_id: 'claude-sonnet-5-5', last_id: 'claude-haiku-4-5',
        });
      }
      const user = body.messages[0].content;
      const text = body.output_config && body.output_config.format ? JSON.stringify(analyzeFake(user)) : explainFake(user);
      return reply(200, {
        id: 'msg_e2e', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 50 },
      });
    }

    if (url.includes('api.openai.com')) {
      // 使った数は返さない(返さない接続先の確認用)
      const user = body.messages[1].content;
      const content = body.response_format ? JSON.stringify(analyzeFake(user)) : explainFake(user);
      return reply(200, { choices: [{ message: { content }, finish_reason: 'stop' }] });
    }

    if (url.includes('api.typesafe.ai')) {
      const fail = state.jevFail.shift();
      if (fail && fail.abort) return route.abort('failed');
      if (fail) return reply(fail.status, fail.body);
      const verdict = (opts.jev || jevFake)(body.state);
      return reply(200, {
        model: 'jev-1.13.0',
        answers: { terms: { type: 'noul', noul: verdict.terms }, risks: { type: 'noul', noul: verdict.risks } },
        usage: { input_tokens: 150, output_tokens: 2 },
      });
    }

    if (url.includes(':streamGenerateContent')) {
      if (opts.summaryFailFirst && !state.summaryFailed) {
        state.summaryFailed = true;
        return reply(503, { error: { code: 503, message: 'overloaded' } });
      }
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/event-stream' }, body: summaryChunks() });
    }
    if (url.includes(':generateContent')) {
      const fail = state.geminiFail.shift();
      if (fail && fail.abort) return route.abort('failed');
      if (fail) return reply(fail.status, fail.body);
      const user = body.contents[0].parts[0].text;
      const json = body.generationConfig && body.generationConfig.responseMimeType === 'application/json';
      const text = json ? JSON.stringify(analyzeFake(user)) : explainFake(user);
      return reply(200, { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: geminiUsage });
    }
    return reply(404, { error: { message: 'not mocked: ' + url } });
  });
  return log;
}
