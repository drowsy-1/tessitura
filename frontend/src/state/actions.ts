import { audioCtx, engine } from '../engine'
import { assetBlob, blobs, bufferPeak, buffers, registerBuffer, reverseBuffer } from '../engine/assets'
import { encodeWav, gainToDb, measureLoudness } from '../engine/dsp'
import { renderOffline } from '../engine/engine'
import { Synth } from '../engine/instruments'
import { analyzeBuffer, estimateTempo, type AnalysisResult } from '../engine/analyze'
import * as api from '../lib/api'
import { idbDelete, idbGet, idbKeys } from '../lib/idb'
import { camelot, NOTE_NAMES } from '../lib/music'
import { cloneClip, drumInstrument, makeTrack, midiClip, SYNTH_PRESETS, synthInstrument, TRACK_COLORS, uid } from './defaults'
import { beatsPerBar, edit, findTrack, getProject, projectEndBeat, resolveClip, setUI, toast, ui, useProject, type ClipRef } from './store'
import type { AssetMeta, AudioClip, Clip, DeviceType, Project, Track } from './types'
import { makeDevice } from './defaults'
import { srcSecPerBeat, tidyBpm } from './clip'

const nextColor = (p: Project) => TRACK_COLORS[p.tracks.length % TRACK_COLORS.length]

/** Hosted demo build (no backend, downloads disabled by the host). */
export const DEMO = import.meta.env.VITE_DEMO === '1'

export function download(blob: Blob, name: string) {
  if (DEMO) return false
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
  return true
}

// ───────────────────────── Tracks ─────────────────────────
export function addTrack(kind: 'synth' | 'drums' | 'audio', preset?: string) {
  const id = uid()
  edit((p) => {
    const color = nextColor(p)
    const t =
      kind === 'audio'
        ? makeTrack('audio', `Audio ${p.tracks.filter((x) => x.kind === 'audio').length + 1}`, color)
        : kind === 'drums'
          ? makeTrack('midi', 'Drums', color, drumInstrument(preset))
          : makeTrack('midi', preset ?? 'Synth', color, synthInstrument(preset && SYNTH_PRESETS[preset] ? preset : undefined))
    t.id = id
    t.slots = p.scenes.map(() => null)
    p.tracks.push(t)
  }, { label: 'Add track' })
  setUI({ selectedTrack: id })
  return id
}

export function deleteTrack(id: string) {
  edit((p) => { p.tracks = p.tracks.filter((t) => t.id !== id) }, { label: 'Delete track' })
  if (ui().selectedTrack === id) setUI({ selectedTrack: null, editing: null })
}

export function duplicateTrack(id: string) {
  edit((p) => {
    const i = p.tracks.findIndex((t) => t.id === id)
    if (i < 0) return
    const t = structuredClone(p.tracks[i])
    t.id = uid()
    t.name = `${t.name} copy`
    t.clips = t.clips.map(cloneClip)
    t.slots = t.slots.map((s) => (s ? cloneClip(s) : null))
    t.devices = t.devices.map((d) => ({ ...d, id: uid() }))
    p.tracks.splice(i + 1, 0, t)
  }, { label: 'Duplicate track' })
}

export function updateTrack(id: string, fn: (t: Track) => void, coalesce?: string) {
  edit((p) => { const t = findTrack(p, id); if (t) fn(t) }, { coalesce: coalesce ? `${coalesce}:${id}` : undefined })
}

export function addDevice(trackId: string | 'master', type: DeviceType) {
  edit((p) => {
    const d = makeDevice(type)
    if (trackId === 'master') p.master.devices.push(d)
    else findTrack(p, trackId)?.devices.push(d)
  }, { label: 'Add device' })
}

// ───────────────────────── Clips ─────────────────────────
export function createMidiClipAt(trackId: string, beat: number, slot?: number) {
  const p = getProject()
  const bar = beatsPerBar(p)
  const clip = midiClip('Clip', slot === undefined ? Math.floor(beat / bar) * bar : 0, bar, [], undefined)
  edit((pp) => {
    const t = findTrack(pp, trackId)
    if (!t) return
    if (slot !== undefined) t.slots[slot] = clip
    else t.clips.push(clip)
  }, { label: 'New clip' })
  const ref: ClipRef = { trackId, clipId: clip.id, slot }
  setUI({ editing: ref, selectedClips: [ref], selectedTrack: trackId, dock: 'editor', dockOpen: true })
}

