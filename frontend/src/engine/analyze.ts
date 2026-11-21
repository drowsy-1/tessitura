// In-browser fallback analysis (used when the Python backend is offline).
// The backend's librosa pipeline is more robust; these are honest, lightweight estimates.
import { camelot, NOTE_NAMES } from '../lib/music'
import { fft, measureLoudness, type LoudnessReport } from './dsp'

export interface AnalysisResult {
  bpm: number
  bpmConfidence: number
  firstBeat: number // seconds: first (probable) downbeat
  keyRoot: number
  minor: boolean
  keyLabel: string
  camelot: string
  keyConfidence: number
  loudness: LoudnessReport
  duration: number
  engine: 'browser' | 'librosa'
}

function mono(buf: AudioBuffer, maxSeconds = 240) {
  const n = Math.min(buf.length, Math.floor(buf.sampleRate * maxSeconds))
  const out = new Float32Array(n)
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c)
    for (let i = 0; i < n; i++) out[i] += d[i] / buf.numberOfChannels
  }
  return out
}

function hann(n: number) {
  const w = new Float64Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
  return w
}

export function estimateTempo(x: Float32Array, sr: number) {
  const N = 1024, hop = 512
  const w = hann(N)
  const re = new Float64Array(N), im = new Float64Array(N)
  let prev = new Float64Array(N / 2)
  const onset: number[] = []
  const low: number[] = [] // flux below ~170 Hz: kicks, used to guess which beat is the downbeat
  const lowBins = Math.max(2, Math.round((170 * N) / sr))
  for (let s = 0; s + N < x.length; s += hop) {
    for (let i = 0; i < N; i++) { re[i] = x[s + i] * w[i]; im[i] = 0 }
    fft(re, im)
    const mag = new Float64Array(N / 2)
    let flux = 0, lf = 0
    for (let k = 1; k < N / 2; k++) {
      mag[k] = Math.log1p(100 * Math.hypot(re[k], im[k]))
      const d = mag[k] - prev[k]
      if (d > 0) { flux += d; if (k <= lowBins) lf += d }
    }
    prev = mag
    onset.push(flux)
    low.push(lf)
  }
  // remove local mean (adaptive threshold)
  const detrend = (a: number[]) => a.map((v, i) => {
    let m = 0, c = 0
    for (let j = Math.max(0, i - 8); j < Math.min(a.length, i + 8); j++) { m += a[j]; c++ }
    return Math.max(0, v - m / c)
  })
  const env = detrend(onset)
  const lowEnv = detrend(low)
  const fps = sr / hop
  const minLag = Math.floor((fps * 60) / 200)
  const maxLag = Math.ceil((fps * 60) / 60)
  const ac: number[] = []
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0
    for (let i = 0; i + lag < env.length; i++) s += env[i] * env[i + lag]
    const bpm = (60 * fps) / lag
    // log-Gaussian tempo prior around 120 BPM (octave errors are the classic failure)
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2))
    ac.push(s * prior)
  }
  let best = 0
  for (let i = 1; i < ac.length; i++) if (ac[i] > ac[best]) best = i
  // parabolic refinement
  let lag = best + minLag
  if (best > 0 && best < ac.length - 1) {
    const a = ac[best - 1], b = ac[best], c = ac[best + 1]
    const d = (a - 2 * b + c)
    if (d !== 0) lag += (0.5 * (a - c)) / d
  }
  const mean = ac.reduce((p, q) => p + q, 0) / ac.length
  const confidence = Math.min(1, (ac[best] / (mean || 1) - 1) / 4)

  // Beat grid: jointly refine tempo (±0.6 %) and phase by maximising onset energy on the grid.
  const at = (arr: number[], x: number) => {
    const i = Math.floor(x), f = x - i
    return i < 0 || i + 1 >= arr.length ? 0 : arr[i] * (1 - f) + arr[i + 1] * f
  }
  const bpm0 = (60 * fps) / lag
  // Phase is scored on broadband flux plus low-band (kick/bass) flux at equal weight. Broadband alone
  // locks onto loud off-beat hats in house/techno/pop and puts the grid half a beat late.
  const meanOf = (a: number[]) => a.reduce((p, q) => p + q, 0) / (a.length || 1) || 1
  const mEnv = meanOf(env), mLow = meanOf(lowEnv)
  const grid = env.map((v, i) => 0.5 * (v / mEnv) + lowEnv[i] / mLow)
  let bestBpm = bpm0, bestPhase = 0, bestScore = -1
  for (let m = -12; m <= 12; m++) {
    const b = bpm0 * (1 + m * 0.0005)
    const P = (60 * fps) / b
    for (let ph = 0; ph < P; ph += 0.25) {
      let sc = 0
      for (let x = ph; x < grid.length; x += P) sc += at(grid, x)
      if (sc > bestScore) { bestScore = sc; bestBpm = b; bestPhase = ph }
    }
  }
  const P = (60 * fps) / bestBpm
  // downbeat guess: of the four beat phases, the one with the most low-frequency attack
  let down = 0, downScore = -1
  for (let j = 0; j < 4; j++) {
    let sc = 0
    for (let x = bestPhase + j * P; x < low.length; x += 4 * P) sc += at(low, x)
    if (sc > downScore) { downScore = sc; down = j }
  }
  // flux at frame i reacts to an onset inside the frame; its centre is the best time estimate
  const frameTime = (f: number) => Math.max(0, (f * hop + N / 2) / sr + 0.002)
  let first = bestPhase + down * P
  while (first - 4 * P > -2) first -= 4 * P // allow a hair before zero for a downbeat right at the start
  return { bpm: Math.round(bestBpm * 100) / 100, confidence, firstBeat: frameTime(first), beatPeriod: 60 / bestBpm }
}

