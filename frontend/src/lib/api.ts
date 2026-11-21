// Thin client for the FastAPI backend. Every call degrades gracefully when it is offline.
import type { Project } from '../state/types'

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api'

export interface Capabilities {
  ok: boolean
  version: string
  analysis: 'librosa' | 'numpy'
  loudness: 'pyloudnorm' | 'builtin'
  stems: {
    engine: 'demucs' | 'audio-separator' | 'hpss-fallback'
    engines: Record<'demucs' | 'audio-separator' | 'builtin', boolean>
    gpu: string | null
    models: { id: string; label: string; stems: string[]; available: boolean; note: string; engine: 'demucs' | 'audio-separator' | 'builtin' }[]
  }
  warp: 'rubberband' | 'librosa'
  tune?: { detectors: TuneOption[]; synths: TuneOption[] }
  formats?: { ffmpeg: boolean }
}

export interface TuneOption { id: string; label: string; note: string; available: boolean }

export interface TuneResult {
  url: string
  curves: { hop: number; detected: (number | null)[]; corrected: (number | null)[]; target: (number | null)[] }
  stats: { voiced: number; mean_cents: number; max_cents: number }
}

export interface BackendAnalysis {
  bpm: number
  bpm_confidence: number
  key_root: number
  minor: boolean
  key_label: string
  camelot: string
  key_confidence: number
  // JSON has no ±Infinity: silent input comes back as null
  lufs_integrated: number | null
  lufs_short_max: number | null
  lra: number | null
  true_peak: number | null
  sample_peak: number | null
  duration: number
  beats: number[]
}

export interface Job<R = { stems: { name: string; url: string }[]; model: string; engine: string }> {
  id: string
  kind?: 'stems' | 'tune'
  status: 'queued' | 'running' | 'done' | 'error'
  progress: number
  message: string
  created?: number
  meta?: { source?: string; model?: string; detector?: string; synth?: string }
  result?: R
}

let caps: Capabilities | null = null
let checked = 0
let inflight: Promise<Capabilities | null> | null = null

/** Backend capabilities, cached for 15 s; concurrent callers share one request. */
export async function capabilities(force = false): Promise<Capabilities | null> {
  if (inflight) return inflight
  if (!force && checked && Date.now() - checked < 15000) return caps
  inflight = (async () => {
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2500) })
      caps = r.ok ? await r.json() : null
    } catch {
      caps = null
    }
    checked = Date.now()
    inflight = null
    return caps
  })()
  return inflight
}

async function upload<T>(path: string, blob: Blob, fields: Record<string, string> = {}): Promise<T> {
  const fd = new FormData()
  fd.append('file', blob, (blob as File).name ?? 'audio.wav')
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  const r = await fetch(`${BASE}${path}`, { method: 'POST', body: fd })
  if (!r.ok) throw new Error((await r.json().catch(() => ({ detail: r.statusText }))).detail ?? r.statusText)
  return r.json()
}

export const analyzeRemote = (blob: Blob) => upload<BackendAnalysis>('/analyze', blob)
export const startStems = (blob: Blob, model: string, source = '') => upload<Job>('/stems', blob, { model, source })
export const convertRemote = (blob: Blob) => upload<{ url: string; has_video?: boolean; duration?: number; codec?: string }>('/convert', blob)
export const startTune = (blob: Blob, p: { root: number; scale: number[]; speed: number; amount: number; humanize: number; detector: string; synth: string; source: string }) =>
  upload<Job<TuneResult>>('/tune', blob, { root: String(p.root), scale: p.scale.join(','), speed: String(p.speed), amount: String(p.amount), humanize: String(p.humanize), detector: p.detector, synth: p.synth, source: p.source })

export async function listJobs(kind?: 'stems' | 'tune'): Promise<Job[]> {
  const r = await fetch(`${BASE}/jobs${kind ? `?kind=${kind}` : ''}`)
  return r.ok ? r.json() : []
}
export const warpRemote = (blob: Blob, stretch: number, semitones: number) => upload<{ url: string; engine: string }>('/warp', blob, { stretch: String(stretch), semitones: String(semitones) })

export async function job<R = Job['result']>(id: string): Promise<Job<R>> {
  const r = await fetch(`${BASE}/jobs/${id}`)
  if (!r.ok) throw new Error('Job not found')
  return r.json()
}

export async function fetchAudio(url: string) {
  const r = await fetch(url.startsWith('http') ? url : `${BASE}${url.replace(/^\/api/, '')}`)
  if (!r.ok) throw new Error(`Could not download ${url}`)
  return r.blob()
}

export async function listProjects(): Promise<{ name: string; updated: number; versions: number }[]> {
  const r = await fetch(`${BASE}/projects`)
  return r.ok ? r.json() : []
}

export async function saveProject(p: Project, assets: Record<string, Blob>) {
  const fd = new FormData()
  fd.append('project', JSON.stringify(p))
  for (const [id, b] of Object.entries(assets)) fd.append('assets', b, `${id}.wav`)
  const r = await fetch(`${BASE}/projects/${encodeURIComponent(p.name)}`, { method: 'PUT', body: fd })
  if (!r.ok) throw new Error('Save failed')
  return r.json() as Promise<{ version: number; path: string; missing_assets: string[] }>
}

export async function loadProject(name: string): Promise<{ project: Project; assets: Record<string, string> }> {
  const r = await fetch(`${BASE}/projects/${encodeURIComponent(name)}`)
  if (!r.ok) throw new Error('Project not found')
  return r.json()
}

export async function existingAssets(name: string): Promise<string[]> {
  const r = await fetch(`${BASE}/projects/${encodeURIComponent(name)}/assets`)
  return r.ok ? r.json() : []
}