export function updateClip(ref: ClipRef, fn: (c: Clip, t: Track) => void, coalesce?: string) {
  edit((p) => {
    const r = resolveClip(p, ref)
    if (r) fn(r.clip, r.track)
  }, { coalesce: coalesce ? `${coalesce}:${ref.clipId}` : undefined })
}

export function deleteSelectedClips() {
  const sel = ui().selectedClips
  if (!sel.length) return
  edit((p) => {
    for (const r of sel) {
      const t = findTrack(p, r.trackId)
      if (!t) continue
      if (r.slot !== undefined) { if (t.slots[r.slot]?.id === r.clipId) t.slots[r.slot] = null }
      else t.clips = t.clips.filter((c) => c.id !== r.clipId)
    }
  }, { label: 'Delete clips' })
  const ed = ui().editing
  setUI({ selectedClips: [], editing: ed && sel.some((s) => s.clipId === ed.clipId) ? null : ed })
}

export function duplicateSelectedClips() {
  const sel = ui().selectedClips.filter((r) => r.slot === undefined)
  if (!sel.length) return
  const newRefs: ClipRef[] = []
  edit((p) => {
    const clips = sel.map((r) => resolveClip(p, r)).filter(Boolean) as { track: Track; clip: Clip }[]
    const lo = Math.min(...clips.map((c) => c.clip.start))
    const hi = Math.max(...clips.map((c) => c.clip.start + c.clip.length))
    for (const { track, clip } of clips) {
      const c = cloneClip(clip)
      c.start = clip.start + (hi - lo)
      track.clips.push(c)
      newRefs.push({ trackId: track.id, clipId: c.id })
    }
  }, { label: 'Duplicate clips' })
  setUI({ selectedClips: newRefs })
}

export function splitClipsAt(beat: number) {
  const sel = ui().selectedClips.filter((r) => r.slot === undefined)
  const p0 = getProject()
  const targets = sel.length
    ? sel
    : p0.tracks.flatMap((t) => t.clips.filter((c) => c.start < beat && c.start + c.length > beat).map((c) => ({ trackId: t.id, clipId: c.id })))
  if (!targets.length) return
  edit((p) => {
    for (const r of targets) {
      const found = resolveClip(p, r)
      if (!found) continue
      const { track, clip } = found
      if (!(clip.start < beat && clip.start + clip.length > beat)) continue
      const cut = beat - clip.start
      const right = cloneClip(clip)
      right.start = beat
      right.length = clip.length - cut
      clip.length = cut
      if (clip.kind === 'midi' && right.kind === 'midi') {
        right.notes = right.notes.filter((n) => n.start >= cut).map((n) => ({ ...n, start: n.start - cut }))
        clip.notes = clip.notes.filter((n) => n.start < cut).map((n) => ({ ...n, dur: Math.min(n.dur, cut - n.start) }))
      } else if (clip.kind === 'audio' && right.kind === 'audio') {
        right.offset = clip.offset + cut * srcSecPerBeat(clip, p.bpm)
        right.fadeIn = 0
        clip.fadeOut = 0
      }
      track.clips.push(right)
    }
  }, { label: 'Split' })
}

export function quantizeClip(ref: ClipRef, grid: number, strength = 1) {
  updateClip(ref, (c) => {
    if (c.kind !== 'midi') return
    for (const n of c.notes) {
      const target = Math.round(n.start / grid) * grid
      n.start += (target - n.start) * strength
    }
  })
}

// ───────────────────────── Audio import ─────────────────────────
/** Audio and video types the importer accepts (the browser decodes most; FFmpeg on the backend the rest). */
export const MEDIA_ACCEPT =
  'audio/*,video/*,.wav,.wave,.aif,.aiff,.aifc,.flac,.mp3,.ogg,.oga,.opus,.m4a,.m4b,.aac,.alac,.caf,.wma,.ac3,.amr,.wv,.ape,.mka,.w64,' +
  '.mp4,.m4v,.mov,.mkv,.webm,.avi,.wmv,.flv,.mpg,.mpeg,.ts,.mts,.3gp,.ogv'
