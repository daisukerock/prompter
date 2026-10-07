// AIへ送る間隔と、たまった発言の扱い。画面には触らない関数だけを置く(テストしやすいように)

export const MIN_INTERVAL = 1500; // 送る間隔の最小値
export const MAX_INTERVAL = 15000; // 上限にかかったときに広げる、間隔の最大値
export const BATCH_MAX_CHARS = 360; // 1回に送る量の目安
const RATE_LIMIT_WAIT = 20000; // 上限にかかったとき、サービスが待ち時間を示さなければ、これだけ待つ

// 上限にかかったら、送る間隔を倍に広げる
export function widen(interval) {
  return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, interval) * 2);
}

// うまく送れたら、間隔を少しずつ元に戻す
export function relax(interval) {
  return Math.max(MIN_INTERVAL, Math.round(interval * 0.8));
}

// 上限にかかったときに待つ時間。サービスが示した時間を優先する(2秒〜2分)
export function rateLimitWait(retryAfterMs) {
  return Math.min(120000, Math.max(2000, retryAfterMs || RATE_LIMIT_WAIT));
}

// 通信の失敗が続いたときに待つ時間(5秒・10秒・20秒・40秒、最大60秒)
export function backoff(failures) {
  return Math.min(60000, 5000 * 2 ** Math.max(0, failures - 1));
}

// たまった発言のうち、新しいものから max 文字までを送る。入りきらない古い分は older で返す
export function takeBatch(pending, max = BATCH_MAX_CHARS) {
  let start = pending.length;
  let total = 0;
  while (start > 0) {
    const next = total + pending[start - 1].length;
    // 1文は必ず送る(長すぎる1文も、そのまま送る)
    if (start < pending.length && next > max) break;
    total = next;
    start--;
  }
  return { send: pending.slice(start), older: pending.slice(0, start) };
}
