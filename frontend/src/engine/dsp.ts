// Pure DSP helpers shared by the engine, meters, analyzers and exporters.

export const dbToGain = (db: number) => (db <= -60 ? 0 : Math.pow(10, db / 20))
export const gainToDb = (g: number) => (g <= 0.000001 ? -Infinity : 20 * Math.log10(g))
export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x))

// ───────────────────────── Parameter mapping ─────────────────────────
export function toNorm(v: number, min: number, max: number, curve: 'lin' | 'log' = 'lin') {
  if (curve === 'log') return Math.log(v / min) / Math.log(max / min)
  return (v - min) / (max - min)
}
export function fromNorm(n: number, min: number, max: number, curve: 'lin' | 'log' = 'lin') {
  const c = clamp(n, 0, 1)
  if (curve === 'log') return min * Math.pow(max / min, c)
  return min + c * (max - min)
}

/** Fader law: 0..1 ↔ −60..+6 dB, with more resolution around unity (like a console fader). */
export function faderToDb(n: number) {
  if (n <= 0) return -60
  const x = clamp(n, 0, 1)
  // piecewise: top 75% of travel covers −24..+6, bottom 25% covers −60..−24
  if (x >= 0.25) return -24 + ((x - 0.25) / 0.75) * 30
  return -60 + (x / 0.25) * 36
}
export function dbToFader(db: number) {
  if (db <= -60) return 0
  if (db >= -24) return 0.25 + ((db + 24) / 30) * 0.75
  return ((db + 60) / 36) * 0.25
}

// ───────────────────────── BS.1770 K-weighting ─────────────────────────
export function kWeightCoeffs(fs: number) {
  let f0 = 1681.974450955533
  const G = 3.999843853973347
  let Q = 0.7071752369554196
  let K = Math.tan((Math.PI * f0) / fs)
  const Vh = Math.pow(10, G / 20)
  const Vb = Math.pow(Vh, 0.4996667741545416)
  let a0 = 1 + K / Q + K * K
  const shelf = {
    b: [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0],
    a: [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0],
  }
  f0 = 38.13547087602444
  Q = 0.5003270373238773
  K = Math.tan((Math.PI * f0) / fs)
  a0 = 1 + K / Q + K * K
  const hp = { b: [1, -2, 1], a: [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0] }
  return [shelf, hp]
}

function biquadInPlace(x: Float32Array, b: number[], a: number[]) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i]
    const y0 = b[0] * x0 + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2
    x2 = x1; x1 = x0; y2 = y1; y1 = y0
    x[i] = y0
  }
}

export interface LoudnessReport {
  integrated: number // LUFS
  shortTermMax: number
  momentaryMax: number
  lra: number // LU
  samplePeak: number // dBFS
  truePeak: number // dBTP (4× oversampled estimate)
}

/** ITU-R BS.1770-4 / EBU R128 loudness of an AudioBuffer-like set of channels. */
export function measureLoudness(channels: Float32Array[], fs: number): LoudnessReport {
  const [s1, s2] = kWeightCoeffs(fs)
  const weighted = channels.slice(0, 2).map((ch) => {
    const c = new Float32Array(ch)
    biquadInPlace(c, s1.b, s1.a)
    biquadInPlace(c, s2.b, s2.a)
    return c
  })
  const len = weighted[0].length
  const step = Math.round(fs * 0.1)
  // energy per 100 ms sub-block, summed across channels
  const sub: number[] = []
  for (let i = 0; i + step <= len; i += step) {
    let e = 0
    for (const c of weighted) {
      let s = 0
      for (let j = i; j < i + step; j++) s += c[j] * c[j]
      e += s / step
    }
    sub.push(e)
  }
  const lufs = (e: number) => -0.691 + 10 * Math.log10(Math.max(e, 1e-12))
  const windowed = (n: number) => {
    const out: number[] = []
    for (let i = 0; i + n <= sub.length; i++) {
      let s = 0
      for (let j = i; j < i + n; j++) s += sub[j]
      out.push(s / n)
    }
    return out
  }
  const mom = windowed(4)
  const st = windowed(30)
  // integrated
  const abs = mom.filter((e) => lufs(e) > -70)
  let integrated = -Infinity
  if (abs.length) {
    const rel = lufs(abs.reduce((a, b) => a + b, 0) / abs.length) - 10
    const gated = abs.filter((e) => lufs(e) > rel)
    if (gated.length) integrated = lufs(gated.reduce((a, b) => a + b, 0) / gated.length)
  }
  // loudness range (EBU Tech 3342)
  let lra = 0
  const stAbs = st.filter((e) => lufs(e) > -70)
  if (stAbs.length > 2) {
    const rel = lufs(stAbs.reduce((a, b) => a + b, 0) / stAbs.length) - 20
    const vals = stAbs.map(lufs).filter((l) => l > rel).sort((a, b) => a - b)
    if (vals.length > 2) lra = vals[Math.floor(vals.length * 0.95) - 1] - vals[Math.floor(vals.length * 0.1)]
  }
  let peak = 0
  for (const c of channels) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]))
  return {
    integrated,
    shortTermMax: st.length ? Math.max(...st.map(lufs)) : -Infinity,
    momentaryMax: mom.length ? Math.max(...mom.map(lufs)) : -Infinity,
    lra,
    samplePeak: gainToDb(peak),
    truePeak: gainToDb(truePeak(channels, peak)),
  }
}