const VIDEO_RE = /\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|mpg|mpeg|ts|mts|m2ts|3gp|ogv)$/i
export const isVideo = (f: File) => f.type.startsWith('video/') || VIDEO_RE.test(f.name)
export const isMedia = (f: File) => /^(audio|video)\//.test(f.type) || isVideo(f) || /\.(wav|wave|aiff?|aifc|flac|mp3|ogg|oga|opus|m4a|m4b|aac|alac|caf|wma|ac3|amr|wv|ape|mka|w64|webm)$/i.test(f.name)
const stem = (name: string) => name.replace(/\.[a-z0-9]+$/i, '')

/**
 * Decode any audio or video file. The browser's decoder goes first (WAV, MP3, AAC/M4A, FLAC, Ogg,
 * Opus, and the audio in most MP4/WebM files); anything it can't read goes to the backend, where
 * FFmpeg handles the rest (WMA, AIFF-C, ALAC, AMR, MKV, AVI…). Returns the WAV blob when converted.
 */
export async function decodeMedia(file: Blob, name = 'file'): Promise<{ buf: AudioBuffer; blob?: Blob; converted: boolean }> {
  const big = file.size > 250 * 1024 * 1024
  if (!big) {
    try {
      return { buf: await audioCtx.decodeAudioData(await file.arrayBuffer()), converted: false }
    } catch { /* fall through to the backend */ }
  }
  const caps = await api.capabilities()
  if (!caps) throw new Error(`The browser can't decode ${name}. Start the backend (it converts with FFmpeg) or convert it to WAV/MP3 first.`)
  const r = await api.convertRemote(file instanceof File ? file : new File([file], name))
  const wav = await api.fetchAudio(r.url)
  return { buf: await audioCtx.decodeAudioData(await wav.arrayBuffer()), blob: wav, converted: true }
}

export async function decodeFile(file: Blob) {
  return (await decodeMedia(file)).buf
}

export function addAsset(buf: AudioBuffer, name: string, source: AssetMeta['source'], blob?: Blob, extra: Partial<AssetMeta> = {}) {
  const id = uid()
  registerBuffer(id, buf, blob)
  const meta: AssetMeta = { id, name, duration: buf.duration, sampleRate: buf.sampleRate, channels: buf.numberOfChannels, source, ...extra }
  useProject.setState((s) => ({ project: { ...s.project, assets: { ...s.project.assets, [id]: meta } } }))
  return meta
}

export function audioClipFor(asset: AssetMeta, start: number, bpm: number, name?: string): AudioClip {
  const clip: AudioClip = { id: uid(), kind: 'audio', name: name ?? stem(asset.name), start, length: (asset.duration * bpm) / 60, assetId: asset.id, offset: 0, gain: 0, fadeIn: 0, fadeOut: 0, transpose: 0 }
  // assets with a known tempo come in warped and trimmed to their first downbeat
  if (ui().syncOnImport && asset.bpm && asset.firstBeat !== undefined && asset.source !== 'stem') applyWarp(clip, asset, bpm)
  return clip
}

/** Lock a clip to the project tempo using its asset's tempo and first downbeat. */
export function applyWarp(clip: AudioClip, asset: AssetMeta, _projectBpm: number) {
  if (!asset.bpm) return
  clip.warp = { on: true, bpm: asset.bpm }
  const beatSec = 60 / asset.bpm
  // start on the first downbeat, but keep a pickup that's shorter than a beat out of the clip
  // a downbeat within 35 ms of the file start is the start (loops, bounced stems): don't shave the attack
  const fb = asset.firstBeat ?? 0
  clip.offset = fb < 0.035 ? 0 : fb
  // whole 16ths; a file a hair short of the next 16th (encoder padding, rounding) still gets it
  clip.length = Math.max(1, Math.floor(((asset.duration - clip.offset) / beatSec) * 4 + 0.08) / 4)
}

