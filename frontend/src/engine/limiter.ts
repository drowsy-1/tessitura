// Look-ahead true-peak limiter (AudioWorklet).
//
// Algorithm (per sample, channels linked):
//   1. estimate the true peak of the incoming sample with a 4× windowed-sinc interpolator
//   2. required gain r = min(1, ceiling / peak)
//   3. hold the minimum of r over the look-ahead window L, then average it over L samples.
//      Because every held value in the averaging window is ≤ r(t), the averaged gain applied
//      to x(t) (delayed by L−1 samples) is ≤ r(t): the ceiling is guaranteed, with an L-sample
//      linear attack instead of a click.
//   4. release is an exponential return toward the averaged gain, never above it.
export const LIMITER_SOURCE = `
const TAPS = 8
function kernel(frac) {
  const k = []
  for (let t = -TAPS + 1; t <= TAPS; t++) {
    const x = t - frac
    const s = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
    k.push(s * (0.5 + 0.5 * Math.cos(Math.PI * x / TAPS)))
  }
  return k
}
const K = [0.25, 0.5, 0.75].map(kernel)

class TruePeakLimiter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'ceiling', defaultValue: -1, minValue: -24, maxValue: 0, automationRate: 'k-rate' },
      { name: 'gain', defaultValue: 0, minValue: 0, maxValue: 24, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 80, minValue: 5, maxValue: 1000, automationRate: 'k-rate' },
    ]
  }
  constructor() {
    super()
    this.L = Math.max(16, Math.round(sampleRate * 0.005)) // 5 ms look-ahead
    this.hist = [new Float32Array(2 * TAPS), new Float32Array(2 * TAPS)] // interpolation history
    this.hpos = 0
    this.delay = [new Float32Array(this.L - 1), new Float32Array(this.L - 1)]
    this.centre = new Float32Array(2)
    this.dpos = 0
    this.req = new Float32Array(this.L) // ring of required gains, for the sliding minimum
    this.dq = new Int32Array(this.L + 1); this.dqHead = 0; this.dqTail = 0; this.n = 0
    this.held = new Float32Array(this.L); this.sum = this.L; this.held.fill(1)
    this.g = 1
    this.minG = 1
    this.frames = 0
  }
  // monotonic deque sliding-window minimum over the last L required gains
  pushMin(v) {
    const L = this.L
    const idx = this.n
    this.req[idx % L] = v
    while (this.dqTail > this.dqHead && this.req[this.dq[(this.dqTail - 1) % (L + 1)] % L] >= v) this.dqTail--
    this.dq[this.dqTail % (L + 1)] = idx; this.dqTail++
    while (this.dq[this.dqHead % (L + 1)] <= idx - L) this.dqHead++
    this.n++
    return this.req[this.dq[this.dqHead % (L + 1)] % L]
  }
  process(inputs, outputs, params) {
    const inp = inputs[0], out = outputs[0]
    if (!inp || inp.length === 0) return true
    const ch = Math.min(2, inp.length)
    // 0.13 dB safety margin covers the gap between this 4× estimator and a finer true-peak meter
    const ceil = Math.pow(10, params.ceiling[0] / 20) * 0.985
    const pre = Math.pow(10, params.gain[0] / 20)
    const rel = Math.exp(-1 / (sampleRate * params.release[0] / 1000))
    const L = this.L, H = 2 * TAPS
    const n = inp[0].length
    const centre = this.centre
    for (let i = 0; i < n; i++) {
      // 1. true-peak estimate over channels (centre sample plus 3 interpolated points after it)
      let peak = 0
      for (let c = 0; c < ch; c++) {
        const h = this.hist[c]
        h[this.hpos] = inp[c][i] * pre
        centre[c] = h[(this.hpos + TAPS) % H] // chronologically the 8th of the last 16 samples
        let p = Math.abs(centre[c])
        for (let k = 0; k < 3; k++) {
          let s = 0
          const ker = K[k]
          for (let t = 0; t < H; t++) s += ker[t] * h[(this.hpos + 1 + t) % H]
          if (Math.abs(s) > p) p = Math.abs(s)
        }
        if (p > peak) peak = p
      }
      this.hpos = (this.hpos + 1) % H
      // 2–3. required gain → sliding minimum → moving average
      const r = peak > ceil ? ceil / peak : 1
      const m = this.pushMin(r)
      const slot = this.n % L
      this.sum += m - this.held[slot]
      this.held[slot] = m
      const avg = Math.min(1, this.sum / L)
      // 4. release, never above the averaged requirement
      const g = Math.min(avg, 1 - (1 - this.g) * rel)
      this.g = g
      if (g < this.minG) this.minG = g
      // audio delayed by L-1 samples so the averaged gain has fully arrived at each peak
      for (let c = 0; c < ch; c++) {
        const d = this.delay[c]
        const y = d[this.dpos]
        d[this.dpos] = centre[c]
        out[c][i] = y * g
      }
      this.dpos = (this.dpos + 1) % (L - 1)
    }
    for (let c = ch; c < out.length; c++) out[c].set(out[0])
    if ((this.frames += n) >= sampleRate / 20) {
      this.port.postMessage(20 * Math.log10(Math.max(this.minG, 1e-6)))
      this.frames = 0
      this.minG = 1
    }
    return true
  }
}
registerProcessor('tessitura-limiter', TruePeakLimiter)
`

const ready = new WeakMap<BaseAudioContext, Promise<boolean>>()
const loaded = new WeakSet<BaseAudioContext>()

/** Load the limiter worklet into a context. Resolves false where worklets aren't allowed. */
export function loadLimiter(ctx: BaseAudioContext): Promise<boolean> {
  let p = ready.get(ctx)
  if (!p) {
    p = (async () => {
      try {
        const url = URL.createObjectURL(new Blob([LIMITER_SOURCE], { type: 'text/javascript' }))
        await ctx.audioWorklet.addModule(url)
        loaded.add(ctx)
        return true
      } catch {
        return false
      }
    })()
    ready.set(ctx, p)
  }
  return p
}

export const limiterReady = (ctx: BaseAudioContext) => loaded.has(ctx)
