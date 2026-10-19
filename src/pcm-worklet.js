// Mixes each input to mono and posts ~85 ms batches of Float32 PCM to the page.
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(4096);
    this.n = 0;
  }
  process(inputs) {
    const chans = inputs[0];
    if (!chans || !chans.length) return true;
    const frames = chans[0].length;
    for (let i = 0; i < frames; i++) {
      let s = 0;
      for (let c = 0; c < chans.length; c++) s += chans[c][i];
      this.buf[this.n++] = s / chans.length;
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(4096);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);

// Plays 16-bit stereo PCM posted by the page (one app's sound, desktop/app-audio.exe) at the context's rate. A ring of
// about 2.7 s; it waits for 50 ms before it starts and after each underrun, and drops the oldest past 1 s behind.
class PcmIn extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.rate = o.processorOptions.rate;
    this.step = this.rate / sampleRate;
    this.size = 1 << 17;
    this.l = new Float32Array(this.size);
    this.r = new Float32Array(this.size);
    this.w = 0; // frames written
    this.pos = 0; // read position, in frames (fractional)
    this.on = false;
    this.port.onmessage = (e) => {
      const b = e.data;
      const s = b.byteOffset % 2 ? new Int16Array(b.slice().buffer) : new Int16Array(b.buffer, b.byteOffset, b.byteLength >> 1);
      const m = this.size - 1;
      for (let i = 0; i + 1 < s.length; i += 2) {
        this.l[this.w & m] = s[i] / 32768;
        this.r[this.w & m] = s[i + 1] / 32768;
        this.w++;
      }
      if (this.w - this.pos > this.rate) this.pos = this.w - this.rate / 5;
    };
  }
  process(_inputs, outputs) {
    const [L, R] = outputs[0];
    const m = this.size - 1;
    if (!this.on && this.w - this.pos >= this.rate / 20) this.on = true;
    for (let i = 0; i < L.length; i++) {
      if (!this.on || this.w - this.pos < 2) {
        this.on = false;
        L[i] = 0;
        if (R) R[i] = 0;
        continue;
      }
      const j = Math.floor(this.pos);
      const f = this.pos - j;
      const a = j & m;
      const b = (j + 1) & m;
      L[i] = this.l[a] + (this.l[b] - this.l[a]) * f;
      if (R) R[i] = this.r[a] + (this.r[b] - this.r[a]) * f;
      this.pos += this.step;
    }
    return true;
  }
}
registerProcessor('pcm-in', PcmIn);