/** Detect tempo + first downbeat for an asset (backend librosa when available, browser otherwise). */
export async function detectTempo(assetId: string, prefer: 'fast' | 'best' = 'best') {
  const buf = buffers.get(assetId)
  if (!buf) return null
  let bpm = 0, firstBeat = 0, conf = 0
  const caps = prefer === 'best' ? await api.capabilities() : null
  if (caps) {
    try {
      const r = await api.analyzeRemote(assetBlob(assetId)!)
      const beats = r.beats ?? []
      bpm = r.bpm
      conf = r.bpm_confidence
      // librosa's tempo is the more reliable read; the browser's grid weighs kicks and bass, so it
      // places beat one (not the off-beat hat) better. Use it whenever the two agree on tempo.
      const br = estimateTempo(monoOf(buf), buf.sampleRate)
      const period = 60 / bpm
      const grid0 = beats.length ? beats[0] - Math.floor(beats[0] / period) * period : br.firstBeat
      firstBeat = Math.abs(br.bpm / bpm - 1) < 0.02 ? br.firstBeat : grid0
    } catch { /* fall back below */ }
  }
  if (!bpm) {
    const r = estimateTempo(monoOf(buf), buf.sampleRate)
    bpm = r.bpm
    firstBeat = r.firstBeat
    conf = r.confidence
  }
  bpm = tidyBpm(bpm)
  useProject.setState((s) => {
    const a = s.project.assets[assetId]
    return a ? { project: { ...s.project, assets: { ...s.project.assets, [assetId]: { ...a, bpm, firstBeat } } } } : s
  })
  return { bpm, firstBeat, confidence: conf }
}

function monoOf(buf: AudioBuffer) {
  const n = Math.min(buf.length, buf.sampleRate * 240)
  const out = new Float32Array(n)
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c)
    for (let i = 0; i < n; i++) out[i] += d[i] / buf.numberOfChannels
  }
  return out
}

/** Warp every clip that plays this asset (or just `ref`) to the project tempo. */
export async function syncToTempo(assetId: string, ref?: ClipRef) {
  const t = await detectTempo(assetId)
  if (!t) return
  const asset = getProject().assets[assetId]
  edit((p) => {
    for (const tr of p.tracks)
      for (const c of [...tr.clips, ...tr.slots])
        if (c && c.kind === 'audio' && c.assetId === assetId && (!ref || c.id === ref.clipId)) applyWarp(c, { ...asset, bpm: t.bpm, firstBeat: t.firstBeat }, p.bpm)
  }, { label: 'Sync to tempo' })
  toast(`Synced to ${getProject().bpm} BPM · source ${t.bpm} BPM, first downbeat at ${t.firstBeat.toFixed(3)} s`, 'ok')
}

/** Import an audio or video file; optionally put it on a track at `beat`. */
export async function importAudio(file: File, target?: { trackId?: string; beat?: number }) {
  const video = isVideo(file)
  const label = video ? `${stem(file.name)} (audio)` : file.name
  const busy = setTimeout(() => toast(video ? `Extracting audio from ${file.name}…` : `Decoding ${file.name}…`), 400)
  try {
    const { buf, blob, converted } = await decodeMedia(file, file.name)
    clearTimeout(busy)
    // keep the original file for backend jobs, unless it's a (large) video or was converted
    const asset = addAsset(buf, label, video ? 'video' : 'import', video ? blob : converted ? blob : file)
    let synced = ''
    if (ui().syncOnImport && buf.duration >= 3) {
      const t = await detectTempo(asset.id, 'fast')
      if (t && t.bpm >= 60 && t.bpm <= 200 && t.confidence > 0.1) synced = ` · synced from ${t.bpm} BPM`
      else useProject.setState((s) => ({ project: { ...s.project, assets: { ...s.project.assets, [asset.id]: { ...s.project.assets[asset.id], bpm: undefined, firstBeat: undefined } } } }))
    }
    const meta = getProject().assets[asset.id]
    if (target) {
      const p = getProject()
      let trackId = target.trackId
      const t = findTrack(p, trackId)
      if (!t || t.kind !== 'audio') trackId = addTrack('audio')
      edit((pp) => {
        const tr = findTrack(pp, trackId)
        if (!tr) return
        if (!t || t.kind !== 'audio') tr.name = stem(label).slice(0, 24)
        tr.clips.push(audioClipFor(meta, Math.max(0, target.beat ?? 0), pp.bpm))
      }, { label: video ? 'Import video audio' : 'Import audio' })
    }
    toast(`${video ? 'Extracted audio from' : 'Imported'} ${file.name} (${buf.duration.toFixed(1)} s)${synced}`, 'ok')
    return meta
  } catch (e) {
    clearTimeout(busy)
    toast((e as Error).message || `Couldn't read ${file.name}`, 'warn')
    console.error(e)
  }
}

