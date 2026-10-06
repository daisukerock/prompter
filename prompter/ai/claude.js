// Claude(Anthropic)への接続。公式SDK(@anthropic-ai/sdk)をブラウザ用にまとめたものを使う。
// 利用者が入れたAPIキーで、ブラウザから直接Claude APIを呼ぶ。
import {
  AIError, MESSAGES, RESULT_SCHEMA, SYSTEM_ANALYZE, SYSTEM_EXPLAIN,
  buildAnalyzeInput, buildExplainInput, normalizeResult, withDetail,
} from './common.js';

let sdkPromise = null;
function loadSdk() {
  // Claudeを選んだときだけ読み込む
  if (!sdkPromise) {
    sdkPromise = import('../vendor/anthropic-sdk.js').catch(() => {
      sdkPromise = null;
      throw new AIError('config', 'このブラウザでは、Claudeの接続部品を読み込めませんでした。iOS 16.4以降か、最新のブラウザで使ってください。');
    });
  }
  return sdkPromise;
}

let cached = { apiKey: null, client: null };
async function getClient(apiKey) {
  const { Anthropic } = await loadSdk();
  if (cached.apiKey !== apiKey) {
    cached = {
      apiKey,
      client: new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 1, timeout: 30000 }),
    };
  }
  return cached.client;
}

// effort(考える量)を指定できるモデルと、拒否されたときの自動切り替え(fallbacks)を使えるモデル
function capabilities(model) {
  return {
    effort: /^claude-(opus|sonnet|fable|mythos)-(4-[6-9]|5)/.test(model),
    fallbacks: /^claude-(sonnet-5-5|opus-5-5|opus-5|fable-5-1)$/.test(model),
  };
}

// 任意の指定(effort・fallbacks)を受け付けなかったモデルは、次回から付けない
const plainModels = new Set();

function buildParams({ model, system, user, maxTokens, format, withOptional }) {
  const caps = capabilities(model);
  const params = {
    model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
  };
  const outputConfig = {};
  if (format) outputConfig.format = format;
  // 会議中は速さを優先して、考える量を少なめにする
  if (withOptional && caps.effort) outputConfig.effort = 'low';
  if (Object.keys(outputConfig).length) params.output_config = outputConfig;
  if (withOptional && caps.fallbacks) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  return params;
}

function toAIError(e, Anthropic) {
  if (e instanceof AIError) return e;
  if (e instanceof Anthropic.AuthenticationError) return new AIError('auth', MESSAGES.auth);
  if (e instanceof Anthropic.PermissionDeniedError) return new AIError('permission', MESSAGES.permission);
  if (e instanceof Anthropic.NotFoundError) return new AIError('notfound', MESSAGES.notfound);
  if (e instanceof Anthropic.RateLimitError) return new AIError('ratelimit', MESSAGES.ratelimit);
  if (e instanceof Anthropic.BadRequestError) {
    return new AIError('badrequest', withDetail(MESSAGES.badrequest, apiMessage(e)));
  }
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new AIError('timeout', MESSAGES.timeout);
  if (e instanceof Anthropic.APIConnectionError) return new AIError('network', MESSAGES.network);
  if (e instanceof Anthropic.InternalServerError) return new AIError('server', MESSAGES.server);
  if (e instanceof Anthropic.APIError) {
    if (e.status >= 500) return new AIError('server', MESSAGES.server);
    return new AIError('badrequest', withDetail(MESSAGES.badrequest, apiMessage(e)));
  }
  if (e instanceof Anthropic.AnthropicError) return new AIError('parse', MESSAGES.parse);
  return new AIError('unknown', withDetail(MESSAGES.unknown, e && e.message));
}

function apiMessage(e) {
  return (e.error && e.error.error && e.error.error.message) || e.message;
}

async function send(cfg, { system, user, maxTokens, format }) {
  const { Anthropic } = await loadSdk();
  const client = await getClient(cfg.apiKey);
  const caps = capabilities(cfg.model);
  const run = (withOptional) =>
    client.beta.messages.create(buildParams({ model: cfg.model, system, user, maxTokens, format, withOptional }));

  const withOptional = !plainModels.has(cfg.model);
  let message;
  try {
    message = await run(withOptional);
  } catch (e) {
    const optionalRejected = withOptional && (caps.effort || caps.fallbacks) &&
      e instanceof Anthropic.BadRequestError && /effort|fallback|beta|output_config/i.test(apiMessage(e));
    if (!optionalRejected) throw toAIError(e, Anthropic);
    plainModels.add(cfg.model);
    try {
      message = await run(false);
    } catch (e2) {
      throw toAIError(e2, Anthropic);
    }
  }

  // 本文を読む前に、止まった理由を確かめる
  if (message.stop_reason === 'refusal') throw new AIError('refusal', MESSAGES.refusal);
  if (message.stop_reason === 'max_tokens') throw new AIError('parse', 'AIの回答が、途中で切れました。');
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

let formatPromise = null;
async function resultFormat() {
  if (!formatPromise) {
    formatPromise = loadSdk().then(({ betaJSONSchemaOutputFormat }) => betaJSONSchemaOutputFormat(RESULT_SCHEMA));
  }
  return formatPromise;
}

export async function analyze(cfg, input) {
  const format = await resultFormat();
  const text = await send(cfg, {
    system: SYSTEM_ANALYZE,
    user: buildAnalyzeInput(input),
    maxTokens: 8000,
    format,
  });
  let parsed;
  try {
    parsed = format.parse(text);
  } catch (e) {
    throw new AIError('parse', MESSAGES.parse);
  }
  return normalizeResult(parsed);
}

export async function explain(cfg, term, quote) {
  const text = await send(cfg, {
    system: SYSTEM_EXPLAIN,
    user: buildExplainInput(term, quote),
    maxTokens: 4000,
  });
  return text.trim();
}

export async function listModels(cfg) {
  const { Anthropic } = await loadSdk();
  const client = await getClient(cfg.apiKey);
  const models = [];
  try {
    for await (const m of client.models.list()) models.push({ id: m.id, label: m.display_name || m.id });
  } catch (e) {
    throw toAIError(e, Anthropic);
  }
  return models;
}
