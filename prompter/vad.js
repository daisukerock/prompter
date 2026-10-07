// 発言の区切りを、音の大きさで見つける(Whisperに、話しているところだけを送るため)。
// 周りの雑音の大きさ(直近数秒のうち、静かな方の音)を測り続け、それより十分大きい音を「話し声」とみなす。
// 画面には触らない関数だけを置く(テストしやすいように)
import { levelDb } from './audio.js';

export const VAD_DEFAULTS = {
  startMs: 100, // 話し声がこれだけ続いたら、発言の始まりとみなす
  endSilenceMs: 700, // これだけ静かになったら、発言の終わりとみなす
  keepSilenceMs: 300, // 終わりの静かな部分は、これだけ残す
  prerollMs: 300, // 始まりの前の音も、これだけ含める(言い始めが切れないように)
  softMaxMs: 12000, // これより長くなったら、少しでも静かになったところで区切る
  hardMaxMs: 20000, // これより長くなったら、そこで区切る
  minSpeechMs: 250, // 話し声がこれより短いかたまり(物音など)は捨てる
  marginDb: 10, // 雑音よりこれだけ大きければ、話し声とみなす
  minDb: -55, // これより小さい音は、話し声とみなさない
  noiseWindowMs: 6000, // 雑音の大きさを測る範囲
  quietStartDb: -60, // 測り始め(1秒未満)に仮定する雑音の大きさ
};

// 小さい方から1割の位置の値
function lowPercentile(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.1)];
}

// push(frame, ms) で、届いた音を順に渡す。発言が区切れたら { frames, ms, speechMs } を返す(なければ null)。
// flush() で、話している途中の分を区切って返す(止めるとき)
export function createSegmenter(opts = {}) {
  const o = { ...VAD_DEFAULTS, ...opts };
  const history = []; // 直近の音の大きさ { db, ms }
  let historyMs = 0;
  let before = []; // 話していない間の、直近の音 { frame, ms }(始まりの前の分として使う)
  let beforeMs = 0;
  let runMs = 0; // 話し声が続いている長さ(始まりを決める前)
  let seg = null; // 話している途中の発言 { parts: [{ frame, ms, speech }], ms, speechMs, silenceMs }

  function noiseDb() {
    if (historyMs < 1000) return Math.min(o.quietStartDb, history.length ? lowPercentile(history.map((h) => h.db)) : o.quietStartDb);
    return lowPercentile(history.map((h) => h.db));
  }

  function remember(db, ms) {
    history.push({ db, ms });
    historyMs += ms;
    while (history.length > 1 && historyMs - history[0].ms >= o.noiseWindowMs) historyMs -= history.shift().ms;
  }

  // 発言を閉じる。話し声が短すぎれば捨てる
  function close(trimSilence) {
    const s = seg;
    seg = null;
    if (!s || s.speechMs < o.minSpeechMs) return null;
    let drop = trimSilence ? Math.max(0, s.silenceMs - o.keepSilenceMs) : 0;
    while (drop > 0 && s.parts.length > 1 && !s.parts[s.parts.length - 1].speech && s.parts[s.parts.length - 1].ms <= drop) {
      const last = s.parts.pop();
      drop -= last.ms;
      s.ms -= last.ms;
    }
    return { frames: s.parts.map((p) => p.frame), ms: s.ms, speechMs: s.speechMs };
  }

  function push(frame, ms) {
    const db = levelDb(frame);
    const speech = db > Math.max(noiseDb() + o.marginDb, o.minDb);
    remember(db, ms);

    if (!seg) {
      before.push({ frame, ms, speech });
      beforeMs += ms;
      while (before.length > 1 && beforeMs - before[0].ms >= o.prerollMs + o.startMs) beforeMs -= before.shift().ms;
      runMs = speech ? runMs + ms : 0;
      if (runMs < o.startMs) return null;
      // 話し始め: 直前の音も含めて、発言を始める
      seg = { parts: before, ms: beforeMs, speechMs: runMs, silenceMs: 0 };
      before = [];
      beforeMs = 0;
      runMs = 0;
      return null;
    }

    seg.parts.push({ frame, ms, speech });
    seg.ms += ms;
    if (speech) {
      seg.speechMs += ms;
      seg.silenceMs = 0;
    } else {
      seg.silenceMs += ms;
    }
    if (seg.silenceMs >= o.endSilenceMs) return close(true);
    // 長すぎる発言は区切る(続きは、次の発言として受け取る)
    if (seg.ms >= o.hardMaxMs || (seg.ms >= o.softMaxMs && !speech)) {
      const out = close(false);
      seg = { parts: [], ms: 0, speechMs: 0, silenceMs: 0 };
      return out;
    }
    return null;
  }

  function flush() {
    const out = close(true);
    before = [];
    beforeMs = 0;
    runMs = 0;
    return out;
  }

  return {
    push,
    flush,
    get speaking() { return !!seg; },
  };
}