export function placeAsset(assetId: string, trackId: string | undefined, beat: number) {
  const p = getProject()
  const asset = p.assets[assetId]
  if (!asset) return
  let tid = trackId
  const t = findTrack(p, tid)
  if (!t || t.kind !== 'audio') {
    tid = addTrack('audio')
    updateTrack(tid, (tr) => { tr.name = stem(asset.name).slice(0, 24) })
  }
  edit((pp) => { findTrack(pp, tid)?.clips.push(audioClipFor(asset, Math.max(0, beat), pp.bpm)) }, { label: 'Place audio' })
}

export function reverseClipAudio(ref: ClipRef) {
  const r = resolveClip(getProject(), ref)
  if (!r || r.clip.kind !== 'audio') return
  const buf = buffers.get(r.clip.assetId)
  if (!buf) return
  const meta = getProject().assets[r.clip.assetId]
  const asset = addAsset(reverseBuffer(audioCtx, buf), `${meta?.name ?? 'audio'} (reversed)`, 'render')
  updateClip(ref, (c) => { if (c.kind === 'audio') { c.assetId = asset.id; c.offset = 0 } })
}

export function normalizeClip(ref: ClipRef, targetDb = -1) {
  const r = resolveClip(getProject(), ref)
  if (!r || r.clip.kind !== 'audio') return
  const buf = buffers.get(r.clip.assetId)
  if (!buf) return
  const pk = gainToDb(bufferPeak(buf))
  updateClip(ref, (c) => { if (c.kind === 'audio') c.gain = Math.round((targetDb - pk) * 10) / 10 })
}

// ───────────────────────── Recording ─────────────────────────
engine.onRecorded = async (r) => {
  const p = getProject()
  if (r.kind === 'audio') {
    const target = p.tracks.find((t) => t.arm && t.kind === 'audio')
    if (!target) return
    try {
      const buf = await decodeFile(r.blob)
      const asset = addAsset(buf, `Take ${new Date().toLocaleTimeString()}`, 'record', r.blob)
      edit((pp) => {
        const clip = audioClipFor(asset, r.startBeat, pp.bpm)
        clip.offset = Math.min(r.latency, buf.duration / 2) // compensate output+input latency
        clip.length = ((buf.duration - clip.offset) * pp.bpm) / 60
        findTrack(pp, target.id)?.clips.push(clip)
      }, { label: 'Record audio' })
      toast('Take recorded', 'ok')
    } catch {
      toast('Recording could not be decoded', 'warn')
    }
  } else {
    const target = p.tracks.find((t) => t.arm && t.kind === 'midi') ?? findTrack(p, ui().selectedTrack)
    if (!target || target.kind !== 'midi') return
    const bar = beatsPerBar(p)
    const start = Math.floor(r.startBeat / bar) * bar
    const end = Math.max(start + bar, Math.ceil(r.endBeat / bar) * bar)
    edit((pp) => {
      findTrack(pp, target.id)?.clips.push(midiClip('Recorded', start, end - start, r.notes.map((n) => ({ ...n, start: n.start - start }))))
    }, { label: 'Record MIDI' })
    toast(`Recorded ${r.notes.length} notes`, 'ok')
  }
}

export async function toggleRecord() {
  if (engine.recording) { engine.stop(); return }
  const p = getProject()
  const armed = p.tracks.filter((t) => t.arm)
  if (!armed.length) {
    toast('Arm a track first (the ● button on its header)', 'warn')
    return
  }
  try {
    await engine.record(armed.some((t) => t.kind === 'audio'))
  } catch {
    toast('Microphone access was blocked. Allow it in the browser, or arm a MIDI track instead.', 'warn')
  }
}

// ───────────────────────── Launcher → arrangement ─────────────────────────
/** Remove [a, b) from a track's arrangement, trimming clips that straddle the edges. */
export function carve(t: Track, a: number, b: number, bpm: number) {
  const out: Clip[] = []
  for (const c of t.clips) {
    const end = c.start + c.length
    if (end <= a || c.start >= b) { out.push(c); continue }
    if (c.start < a) {
      const left = cloneClip(c)
      left.length = a - c.start
      if (left.kind === 'midi') left.notes = left.notes.filter((n) => n.start < left.length).map((n) => ({ ...n, dur: Math.min(n.dur, left.length - n.start) }))
      else left.fadeOut = 0
      out.push(left)
    }
    if (end > b) {
      const right = cloneClip(c)
      const cut = b - c.start
      right.start = b
      right.length = end - b
      if (right.kind === 'midi') right.notes = right.notes.filter((n) => n.start >= cut).map((n) => ({ ...n, start: n.start - cut }))
      else { right.offset += cut * srcSecPerBeat(right, bpm); right.fadeIn = 0 }
      out.push(right)
    }
  }
  t.clips = out
}

