import { create } from 'zustand'
import { demoProject } from './defaults'
import type { AutoParam, Clip, DockTab, ID, Project, Tool, Track, ViewName } from './types'
import type { ChordShape } from '../lib/music'

// ───────────────────────── Project store (undoable) ─────────────────────────
interface ProjectState {
  project: Project
  past: Project[]
  future: Project[]
  lastLabel: string
  edit: (fn: (p: Project) => void, opts?: { coalesce?: string; label?: string }) => void
  replace: (p: Project) => void
  undo: () => void
  redo: () => void
}

const HISTORY_LIMIT = 150
let lastCoalesce = ''
let lastCoalesceAt = 0

export const useProject = create<ProjectState>((set, get) => ({
  project: demoProject(),
  past: [],
  future: [],
  lastLabel: '',
  edit(fn, opts) {
    const cur = get().project
    const next = structuredClone(cur)
    fn(next)
    const now = performance.now()
    // 'g:' keys identify one pointer gesture and always merge; other keys merge within 1.2 s
    const merge = !!opts?.coalesce && opts.coalesce === lastCoalesce && (opts.coalesce.startsWith('g:') || now - lastCoalesceAt < 1200)
    lastCoalesce = opts?.coalesce ?? ''
    lastCoalesceAt = now
    set((s) => ({
      project: next,
      past: merge ? s.past : [...s.past.slice(-HISTORY_LIMIT), cur],
      future: [],
      lastLabel: opts?.label ?? s.lastLabel,
    }))
  },
  replace(p) {
    set({ project: p, past: [], future: [] })
  },
  undo() {
    const { past, project, future } = get()
    if (!past.length) return
    lastCoalesce = ''
    // imported audio, stems and renders are never taken away by undo: keep today's asset list
    const prev = past[past.length - 1]
    set({ project: { ...prev, assets: { ...prev.assets, ...project.assets } }, past: past.slice(0, -1), future: [project, ...future] })
  },
  redo() {
    const { past, project, future } = get()
    if (!future.length) return
    lastCoalesce = ''
    const next = future[0]
    set({ project: { ...next, assets: { ...next.assets, ...project.assets } }, past: [...past, project], future: future.slice(1) })
  },
}))

export const edit = (fn: (p: Project) => void, opts?: { coalesce?: string; label?: string }) => useProject.getState().edit(fn, opts)
export const getProject = () => useProject.getState().project

export function allTracks(p: Project): Track[] {
  return [...p.tracks, ...p.returns]
}
export function findTrack(p: Project, id: ID | null | undefined): Track | undefined {
  if (!id) return undefined
  return p.tracks.find((t) => t.id === id) ?? p.returns.find((t) => t.id === id)
}

export interface ClipRef {
  trackId: ID
  clipId: ID
  slot?: number // present when the clip lives in a launcher slot
}

export function resolveClip(p: Project, ref: ClipRef | null): { track: Track; clip: Clip } | null {
  if (!ref) return null
  const track = findTrack(p, ref.trackId)
  if (!track) return null
  const clip = ref.slot !== undefined ? track.slots[ref.slot] : track.clips.find((c) => c.id === ref.clipId)
  if (!clip || clip.id !== ref.clipId) return null
  return { track, clip }
}

/** Beats per bar for the current time signature (quarter-note beats). */
export const beatsPerBar = (p: Project) => (p.timeSig[0] * 4) / p.timeSig[1]

export function projectEndBeat(p: Project) {
  let end = 0
  for (const t of p.tracks) for (const c of t.clips) end = Math.max(end, c.start + c.length)
  return end
}

// ───────────────────────── UI store (not undoable) ─────────────────────────
export type Snap = 0 | 0.125 | 0.25 | 0.5 | 1 | 4

interface UIState {
  view: ViewName
  dock: DockTab
  dockOpen: boolean
  dockHeight: number
  showBrowser: boolean
  showInspector: boolean
  selectedTrack: ID | null
  selectedClips: ClipRef[]
  editing: ClipRef | null
  pxPerBeat: number
  snap: Snap
  tool: Tool
  chord: ChordShape
  scaleLock: boolean
  foldScale: boolean
  follow: boolean
  metronome: boolean
  qwerty: boolean
  paletteOpen: boolean
  helpOpen: boolean
  hint: string
  toast: { text: string; tone: 'info' | 'ok' | 'warn' } | null
  launchQuantize: 0 | 1 | 4
  analysisAsset: ID | null
  syncOnImport: boolean
  tuning: ClipRef | null
  set: (patch: Partial<UIState>) => void
}

export const useUI = create<UIState>((set) => ({
  view: 'arrange',
  dock: 'editor',
  dockOpen: true,
  dockHeight: 360,
  showBrowser: true,
  showInspector: true,
  selectedTrack: null,
  selectedClips: [],
  editing: null,
  pxPerBeat: 22,
  snap: 0.25,
  tool: 'draw',
  chord: 'off',
  scaleLock: false,
  foldScale: false,
  follow: true,
  metronome: false,
  qwerty: false,
  paletteOpen: false,
  helpOpen: false,
  hint: '',
  toast: null,
  launchQuantize: 4,
  analysisAsset: null,
  syncOnImport: (() => { try { return localStorage.getItem('tessitura.sync') !== '0' } catch { return true } })(),
  tuning: null,
  set: (patch) => set(patch),
}))

export const ui = () => useUI.getState()
export const setUI = (patch: Partial<UIState>) => useUI.getState().set(patch)

let toastTimer: ReturnType<typeof setTimeout> | undefined
export function toast(text: string, tone: 'info' | 'ok' | 'warn' = 'info') {
  setUI({ toast: { text, tone } })
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => setUI({ toast: null }), 3200)
}

export const AUTO_LABELS: Record<AutoParam, string> = {
  volume: 'Volume',
  pan: 'Pan',
  sendA: 'Send A',
  sendB: 'Send B',
  cutoff: 'Synth cutoff',
}

let gestureSeq = 0
/** A fresh coalesce key for one drag gesture (all its edits become one undo step). */
export const gestureKey = () => `g:${++gestureSeq}`

export function snapBeat(b: number, snap: number) {
  if (!snap) return b
  return Math.round(b / snap) * snap
}
