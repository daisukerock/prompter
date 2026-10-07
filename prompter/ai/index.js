// AIサービスの切り替え口。画面側は、ここの関数だけを使う。
import { AIError, MESSAGES, TEST_UTTERANCE } from './common.js';

export { AIError };

export const PROVIDERS = {
  claude: {
    label: 'Claude',
    short: 'Claude',
    needsKey: true,
    keyHint: 'sk-ant-で始まるキー',
    keyUrl: 'https://platform.claude.com/',
    keySite: 'Claude Console',
    defaultModel: 'claude-sonnet-5-5',
    suggestions: [
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5(標準)' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5(速い・安い)' },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5(高性能)' },
    ],
    chatUrl: 'https://claude.ai/new',
    load: () => import('./claude.js'),
  },
  openai: {
    label: 'ChatGPT(OpenAI)',
    short: 'ChatGPT',
    needsKey: true,
    keyHint: 'sk-で始まるキー',
    keyUrl: 'https://platform.openai.com/api-keys',
    keySite: 'OpenAI Platform',
    defaultModel: 'gpt-5.6-luna',
    suggestions: [{ id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna(速い・安い)' }],
    chatUrl: 'https://chatgpt.com/',
    load: () => import('./openai.js'),
  },
  gemini: {
    label: 'Gemini(Google)',
    short: 'Gemini',
    needsKey: true,
    keyHint: 'AIzaで始まるキー',
    keyUrl: 'https://aistudio.google.com/apikey',
    keySite: 'Google AI Studio',
    defaultModel: 'gemini-3.5-flash-lite',
    suggestions: [
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite(速い・標準)' },
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash(高性能・遅め)' },
    ],
    // 「要点」(Google検索つき)に使うモデル。ボタンを押したときだけ動くので、性能を優先する
    defaultSummaryModel: 'gemini-3.5-flash',
    summaryModels: [
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash(高性能・標準)' },
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite(速い)' },
    ],
    chatUrl: 'https://gemini.google.com/app',
    load: () => import('./gemini.js'),
  },
  compatible: {
    label: 'OpenAI互換(上級者向け)',
    short: '互換AI',
    needsKey: false,
    needsBaseUrl: true,
    keyHint: '不要な場合は空欄',
    keyUrl: '',
    keySite: '',
    defaultModel: '',
    suggestions: [],
    chatUrl: 'https://claude.ai/new',
    load: () => import('./openai.js'),
  },
};

export function providerOf(cfg) {
  return PROVIDERS[cfg && cfg.provider] || null;
}

// 呼び出しに必要な設定がそろっているか
export function isReady(cfg) {
  const p = providerOf(cfg);
  if (!p) return false;
  if (p.needsKey && !String(cfg.apiKey || '').trim()) return false;
  if (p.needsBaseUrl && !String(cfg.baseUrl || '').trim()) return false;
  return !!String(cfg.model || '').trim();
}

async function adapter(cfg) {
  if (!isReady(cfg)) throw new AIError('config', MESSAGES.config);
  return providerOf(cfg).load();
}

function clean(cfg) {
  return { ...cfg, apiKey: String(cfg.apiKey || '').trim(), model: String(cfg.model || '').trim() };
}

// 待ち時間の上限(会議中は短く、接続テストと「詳しく」は長めに待つ)
const TIMEOUT = { analyze: 30000, explain: 45000, test: 60000, summary: 90000 };

// opts.onUsage(使った数) で、使ったトークン数を知らせる。どのサービス・モデルの分かを添える。
// 知らせる先で失敗しても、AIの結果は捨てない
function withUsage(cfg, model, opts) {
  const onUsage = opts.onUsage;
  if (typeof onUsage !== 'function') return opts;
  const name = String(model || '').trim().replace(/^models\//, '');
  return {
    ...opts,
    onUsage: (usage) => {
      if (!usage) return;
      try {
        onUsage({ ...usage, provider: cfg.provider, model: name });
      } catch (e) { /* 無視 */ }
    },
  };
}

// 発言から、用語と気をつけたい点を見つける
export async function analyze(cfg, input, opts = {}) {
  cfg = clean(cfg);
  return (await adapter(cfg)).analyze(cfg, input, withUsage(cfg, cfg.model, { timeoutMs: TIMEOUT.analyze, ...opts }));
}

// 1つの言葉を、もう少し詳しく説明する
export async function explain(cfg, term, quote, opts = {}) {
  cfg = clean(cfg);
  return (await adapter(cfg)).explain(cfg, term, quote, withUsage(cfg, cfg.model, { timeoutMs: TIMEOUT.explain, ...opts }));
}

// 「要点」(Google検索で確かめた3行の要点)を作れるか。いまはGeminiだけ
export function canSummarize(cfg) {
  return !!cfg && cfg.provider === 'gemini';
}

// 「要点」を作る。opts.onText(途中までの文) で、届いた分から表示できる
export async function summarize(cfg, term, quote, opts = {}) {
  cfg = clean(cfg);
  if (!canSummarize(cfg)) throw new AIError('config', '「要点」は、いまはGeminiで使えます。設定でGeminiを選んでください。');
  const options = withUsage(cfg, opts.model || cfg.model, { timeoutMs: TIMEOUT.summary, ...opts });
  return (await adapter(cfg)).summarize(cfg, term, quote, options);
}

export async function listModels(cfg) {
  cfg = clean(cfg);
  const p = providerOf(cfg);
  if (!p) throw new AIError('config', MESSAGES.config);
  if (p.needsKey && !cfg.apiKey) throw new AIError('config', '先にAPIキーを入れてください。');
  if (p.needsBaseUrl && !String(cfg.baseUrl || '').trim()) throw new AIError('config', '先に接続先URLを入れてください。');
  return (await p.load()).listModels(cfg);
}

// 短い例文で、実際に呼べるかを確かめる(使ったトークン数も返す)
export async function testConnection(cfg, opts = {}) {
  const started = Date.now();
  let usage = null;
  const result = await analyze(cfg, { context: [], utterance: TEST_UTTERANCE, exclude: [] }, {
    timeoutMs: TIMEOUT.test,
    onUsage: (u) => {
      usage = u;
      if (opts.onUsage) opts.onUsage(u);
    },
  });
  return { result, ms: Date.now() - started, usage };
}
