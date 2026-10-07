// 音声の扱い。マイクの音を、Whisperに送る形(16kHz・16bit・1チャンネルのWAV)にする。
// 画面には触らない関数だけを置く(テストしやすいように)

export const TARGET_RATE = 16000;

// 音の大きさ(dBFS。無音に近いほど小さい値。最大は0)
export function levelDb(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  const rms = frame.length ? Math.sqrt(sum / frame.length) : 0;
  return rms > 1e-6 ? 20 * Math.log10(rms) : -120;
}

// いくつかに分かれて届いた音を、1つにつなぐ
export function concat(frames) {
  const out = new Float32Array(frames.reduce((n, f) => n + f.length, 0));
  let at = 0;
  for (const f of frames) {
    out.set(f, at);
    at += f.length;
  }
  return out;
}

// fromRate の音を toRate に変える。区間ごとの平均をとって間引くので、高い音が折り返して濁りにくい
export function downsample(input, fromRate, toRate = TARGET_RATE) {
  if (fromRate === toRate) return Float32Array.from(input);
  if (fromRate < toRate) throw new Error('downsample: 元の周波数が低すぎます');
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

// 16bit・1チャンネルのWAV(バイト列)にする
export function encodeWav(samples, sampleRate = TARGET_RATE) {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const text = (at, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt の長さ
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 1チャンネル
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // 1秒あたりのバイト数
  view.setUint16(32, 2, true); // 1サンプルのバイト数
  view.setUint16(34, 16, true); // 16bit
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(bytes);
}

// 無音のWAV(接続テスト用)
export function silenceWav(seconds, sampleRate = TARGET_RATE) {
  return encodeWav(new Float32Array(Math.round(seconds * sampleRate)), sampleRate);
}