export function commitLaunchesToArrangement() {
  const hist = engine.takeLaunchHistory()
  if (!hist.length) { toast('Nothing to commit yet: launch some clips while the transport runs', 'info'); return }
  edit((p) => {
    for (const h of hist) {
      const t = findTrack(p, h.trackId)
      const src = t?.slots[h.slot]
      if (!t || !src) continue
      // cut the performed region out of whatever was already in the arrangement
      carve(t, h.start, h.end, p.bpm)
      for (let b = h.start; b < h.end - 1e-6; b += src.length) {
        const c = cloneClip(src)
        c.start = b
        c.length = Math.min(src.length, h.end - b)
        if (c.kind === 'midi') c.notes = c.notes.filter((n) => n.start < c.length)
        t.clips.push(c)
      }
    }
  }, { label: 'Commit performance' })
  engine.clearLaunchHistory()
  engine.backToArrangement()
  setUI({ view: 'arrange' })
  toast(`Committed ${hist.length} launched clip${hist.length > 1 ? 's' : ''} to the arrangement`, 'ok')
}

// ───────────────────────── Rendering & export ─────────────────────────
export async function renderMix() {
  const p = getProject()
  const end = Math.max(projectEndBeat(p), beatsPerBar(p))
  return renderOffline(p, { to: end, tail: 2.5 })
}

export async function exportMix(bitDepth: 16 | 24) {
  toast('Rendering mix offline…')
  const buf = await renderMix()
  const report = measureLoudness([buf.getChannelData(0), buf.getChannelData(1)], buf.sampleRate)
  const saved = download(encodeWav(buf, bitDepth), `${getProject().name} (mix, ${bitDepth}-bit).wav`)
  toast(`${saved ? 'Exported' : 'Rendered (downloads are off in the hosted demo)'} · ${report.integrated.toFixed(1)} LUFS · ${report.truePeak.toFixed(1)} dBTP`, 'ok')
  return report
}

export async function exportStems() {
  if (DEMO) { toast('Stem export needs the local app: downloads are off in the hosted demo', 'info'); return }
  const p = getProject()
  const end = Math.max(projectEndBeat(p), beatsPerBar(p))
  for (const t of p.tracks) {
    if (!t.clips.length) continue
    toast(`Rendering stem: ${t.name}`)
    const buf = await renderOffline(p, { to: end, tail: 2.5, onlyTrack: t.id })
    download(encodeWav(buf, 24), `${p.name} - ${t.name}.wav`)
  }
  toast('Stems exported (24-bit, each track with its effects and sends)', 'ok')
}

// ───────────────────────── Analysis ─────────────────────────
export type Analysis = AnalysisResult & { assetId: string }
export const analysisCache = new Map<string, Analysis>()

export async function analyzeAsset(assetId: string): Promise<Analysis | null> {
  const buf = buffers.get(assetId)
  if (!buf) return null
  const caps = await api.capabilities()
  let res: AnalysisResult
  if (caps) {
    try {
      const blob = assetBlob(assetId)!
      const r = await api.analyzeRemote(blob)
      res = {
        bpm: r.bpm, bpmConfidence: r.bpm_confidence, keyRoot: r.key_root,
        firstBeat: (() => {
          const br = estimateTempo(monoOf(buf), buf.sampleRate) // bar phase from kicks/bass (see detectTempo)
          if (Math.abs(br.bpm / r.bpm - 1) < 0.02) return br.firstBeat
          return r.beats?.length ? r.beats[0] - Math.floor(r.beats[0] / (60 / r.bpm)) * (60 / r.bpm) : 0
        })(), minor: r.minor, keyLabel: r.key_label,
        camelot: r.camelot, keyConfidence: r.key_confidence, duration: r.duration, engine: 'librosa',
        loudness: { integrated: r.lufs_integrated ?? -Infinity, shortTermMax: r.lufs_short_max ?? -Infinity, momentaryMax: r.lufs_short_max ?? -Infinity, lra: r.lra ?? 0, samplePeak: r.sample_peak ?? -Infinity, truePeak: r.true_peak ?? -Infinity },
      }
    } catch (e) {
      toast(`Backend analysis failed (${(e as Error).message}); using the in-browser estimate`, 'warn')
      res = await analyzeBuffer(buf)
    }
  } else res = await analyzeBuffer(buf)
  const out = { ...res, assetId }
  analysisCache.set(assetId, out)
  useProject.setState((s) => {
    const a = s.project.assets[assetId]
    if (!a) return s
    return { project: { ...s.project, assets: { ...s.project.assets, [assetId]: { ...a, bpm: tidyBpm(res.bpm), key: res.camelot, firstBeat: a.firstBeat ?? res.firstBeat } } } }
  })
  return out
}

