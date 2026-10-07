// マイクの音を、約40ミリ秒ずつまとめて画面側に渡す(AudioWorklet。capture.js から読み込む)
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    // sampleRate は、AudioWorklet の中で使える値(マイクの周波数)
    this.size = Math.max(128, Math.round(sampleRate * 0.04));
    this.buf = new Float32Array(this.size);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.size) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(this.size);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
