// Long-running backend jobs (stem separation, pitch correction), kept outside any panel so
// switching tabs, closing the panel or reloading the page never loses a result.
import { create } from 'zustand'
import * as api from '../lib/api'
import { assetBlob } from '../engine/assets'
import { addAsset, decodeFile } from './actions'
import { edit, getProject, resolveClip, toast, type ClipRef } from './store'
import type { AssetMeta } from './types'

export interface JobView {
  id: string
  kind: 'stems' | 'tune'
  assetId: string
  source: string
  model: string
  status: api.Job['status']
  progress: number
  message: string
  created: number
  resultAssets?: string[] // asset ids created from the result
  clip?: ClipRef // tune: the clip to update
  tune?: api.TuneResult
}

const KEY = 'tessitura.jobs.v1'
function load(): Record<string, JobView> {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, JobView>
    // curves are large; they're re-fetched from the backend when needed
    for (const v of Object.values(j)) delete v.tune
    return j
  } catch {
    return {}
  }
}

export const useJobs = create<{ jobs: Record<string, JobView> }>(() => ({ jobs: load() }))
useJobs.subscribe((s) => {
  try {
    const slim = Object.fromEntries(Object.entries(s.jobs).slice(-40).map(([k, v]) => [k, { ...v, tune: undefined }]))
    localStorage.setItem(KEY, JSON.stringify(slim))
  } catch { /* storage unavailable */ }
})
const put = (id: string, patch: Partial<JobView>) =>
  useJobs.setState((s) => ({ jobs: { ...s.jobs, [id]: { ...s.jobs[id], ...patch } as JobView } }))

const polling = new Set<string>()

async function poll(id: string) {
  if (polling.has(id)) return
  polling.add(id)
  try {
    for (;;) {
      let j: api.Job<unknown>
      try {
        j = await api.job(id)
      } catch {
        put(id, { status: 'error', message: 'The backend no longer knows this job (was its data folder cleared?)' })
        return
      }
      put(id, { status: j.status, progress: j.progress, message: j.message })
      if (j.status === 'done') {
        const view = useJobs.getState().jobs[id]
        if (view.kind === 'stems') await importStems(id, j.result as api.Job['result'])
        else await applyTune(id, j.result as api.TuneResult)
        return
      }
      if (j.status === 'error') {
        toast(`${useJobs.getState().jobs[id]?.kind === 'tune' ? 'Pitch correction' : 'Separation'} failed: ${j.message}`, 'warn')
        return
      }
      await new Promise((r) => setTimeout(r, 900))
    }
  } finally {
    polling.delete(id)
  }
}

/** Download a finished stem job's files into the project (skipping any already imported). */
export async function importStems(id: string, result?: api.Job['result']) {
  const res = result ?? (await api.job(id)).result
  if (!res) return []
  const view = useJobs.getState().jobs[id]
  const existing = Object.values(getProject().assets).filter((a) => a.jobId === id)
  const out: AssetMeta[] = [...existing]
  for (const s of res.stems) {
    if (existing.some((a) => a.name.endsWith(`· ${s.name}`))) continue
    try {
      const b = await api.fetchAudio(s.url)
      const base = (view?.source ?? 'Stem').replace(/\.[a-z0-9]+$/i, '')
      out.push(addAsset(await decodeFile(b), `${base} · ${s.name}`, 'stem', b, { jobId: id }))
    } catch {
      toast(`Couldn't download the ${s.name} stem`, 'warn')
    }
  }
  if (view) put(id, { resultAssets: out.map((a) => a.id), status: 'done', progress: 1, message: `${out.length} stems ready` })
  toast(`${out.length} stems ready in the browser (Audio)`, 'ok')
  return out
}

export async function startStems(assetId: string, model: string) {
  const blob = assetBlob(assetId)
  if (!blob) throw new Error('Audio not loaded')
  const source = getProject().assets[assetId]?.name ?? 'audio'
  const j = await api.startStems(blob, model, source)
  put(j.id, { id: j.id, kind: 'stems', assetId, source, model, status: j.status, progress: j.progress, message: j.message, created: Date.now() })
  void poll(j.id)
  return j.id
}

export async function startTune(ref: ClipRef, params: { root: number; scale: number[]; speed: number; amount: number; humanize: number; detector: string; synth: string }) {
  const r = resolveClip(getProject(), ref)
  if (!r || r.clip.kind !== 'audio') throw new Error('Select an audio clip')
  // always tune the untouched take, so re-tuning doesn't stack corrections
  const assetId = r.clip.origAssetId ?? r.clip.assetId
  const blob = assetBlob(assetId)
  if (!blob) throw new Error('Audio not loaded')
  const source = getProject().assets[assetId]?.name ?? 'audio'
  const j = await api.startTune(blob, { ...params, source })
  put(j.id, { id: j.id, kind: 'tune', assetId, source, model: `${params.detector} → ${params.synth}`, status: j.status, progress: j.progress, message: j.message, created: Date.now(), clip: ref })
  void poll(j.id)
  return j.id
}

async function applyTune(id: string, res?: api.TuneResult) {
  const view = useJobs.getState().jobs[id]
  if (!res || !view) return
  const b = await api.fetchAudio(res.url)
  const base = view.source.replace(/\.[a-z0-9]+$/i, '').replace(/ \(tuned\)$/, '')
  const a = addAsset(await decodeFile(b), `${base} (tuned)`, 'tuned', b, { jobId: id })
  if (view.clip) {
    edit((p) => {
      const r = resolveClip(p, view.clip!)
      if (r && r.clip.kind === 'audio') {
        r.clip.origAssetId = r.clip.origAssetId ?? r.clip.assetId
        r.clip.assetId = a.id
      }
    }, { label: 'Pitch correction' })
  }
  put(id, { resultAssets: [a.id], tune: res, message: `Corrected ${res.stats.mean_cents} ¢ on average` })
  toast(`Pitch corrected: average ${res.stats.mean_cents} ¢, largest ${res.stats.max_cents} ¢`, 'ok')
}

/** Resume polling jobs that were still running when the page closed. */
export function resumeJobs() {
  for (const j of Object.values(useJobs.getState().jobs)) if (j.status === 'queued' || j.status === 'running') void poll(j.id)
}
