// マイクの音を受け取り、発言ごとに区切って渡す(Whisperで聞き取るとき)。
// 区切った発言は、16kHzの音 { samples, ms } にして onSegment に渡す
import { concat, downsample } from './audio.js';
import { createSegmenter } from './vad.js';

// この端末で、マイクの音を取り込めるか
export function captureSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia
    && window.AudioWorkletNode && (window.AudioContext || window.webkitAudioContext));
}

// マイクを開く。onSpeaking(話しているか) / onLost()(マイクが止まった) も知らせる。
// iPhoneでは、音の処理(AudioContext)を押した操作の中で始める必要があるので、最初の await より前に作る
export async function openCapture({ workletUrl, onSegment, onSpeaking, onLost }) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const resumed = ctx.resume().catch(() => {});
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    await ctx.audioWorklet.addModule(workletUrl);
    await resumed;
    // マイクを開いたあとに止まっていることがある(iPhone)。動かなければ、使えない扱いにする
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    if (ctx.state !== 'running') throw new Error('音の処理を始められませんでした');
  } catch (e) {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
    throw e;
  }

  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm-capture');
  // 音を出さずに、処理だけを続けさせる(スピーカーには流さない)
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(node);
  node.connect(mute);
  mute.connect(ctx.destination);

  const segmenter = createSegmenter();
  let speaking = false;
  let closed = false;
  let frames = 0;
  const emit = (seg) => {
    if (seg) onSegment({ samples: downsample(concat(seg.frames), ctx.sampleRate), ms: seg.ms });
  };
  node.port.onmessage = (e) => {
    if (closed) return;
    frames++;
    const frame = e.data;
    emit(segmenter.push(frame, (frame.length / ctx.sampleRate) * 1000));
    if (segmenter.speaking !== speaking) {
      speaking = segmenter.speaking;
      if (onSpeaking) onSpeaking(speaking);
    }
  };
  stream.getAudioTracks().forEach((t) => t.addEventListener('ended', () => {
    if (!closed && onLost) onLost();
  }));

  return {
    // 受け取った音のかたまりの数(音が届いているかの確認用)
    get frames() {
      return frames;
    },
    // マイクが生きているか(電話の着信などで、止められることがある)
    get live() {
      return !closed && stream.getAudioTracks().some((t) => t.readyState === 'live');
    },
    // 止まっていた音の処理を、動かし直す(画面に戻ったとき)。動いていれば true
    async resume() {
      try { await ctx.resume(); } catch (e) { /* 無視 */ }
      return ctx.state === 'running';
    },
    // 止める。話している途中の分も、区切って渡す
    stop() {
      if (closed) return;
      emit(segmenter.flush());
      closed = true;
      node.port.onmessage = null;
      try {
        source.disconnect();
        node.disconnect();
        mute.disconnect();
      } catch (e) { /* 無視 */ }
      stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});
      if (speaking && onSpeaking) onSpeaking(false);
    },
  };
}
