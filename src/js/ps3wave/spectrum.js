// The PS3 Music Player's spectrum (soundvisualizer_plugin 0x1c9c, firmware 4.93), remade:
// 512 stereo samples at 48 kHz, a Gaussian window (its ends at 0), an FFT scaled by 1/512,
// the magnitudes of the first 256 bins smoothed across frequency by a 17-tap Gaussian,
// remapped to 256 log-spaced bands and given as 3 * ln(512 m + 1) / ln(513).
// Output: 256 bands for the left channel and 256 for the right.

const N = 512, HALF = 256;
const f32 = Math.fround;

// w(j) = 2.5 * 2.7^(-(j * 2.355 / half)^2 / 0.56) / sqrt(6.3616), minus w(-half)
function gauss(j, half) {
  const x = j * 2.355 / half;
  return 2.5 * Math.pow(2.7, -(x * x) / 0.56) / Math.sqrt(6.3616);
}
const WINDOW = new Float32Array(N);
{ const e = gauss(-HALF, HALF); for (let k = 0; k < N; k++) WINDOW[k] = f32(gauss(k - HALF, HALF) - e); }
const SMOOTH = new Float32Array(17);
{
  const e = gauss(-8, 8); let s = 0;
  for (let k = 0; k < 17; k++) { SMOOTH[k] = gauss(k - 8, 8) - e; s += SMOOTH[k]; }
  for (let k = 0; k < 17; k++) SMOOTH[k] = f32(SMOOTH[k] / s);
}
// the band positions: pos(i) = (2^((i + 1/64) / 64) - 1) * 255 / (2^3.98462 - 1)
const POS = new Float32Array(HALF);
{ const d = Math.pow(2, 3.98462) - 1; for (let i = 0; i < HALF; i++) POS[i] = f32((Math.pow(2, (i + 1 / 64) / 64) - 1) * 255 / d); }
const LN513 = Math.log(513);

// radix-2 FFT, in place
const REV = new Uint16Array(N);
{ for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < 9; b++) r |= ((i >> b) & 1) << (8 - b); REV[i] = r; } }
const COS = new Float64Array(N / 2), SIN = new Float64Array(N / 2);
for (let i = 0; i < N / 2; i++) { COS[i] = Math.cos(-2 * Math.PI * i / N); SIN[i] = Math.sin(-2 * Math.PI * i / N); }
function fft(re, im) {
  for (let i = 0; i < N; i++) { const j = REV[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= N; size <<= 1) {
    const h = size >> 1, step = N / size;
    for (let s = 0; s < N; s += size) for (let k = 0; k < h; k++) {
      const c = COS[k * step], sn = SIN[k * step], a = s + k, b = a + h;
      const tr = re[b] * c - im[b] * sn, ti = re[b] * sn + im[b] * c;
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
}

const re = new Float64Array(N), im = new Float64Array(N), mag = new Float32Array(HALF), sm = new Float32Array(HALF);
// one channel: 512 samples (-1..1) -> 256 bands into out
export function spectrumChannel(samples, out) {
  for (let k = 0; k < N; k++) { re[k] = (samples[k] || 0) * WINDOW[k]; im[k] = 0; }
  fft(re, im);
  for (let k = 0; k < HALF; k++) mag[k] = Math.hypot(re[k], im[k]) / N;
  for (let k = 0; k < HALF; k++) {
    let s = 0;
    for (let t = -8; t <= 8; t++) s += SMOOTH[t + 8] * mag[Math.min(HALF - 1, Math.max(0, k + t))];
    sm[k] = s;
  }
  for (let i = 0; i < HALF; i++) {
    const p = POS[i], k = Math.min(HALF - 2, Math.floor(p)), f = p - k;
    const m = sm[k] + (sm[k + 1] - sm[k]) * f;
    out[i] = 3 * Math.log(512 * Math.max(0, m) + 1) / LN513;
  }
  return out;
}

// The music being played, read from an audio element: two analysers (left and right)
// on a 48 kHz context, so the samples are the console's. The element is routed through
// the context once and for all (it still plays as before).
export class SpectrumTap {
  constructor(audioEl) {
    this.el = audioEl;
    this.L = new Float32Array(HALF); this.R = new Float32Array(HALF);
    this._bl = new Float32Array(N); this._br = new Float32Array(N);
    this.ok = false;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      try { this.ctx = new Ctx({ sampleRate: 48000 }); } catch (e) { this.ctx = new Ctx(); }
      this.src = this.ctx.createMediaElementSource(audioEl);
      // (a mono song: the same on both sides)
      this.st = this.ctx.createGain();
      this.st.channelCount = 2; this.st.channelCountMode = "explicit"; this.st.channelInterpretation = "speakers";
      this.split = this.ctx.createChannelSplitter(2);
      this.aL = this.ctx.createAnalyser(); this.aR = this.ctx.createAnalyser();
      for (const a of [this.aL, this.aR]) { a.fftSize = N; a.smoothingTimeConstant = 0; }
      this.src.connect(this.ctx.destination);
      this.src.connect(this.st); this.st.connect(this.split);
      this.split.connect(this.aL, 0); this.split.connect(this.aR, 1);
      this.ok = true;
    } catch (e) { console.warn("Visual Player: can't read the music:", e); }
  }
  resume() { if (this.ctx && this.ctx.state !== "running") this.ctx.resume().catch(() => {}); }
  // this moment's spectrum ({ L, R }: 256 bands each)
  read() {
    if (!this.ok || this.el.paused) { this.L.fill(0); this.R.fill(0); return this; }
    this.aL.getFloatTimeDomainData(this._bl); this.aR.getFloatTimeDomainData(this._br);
    // the console takes the music before its volume: the element's volume is undone here
    const v = this.el.muted ? 0 : this.el.volume;
    if (v > 0.001 && v < 1) { const k = 1 / v; for (let i = 0; i < N; i++) { this._bl[i] *= k; this._br[i] *= k; } }
    spectrumChannel(this._bl, this.L); spectrumChannel(this._br, this.R);
    return this;
  }
}