/** 4× oversampled peak using a windowed-sinc interpolator, evaluated only near loud samples. */
export function truePeak(channels: Float32Array[], samplePeak: number) {
  const TAPS = 12
  const phases = [0.25, 0.5, 0.75].map((frac) => {
    const k: number[] = []
    for (let t = -TAPS + 1; t <= TAPS; t++) {
      const x = t - frac
      const sinc = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
      const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / TAPS)
      k.push(sinc * w)
    }
    return k
  })
  let tp = samplePeak
  const thresh = samplePeak * 0.6
  for (const c of channels) {
    for (let i = TAPS; i < c.length - TAPS; i++) {
      if (Math.abs(c[i]) < thresh && Math.abs(c[i + 1]) < thresh) continue
      for (const k of phases) {
        let s = 0
        for (let t = 0; t < k.length; t++) s += k[t] * c[i + t - TAPS + 1]
        if (Math.abs(s) > tp) tp = Math.abs(s)
      }
    }
  }
  return tp
}

// ───────────────────────── FFT ─────────────────────────
export function fft(re: Float64Array, im: Float64Array) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang), wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci
        const ai = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr
        re[i + j + len / 2] = re[i + j] - ar
        im[i + j + len / 2] = im[i + j] - ai
        re[i + j] += ar
        im[i + j] += ai
        const t = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = t
      }
    }
  }
}

// ───────────────────────── Biquad magnitude (Web Audio formulas) ─────────────────────────
export type BiquadKind = 'lowpass' | 'highpass' | 'bandpass' | 'peaking' | 'lowshelf' | 'highshelf'

export function biquadMagDb(kind: BiquadKind, f0: number, gainDb: number, Q: number, f: number, fs = 48000) {
  const A = Math.pow(10, gainDb / 40)
  const w0 = (2 * Math.PI * f0) / fs
  const cw = Math.cos(w0), sw = Math.sin(w0)
  const aQ = sw / (2 * Q)
  const aQdB = sw / (2 * Math.pow(10, Q / 20))
  const aS = (sw / 2) * Math.SQRT2
  const sA = Math.sqrt(A)
  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0
  switch (kind) {
    case 'lowpass': b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + aQdB; a1 = -2 * cw; a2 = 1 - aQdB; break
    case 'highpass': b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + aQdB; a1 = -2 * cw; a2 = 1 - aQdB; break
    case 'bandpass': b0 = aQ; b1 = 0; b2 = -aQ; a0 = 1 + aQ; a1 = -2 * cw; a2 = 1 - aQ; break
    case 'peaking': b0 = 1 + aQ * A; b1 = -2 * cw; b2 = 1 - aQ * A; a0 = 1 + aQ / A; a1 = -2 * cw; a2 = 1 - aQ / A; break
    case 'lowshelf':
      b0 = A * (A + 1 - (A - 1) * cw + 2 * aS * sA); b1 = 2 * A * (A - 1 - (A + 1) * cw); b2 = A * (A + 1 - (A - 1) * cw - 2 * aS * sA)
      a0 = A + 1 + (A - 1) * cw + 2 * aS * sA; a1 = -2 * (A - 1 + (A + 1) * cw); a2 = A + 1 + (A - 1) * cw - 2 * aS * sA; break
    case 'highshelf':
      b0 = A * (A + 1 + (A - 1) * cw + 2 * aS * sA); b1 = -2 * A * (A - 1 + (A + 1) * cw); b2 = A * (A + 1 + (A - 1) * cw - 2 * aS * sA)
      a0 = A + 1 - (A - 1) * cw + 2 * aS * sA; a1 = 2 * (A - 1 - (A + 1) * cw); a2 = A + 1 - (A - 1) * cw - 2 * aS * sA; break
  }
  const w = (2 * Math.PI * f) / fs
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w)
  const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2)
  const dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2)
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di))
}