// Krumhansl–Kessler key profiles
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

function pearson(a: number[], b: number[]) {
  const ma = a.reduce((x, y) => x + y) / a.length
  const mb = b.reduce((x, y) => x + y) / b.length
  let num = 0, da = 0, db = 0
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb)
    da += (a[i] - ma) ** 2
    db += (b[i] - mb) ** 2
  }
  return num / Math.sqrt(da * db || 1)
}

export function estimateKey(x: Float32Array, sr: number) {
  const N = 8192, hop = 4096
  const w = hann(N)
  const re = new Float64Array(N), im = new Float64Array(N)
  const chroma = new Array(12).fill(0)
  const binPc: number[] = []
  for (let k = 0; k < N / 2; k++) {
    const f = (k * sr) / N
    binPc.push(f < 55 || f > 5000 ? -1 : ((Math.round(12 * Math.log2(f / 440)) % 12) + 12 + 9) % 12)
  }
  for (let s = 0; s + N < x.length; s += hop) {
    for (let i = 0; i < N; i++) { re[i] = x[s + i] * w[i]; im[i] = 0 }
    fft(re, im)
    const frame = new Array(12).fill(0)
    for (let k = 1; k < N / 2; k++) if (binPc[k] >= 0) frame[binPc[k]] += Math.hypot(re[k], im[k])
    const mx = Math.max(...frame) || 1
    for (let i = 0; i < 12; i++) chroma[i] += frame[i] / mx
  }
  let best = { root: 0, minor: false, r: -2 }
  const scores: number[] = []
  for (let root = 0; root < 12; root++) {
    const rot = (p: number[]) => p.map((_, i) => p[(i - root + 12) % 12])
    const rMaj = pearson(chroma, rot(MAJOR))
    const rMin = pearson(chroma, rot(MINOR))
    scores.push(rMaj, rMin)
    if (rMaj > best.r) best = { root, minor: false, r: rMaj }
    if (rMin > best.r) best = { root, minor: true, r: rMin }
  }
  scores.sort((a, b) => b - a)
  return { ...best, confidence: Math.max(0, Math.min(1, (scores[0] - scores[1]) * 8)) }
}

export async function analyzeBuffer(buf: AudioBuffer): Promise<AnalysisResult> {
  const x = mono(buf)
  // yield to the UI between the heavier passes
  const idle = () => new Promise((r) => setTimeout(r, 0))
  const tempo = estimateTempo(x, buf.sampleRate)
  await idle()
  const key = estimateKey(x, buf.sampleRate)
  await idle()
  const chans = Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, i) => buf.getChannelData(i))
  const loudness = measureLoudness(chans, buf.sampleRate)
  return {
    bpm: tempo.bpm,
    bpmConfidence: tempo.confidence,
    firstBeat: tempo.firstBeat,
    keyRoot: key.root,
    minor: key.minor,
    keyLabel: `${NOTE_NAMES[key.root]} ${key.minor ? 'minor' : 'major'}`,
    camelot: camelot(key.root, key.minor),
    keyConfidence: key.confidence,
    loudness,
    duration: buf.duration,
    engine: 'browser',
  }
}
