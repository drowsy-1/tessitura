// Offline WSOLA time-stretching in a Web Worker, cached per (asset, factor).
//
// WSOLA (waveform-similarity overlap-add): the output is built from 2048-sample Hann windows at a
// fixed synthesis hop; each window is taken from the input near its nominal position, shifted by up
// to ±12 ms to the spot that best continues the previous window (cross-correlation on a decimated
// mono mix). Pitch is preserved; the engine then plays the stretched buffer at the pitch ratio to
// get key-locked transposition. Good on loops, drums and full mixes; very large ratios smear.
import { buffers, onAssets } from './assets'

export const WSOLA_SOURCE = `
onmessage = (e) => {
  const { id, chans, factor } = e.data
  const N = 2048, Hs = 1024, Ha = Hs / factor, D = 4, SEARCH = 512
  const len = chans[0].length
  const outLen = Math.max(1, Math.round(len * factor))
  const win = new Float32Array(N)
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N)
  // decimated mono for the similarity search
  const m = new Float32Array(Math.ceil(len / D))
  for (let i = 0; i < m.length; i++) { let s = 0; for (const c of chans) s += c[i * D] || 0; m[i] = s }
  const out = chans.map(() => new Float32Array(outLen + N))
  const norm = new Float32Array(outLen + N)
  let prev = 0
  const frames = Math.ceil(outLen / Hs) + 1
  for (let k = 0; k < frames; k++) {
    const nominal = Math.round(k * Ha)
    let best = nominal
    if (k > 0) {
      const target = prev + Hs // natural continuation of the previous frame
      let bestScore = -Infinity
      const lo = Math.max(0, nominal - SEARCH), hi = Math.min(len - N, nominal + SEARCH)
      for (let p = lo; p <= hi; p += D) {
        let s = 0
        const a = (p / D) | 0, b = (target / D) | 0
        for (let j = 0; j < N / D; j += 2) s += m[a + j] * (m[b + j] || 0)
        if (s > bestScore) { bestScore = s; best = p }
      }
      if (hi < lo) best = Math.min(Math.max(0, nominal), Math.max(0, len - N))
    }
    const at = k * Hs
    for (let c = 0; c < chans.length; c++) {
      const src = chans[c], dst = out[c]
      for (let i = 0; i < N; i++) { const v = src[best + i]; if (v !== undefined) dst[at + i] += v * win[i] }
    }
    for (let i = 0; i < N; i++) norm[at + i] += win[i]
    prev = best
    if (k % 64 === 0) postMessage({ id, progress: k / frames })
  }
  const res = out.map((o) => { const r = new Float32Array(outLen); for (let i = 0; i < outLen; i++) r[i] = norm[i] > 1e-3 ? o[i] / norm[i] : 0; return r })
  postMessage({ id, done: true, chans: res }, res.map((r) => r.buffer))
}
`

let worker: Worker | null = null
let seq = 0
const pending = new Map<number, { resolve: (c: Float32Array[]) => void; reject: (e: unknown) => void }>()

function getWorker() {
  if (!worker) {
    worker = new Worker(URL.createObjectURL(new Blob([WSOLA_SOURCE], { type: 'text/javascript' })))
    worker.onmessage = (e: MessageEvent) => {
      const d = e.data
      if (!d.done) return
      pending.get(d.id)?.resolve(d.chans)
      pending.delete(d.id)
    }
    worker.onerror = (e) => { for (const p of pending.values()) p.reject(e); pending.clear(); worker = null }
  }
  return worker
}

/** Stretch channel data in the worker (also used by tests through `stretchChannels`). */
export function stretchChannels(chans: Float32Array[], factor: number): Promise<Float32Array[]> {
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    const copies = chans.map((c) => c.slice())
    getWorker().postMessage({ id, chans: copies, factor }, copies.map((c) => c.buffer))
  })
}

const cache = new Map<string, AudioBuffer>()
const inflight = new Map<string, Promise<AudioBuffer | null>>()
const listeners = new Set<() => void>()
const keyOf = (assetId: string, factor: number) => `${assetId}|${factor.toFixed(4)}`
export const onStretched = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
export const stretchBusy = () => inflight.size

/** The stretched buffer if it is ready (the source itself when factor ≈ 1), else null. */
export function stretchedNow(assetId: string, factor: number): AudioBuffer | null {
  if (Math.abs(factor - 1) < 1e-4) return buffers.get(assetId) ?? null
  return cache.get(keyOf(assetId, factor)) ?? null
}

/** Make sure a stretched version exists; resolves when it's ready. */
export function ensureStretched(assetId: string, factor: number): Promise<AudioBuffer | null> {
  const now = stretchedNow(assetId, factor)
  if (now) return Promise.resolve(now)
  const key = keyOf(assetId, factor)
  const running = inflight.get(key)
  if (running) return running
  const src = buffers.get(assetId)
  if (!src) return Promise.resolve(null)
  const chans = Array.from({ length: src.numberOfChannels }, (_, i) => src.getChannelData(i))
  const p = stretchChannels(chans, factor)
    .then((res) => {
      const b = new AudioBuffer({ length: res[0].length, numberOfChannels: res.length, sampleRate: src.sampleRate })
      res.forEach((r, i) => b.copyToChannel(r as Float32Array<ArrayBuffer>, i))
      // keep the cache small: drop other factors of the same asset beyond the 3 most recent
      const same = [...cache.keys()].filter((k) => k.startsWith(`${assetId}|`))
      while (same.length >= 3) cache.delete(same.shift()!)
      cache.set(key, b)
      return b
    })
    .catch(() => null)
    .finally(() => { inflight.delete(key); listeners.forEach((l) => l()) })
  inflight.set(key, p)
  listeners.forEach((l) => l())
  return p
}

// a replaced/reloaded asset invalidates its stretched copies
onAssets(() => {
  for (const k of [...cache.keys()]) if (!buffers.has(k.split('|')[0])) cache.delete(k)
})
