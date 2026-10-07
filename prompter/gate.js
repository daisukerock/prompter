// 送る前の振り分け(Jev)の決め方。画面には触らない関数だけを置く(テストしやすいように)
import { findCandidates } from './detect.js';
import { backoff, rateLimitWait } from './pacing.js';

// 振り分けの強さ。Jevの答え(「はい」である確率)のどちらかが、この値以上ならAIに送る
export const LEVELS = {
  more: 0.15, // 取りこぼしを減らす(よくAIに送る)
  normal: 0.3,
  save: 0.5, // 節約を優先
};
export const DEFAULT_LEVEL = 'normal';

export function threshold(level) {
  return Object.prototype.hasOwnProperty.call(LEVELS, level) ? LEVELS[level] : LEVELS[DEFAULT_LEVEL];
}

// AIに送るか。知らない言葉か、気をつけたい点の、どちらかがありそうなら送る
export function wantsAI(verdict, level) {
  return Math.max(verdict.terms, verdict.risks) >= threshold(level);
}

// 発言に出てくる英字の略語(小文字にして返す)。まだAIに送っていない略語があれば、Jevに聞かずに送る
export function acronymsIn(text) {
  return findCandidates(text).map((c) => c.term.toLowerCase());
}

// 設定を直すまで、Jevを使わないエラー(キーの誤り・残高不足など)
export const STOP_CODES = ['auth', 'permission', 'notfound', 'config', 'quota', 'badrequest'];
// つながらないのが、この回数続いたら知らせる
export const TROUBLE_AFTER = 3;

// halted: 止めた理由、trouble: つながらない理由、failures: 続けて失敗した回数、retryAt: 次にJevに聞く時刻
export function initialGate() {
  return { halted: '', trouble: '', failures: 0, retryAt: 0 };
}

// いまJevに聞けるか(止めていない・待ち時間が過ぎている)
export function canAsk(gate, now) {
  return !gate.halted && now >= gate.retryAt;
}

// Jevで失敗したあと。止めるエラーなら止め、そうでなければ、待ってからまた聞く(待つ間は、振り分けずにAIに送る)
export function afterFailure(gate, error, now) {
  const code = error && error.code;
  const message = (error && error.message) || 'Jevの呼び出しで、エラーが起きました。';
  if (STOP_CODES.includes(code)) return { ...gate, halted: message, failures: 0, retryAt: 0 };
  const failures = gate.failures + 1;
  const wait = code === 'ratelimit' ? rateLimitWait(error.retryAfterMs) : backoff(failures);
  return { ...gate, failures, retryAt: now + wait, trouble: failures >= TROUBLE_AFTER ? message : gate.trouble };
}

// うまく判定できたら、失敗の記録を消す
export function afterSuccess(gate) {
  return { ...gate, failures: 0, retryAt: 0, trouble: '' };
}