// ───────────────────────── Waveform peaks ─────────────────────────
export function computePeaks(buf: AudioBuffer, samplesPerPeak = 256) {
  const n = Math.ceil(buf.length / samplesPerPeak)
  const min = new Float32Array(n)
  const max = new Float32Array(n)
  const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i))
  for (let p = 0; p < n; p++) {
    let lo = 0, hi = 0
    const end = Math.min(buf.length, (p + 1) * samplesPerPeak)
    for (let i = p * samplesPerPeak; i < end; i++) {
      let s = 0
      for (const c of chans) s += c[i]
      s /= chans.length
      if (s < lo) lo = s
      if (s > hi) hi = s
    }
    min[p] = lo
    max[p] = hi
  }
  return { min, max, samplesPerPeak, sampleRate: buf.sampleRate }
}
export type Peaks = ReturnType<typeof computePeaks>

// ───────────────────────── WAV encoding ─────────────────────────
export function encodeWav(buf: AudioBuffer, bitDepth: 16 | 24 = 24) {
  const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i))
  const bytes = bitDepth / 8
  const dataLen = buf.length * chans.length * bytes
  const out = new DataView(new ArrayBuffer(44 + dataLen))
  const str = (o: number, s: string) => [...s].forEach((ch, i) => out.setUint8(o + i, ch.charCodeAt(0)))
  str(0, 'RIFF'); out.setUint32(4, 36 + dataLen, true); str(8, 'WAVE'); str(12, 'fmt ')
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, chans.length, true)
  out.setUint32(24, buf.sampleRate, true); out.setUint32(28, buf.sampleRate * chans.length * bytes, true)
  out.setUint16(32, chans.length * bytes, true); out.setUint16(34, bitDepth, true); str(36, 'data'); out.setUint32(40, dataLen, true)
  const full = bitDepth === 16 ? 32767 : 8388607
  let o = 44
  for (let i = 0; i < buf.length; i++) {
    for (const c of chans) {
      // TPDF dither when reducing to 16 bit
      const d = bitDepth === 16 ? (Math.random() - Math.random()) / full : 0
      const v = Math.round(clamp(c[i] + d, -1, 1) * full)
      if (bitDepth === 16) out.setInt16(o, v, true)
      else { out.setUint8(o, v & 0xff); out.setUint8(o + 1, (v >> 8) & 0xff); out.setUint8(o + 2, (v >> 16) & 0xff) }
      o += bytes
    }
  }
  return new Blob([out.buffer], { type: 'audio/wav' })
}

// ───────────────────────── Impulse responses ─────────────────────────
export function makeImpulse(ctx: BaseAudioContext, decay: number, damp: number, predelayMs: number) {
  const fs = ctx.sampleRate
  const pre = Math.floor((predelayMs / 1000) * fs)
  const len = Math.floor(fs * Math.min(10, decay * 1.2)) + pre
  const ir = ctx.createBuffer(2, len, fs)
  const coeff = Math.exp((-2 * Math.PI * damp) / fs)
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch)
    let lp = 0
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / fs
      const env = Math.pow(10, (-3 * t) / decay) // −60 dB at `decay`
      const noise = Math.random() * 2 - 1
      // damping gets stronger as the tail evolves (air absorption feel)
      const k = coeff + (1 - coeff) * Math.min(1, t / decay) * 0.6
      lp = lp * k + noise * (1 - k)
      d[i] = (lp * 2.2) * env
    }
  }
  return ir
}