export async function analyzeMix() {
  const buf = await renderMix()
  const r = measureLoudness([buf.getChannelData(0), buf.getChannelData(1)], buf.sampleRate)
  return { report: r, buffer: buf }
}

// ───────────────────────── Stems & warp (backend) ─────────────────────────
export function addStemsAsTracks(stemAssets: AssetMeta[], sourceAssetId: string) {
  const p = getProject()
  // align with the first clip that uses the source asset, otherwise the playhead
  // stems copy the source clip's position, trim and warp so they stay locked to it
  let ref: AudioClip | null = null
  for (const t of p.tracks) for (const c of t.clips) if (!ref && c.kind === 'audio' && c.assetId === sourceAssetId) ref = c
  edit((pp) => {
    for (const a of stemAssets) {
      const t = makeTrack('audio', a.name.split('·').pop()!.trim(), TRACK_COLORS[pp.tracks.length % TRACK_COLORS.length])
      t.slots = pp.scenes.map(() => null)
      const c = audioClipFor(a, ref ? ref.start : Math.round(engine.playhead), pp.bpm)
      if (ref) {
        c.offset = ref.offset
        c.length = ref.length
        c.transpose = ref.transpose
        c.warp = ref.warp ? { ...ref.warp } : undefined
        c.fadeIn = ref.fadeIn
        c.fadeOut = ref.fadeOut
      }
      t.clips.push(c)
      pp.tracks.push(t)
    }
  }, { label: 'Add stems' })
  toast(`Added ${stemAssets.length} stem tracks`, 'ok')
}

export async function warpAsset(assetId: string, stretch: number, semitones: number) {
  const blob = assetBlob(assetId)
  if (!blob) throw new Error('Audio not loaded')
  const r = await api.warpRemote(blob, stretch, semitones)
  const b = await api.fetchAudio(r.url)
  const buf = await decodeFile(b)
  const src = getProject().assets[assetId]
  return addAsset(buf, `${src?.name.replace(/\.[a-z0-9]+$/i, '') ?? 'audio'} · warped`, 'warp', b)
}

// ───────────────────────── Save / load ─────────────────────────
const AUTOSAVE_KEY = 'tessitura.autosave.v1'

export function autosave() {
  try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(getProject())) } catch { /* storage unavailable */ }
}

/** Reopen the last session: the autosaved project plus its audio from IndexedDB. */
export async function restoreSession(): Promise<boolean> {
  let saved: Project | null = null
  try { saved = JSON.parse(localStorage.getItem(AUTOSAVE_KEY) ?? 'null') } catch { saved = null }
  if (!saved || saved.version !== 1 || !Array.isArray(saved.tracks)) return false
  const ids = Object.keys(saved.assets ?? {})
  let missing = 0
  await Promise.all(ids.map(async (id) => {
    const b = await idbGet(id)
    if (!b) { missing++; return }
    try { registerBuffer(id, await audioCtx.decodeAudioData(await b.arrayBuffer()), b, { persist: false }) } catch { missing++ }
  }))
  useProject.getState().replace(saved)
  // drop cached audio no longer used by the project
  void idbKeys().then((keys) => keys.filter((k) => !ids.includes(k)).forEach((k) => void idbDelete(k)))
  toast(missing ? `Restored “${saved.name}”; ${missing} audio file${missing > 1 ? 's' : ''} need re-importing` : `Restored “${saved.name}” with ${ids.length} audio file${ids.length === 1 ? '' : 's'}`, missing ? 'warn' : 'ok')
  return true
}

