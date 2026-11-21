import { useSyncExternalStore } from 'react'
import { Engine } from './engine'
import { loadLimiter } from './limiter'
import { ensureStretched, onStretched, stretchBusy } from './stretch'
import { onAssets } from './assets'
import { isWarped, stretchFactor } from '../state/clip'
import type { Project } from '../state/types'
import { useProject, useUI } from '../state/store'

const AC: typeof AudioContext = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
export const audioCtx = new AC({ latencyHint: 'interactive' })
export const engine = new Engine(audioCtx, true)

engine.sync(useProject.getState().project)
void loadLimiter(audioCtx).then((ok) => ok && engine.rebuildDevices())
useProject.subscribe((s, prev) => {
  if (s.project !== prev.project) engine.sync(s.project)
})
// Keep stretched copies of warped clips ready for the current tempo, and re-sync playback
// once they arrive (clips play grid-locked with varispeed in the meantime).
let warpTimer: ReturnType<typeof setTimeout> | undefined
function prepareWarps(p: Project) {
  clearTimeout(warpTimer)
  warpTimer = setTimeout(() => {
    for (const t of p.tracks)
      for (const c of [...t.clips, ...t.slots])
        if (c && c.kind === 'audio' && isWarped(c)) void ensureStretched(c.assetId, stretchFactor(c, p.bpm))
  }, 150)
}
prepareWarps(useProject.getState().project)
useProject.subscribe((s, prev) => { if (s.project !== prev.project) prepareWarps(s.project) })
onAssets(() => prepareWarps(useProject.getState().project))
onStretched(() => {
  if (stretchBusy() === 0 && engine.playing) engine.relocate(engine.position())
})

useUI.subscribe((s) => {
  engine.metronome = s.metronome
})

// Browsers start audio suspended until a user gesture.
const unlock = () => {
  void audioCtx.resume()
  if (audioCtx.state === 'running') {
    window.removeEventListener('pointerdown', unlock)
    window.removeEventListener('keydown', unlock)
  }
}
window.addEventListener('pointerdown', unlock)
window.addEventListener('keydown', unlock)

export function useEngine() {
  return useSyncExternalStore(engine.subscribe, engine.getSnapshot)
}

// ── A single rAF clock for meters and playheads (drawn imperatively, no React renders) ──
type FrameFn = (pos: number) => void
const frameFns = new Set<FrameFn>()
function loop() {
  if (frameFns.size) {
    const pos = engine.position()
    frameFns.forEach((f) => f(pos))
  }
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)
export function onFrame(fn: FrameFn) {
  frameFns.add(fn)
  return () => { frameFns.delete(fn) }
}
