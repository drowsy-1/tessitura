import { computePeaks, encodeWav, type Peaks } from './dsp'
import { idbPut } from '../lib/idb'

// Audio data lives outside the (JSON) project store; clips reference it by asset id.
export const buffers = new Map<string, AudioBuffer>()
export const peaks = new Map<string, Peaks>()
export const blobs = new Map<string, Blob>()

const listeners = new Set<() => void>()
let version = 0
export const assetVersion = () => version
export function onAssets(fn: () => void) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function registerBuffer(id: string, buf: AudioBuffer, blob?: Blob, opts: { persist?: boolean } = {}) {
  buffers.set(id, buf)
  peaks.set(id, computePeaks(buf))
  if (blob) blobs.set(id, blob)
  version++
  listeners.forEach((l) => l())
  if (opts.persist !== false) persist(id, buf, blob)
}

/** Keep a copy in IndexedDB so audio survives a reload (restored with the autosaved project). */
function persist(id: string, buf: AudioBuffer, blob?: Blob) {
  const save = () => void idbPut(id, blob ?? encodeWav(buf, 24))
  const idle = (window as unknown as { requestIdleCallback?: (f: () => void) => void }).requestIdleCallback
  if (idle) idle(save)
  else setTimeout(save, 50)
}

/** A WAV blob for the asset: the original upload when we have it, otherwise re-encoded. */
export function assetBlob(id: string): Blob | null {
  const b = blobs.get(id)
  if (b) return b
  const buf = buffers.get(id)
  return buf ? encodeWav(buf, 24) : null
}

export function reverseBuffer(ctx: BaseAudioContext, buf: AudioBuffer) {
  const out = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate)
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c)
    const dst = out.getChannelData(c)
    for (let i = 0; i < src.length; i++) dst[i] = src[src.length - 1 - i]
  }
  return out
}

export function bufferPeak(buf: AudioBuffer) {
  let p = 0
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c)
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i])
      if (a > p) p = a
    }
  }
  return p
}
