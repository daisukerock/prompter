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
const TIMEOUT = { analyze: 30000, explain: 45000, test: 60000 };

// 発言から、用語と気をつけたい点を見つける
export async function analyze(cfg, input, opts = {}) {
  cfg = clean(cfg);
  return (await adapter(cfg)).analyze(cfg, input, { timeoutMs: TIMEOUT.analyze, ...opts });
}

// 1つの言葉を、もう少し詳しく説明する
export async function explain(cfg, term, quote) {
  cfg = clean(cfg);
  return (await adapter(cfg)).explain(cfg, term, quote, { timeoutMs: TIMEOUT.explain });
}

export async function listModels(cfg) {
  cfg = clean(cfg);
  const p = providerOf(cfg);
  if (!p) throw new AIError('config', MESSAGES.config);
  if (p.needsKey && !cfg.apiKey) throw new AIError('config', '先にAPIキーを入れてください。');
  if (p.needsBaseUrl && !String(cfg.baseUrl || '').trim()) throw new AIError('config', '先に接続先URLを入れてください。');
  return (await p.load()).listModels(cfg);
}

// 短い例文で、実際に呼べるかを確かめる
export async function testConnection(cfg) {
  const started = Date.now();
  const result = await analyze(cfg, { context: [], utterance: TEST_UTTERANCE, exclude: [] }, { timeoutMs: TIMEOUT.test });
  return { result, ms: Date.now() - started };
}
