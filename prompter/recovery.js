// 音声認識が止まったときの立て直し方。画面には触らない関数だけを置く(テストしやすいように)

export const HEALTHY_RUN_MS = 3000; // これより長く動いてから止まったなら、普通の区切りとみなす
export const SHOW_RECOVERING_MS = 1500; // 立て直しがこれより長引いたら、画面に出す(普通の区切りで、ちらつかないように)
export const WARN_AFTER = 5; // すぐ止まるのが、この回数続いたら、強めに知らせる

// 止まったあと、次に始めるまでの待ち時間と、すぐ止まった回数(続けて)。
// 普通の区切りなら、すぐ始め直す。すぐ止まるのが続くなら、0.5秒・1秒・2秒…(最大8秒)と間をあける
export function nextRestart(ranMs, failures) {
  if (ranMs >= HEALTHY_RUN_MS) return { delay: 0, failures: 0 };
  const next = failures + 1;
  return { delay: Math.min(8000, 500 * 2 ** (next - 1)), failures: next };
}

// 立て直しても直らないエラー(聞き取りを止めて、理由を知らせる)
export const FATAL_ERRORS = {
  'not-allowed': 'マイクが許可されていません。ブラウザの設定で許可してください。',
  'service-not-allowed': 'この端末では、音声認識を使えませんでした(iPhoneでは、設定で音声入力やSiriがオフだと使えないことがあります)。',
  'audio-capture': 'マイクを使えませんでした。ほかのアプリがマイクを使っていないか、確かめてください。',
  'language-not-supported': 'この端末では、日本語の音声認識を使えません。',
};

// 立て直している間に出す文
export function recoveringMessage(lastError, failures) {
  const why = lastError === 'network' ? 'ネットワークにつながらないため、' : '';
  return failures >= WARN_AFTER
    ? why + '聞き取りがうまく続きません。マイクやネットワークを確かめてください(立て直しは続けています)。'
    : why + '聞き取りが途切れたので、立て直しています…';
}