export function exportProjectJson() {
  if (DEMO) { toast('Downloads are off in the hosted demo; run the app locally to save files', 'info'); return }
  const p = getProject()
  download(new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' }), `${p.name}.tessitura.json`)
}

export async function saveToBackend() {
  const p = getProject()
  const caps = await api.capabilities(true)
  if (!caps) {
    exportProjectJson()
    toast('Backend offline, so the project was downloaded as JSON (audio stays in this session)', 'warn')
    return
  }
  const have = new Set(await api.existingAssets(p.name))
  const upload: Record<string, Blob> = {}
  for (const id of Object.keys(p.assets)) if (!have.has(id)) { const b = assetBlob(id); if (b) upload[id] = b }
  const r = await api.saveProject(p, upload)
  toast(`Saved “${p.name}” as version ${r.version}`, 'ok')
}

export async function openFromBackend(name: string) {
  const { project, assets } = await api.loadProject(name)
  for (const [id, url] of Object.entries(assets)) {
    try {
      const b = await api.fetchAudio(url)
      registerBuffer(id, await decodeFile(b), b)
    } catch { /* missing asset: clip will be silent */ }
  }
  engine.stop()
  useProject.getState().replace(project)
  setUI({ editing: null, selectedClips: [], selectedTrack: project.tracks[0]?.id ?? null })
  toast(`Opened “${name}”`, 'ok')
}

export async function importProjectJson(file: File) {
  try {
    const p = JSON.parse(await file.text()) as Project
    if (p.version !== 1 || !Array.isArray(p.tracks)) throw new Error('bad')
    useProject.getState().replace(p)
    toast(`Loaded ${p.name}. Audio clips need their files re-imported.`, 'info')
  } catch {
    toast('That file is not a Tessitura project', 'warn')
  }
}

// ───────────────────────── Demo audio ─────────────────────────
/** Render the demo's “Texture Loop” so the audio track has something real on it. */
export async function ensureDemoAudio() {
  const p = getProject()
  const loop = p.tracks.find((t) => t.name === 'Texture Loop')
  if (!loop || loop.clips.length) return
  const bpm = p.bpm
  const spb = 60 / bpm
  const beats = 16
  const sr = 44100
  const ctx = new OfflineAudioContext(2, Math.ceil(beats * spb * sr), sr)
  const synth = new Synth(ctx, { ...SYNTH_PRESETS['Glass Pluck'], gain: -8, cutoff: 1100, release: 0.6 })
  const dl = ctx.createDelay(2)
  dl.delayTime.value = spb * 0.75
  const fb = ctx.createGain()
  fb.gain.value = 0.45
  const pan = ctx.createStereoPanner()
  pan.pan.value = 0.35
  synth.out.connect(ctx.destination)
  synth.out.connect(dl).connect(fb).connect(dl)
  fb.connect(pan).connect(ctx.destination)
  const arp = [66, 69, 73, 76, 62, 66, 69, 74, 61, 64, 69, 73, 64, 68, 71, 76]
  for (let i = 0; i < beats * 2; i++) {
    const pitch = arp[(Math.floor(i / 8) * 4 + (i % 4)) % arp.length] + (i % 8 >= 4 ? 12 : 0)
    synth.noteOn(pitch, 0.5 + 0.3 * ((i * 7) % 3) / 2, i * spb * 0.5, spb * 0.4)
  }
  const buf = await ctx.startRendering()
  // normalise the render to −3 dBFS so the waveform reads clearly
  const pk = bufferPeak(buf) || 1
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c)
    for (let i = 0; i < d.length; i++) d[i] *= 0.708 / pk
  }
  const asset = addAsset(buf, 'Texture Loop.wav', 'demo', undefined, { bpm, key: camelot(6, true) })
  useProject.setState((s) => {
    const project = structuredClone(s.project)
    const t = project.tracks.find((x) => x.name === 'Texture Loop')
    if (t) {
      const c1 = audioClipFor(asset, 16, bpm, 'Texture')
      c1.fadeIn = 2
      const c2 = audioClipFor(asset, 32, bpm, 'Texture')
      c2.fadeOut = 4
      t.clips = [c1, c2]
      t.slots[1] = audioClipFor(asset, 0, bpm, 'Texture')
    }
    return { project }
  })
}

export const keyName = (root: number, minor: boolean) => `${NOTE_NAMES[root]} ${minor ? 'minor' : 'major'}`
export const hasBlob = (id: string) => blobs.has(id) || buffers.has(id)
