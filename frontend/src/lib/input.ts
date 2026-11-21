// Global keyboard shortcuts, the computer-keyboard piano, and Web MIDI input.
import { engine } from '../engine'
import { deleteSelectedClips, duplicateSelectedClips, quantizeClip, saveToBackend, splitClipsAt, toggleRecord, updateTrack } from '../state/actions'
import { edit, getProject, setUI, toast, ui, useProject } from '../state/store'

const PIANO: Record<string, number> = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15 }
let octave = 4
let velocity = 0.8
const held = new Map<string, { track: string; pitch: number }>()

/** The track that receives live notes: an armed MIDI track, else the selected one. */
function liveTrack() {
  const p = getProject()
  const armed = p.tracks.find((t) => t.arm && t.kind === 'midi')
  if (armed) return armed.id
  const sel = p.tracks.find((t) => t.id === ui().selectedTrack && t.kind === 'midi')
  return sel?.id ?? p.tracks.find((t) => t.kind === 'midi')?.id
}

function typing(e: KeyboardEvent) {
  const t = e.target as HTMLElement
  return t.closest('input, textarea, select, [contenteditable="true"]') !== null
}

export function installInput() {
  const down = (e: KeyboardEvent) => {
    if (typing(e)) return
    const s = ui()
    const mod = e.metaKey || e.ctrlKey
    const k = e.key.toLowerCase()

    if (mod && k === 'k') { setUI({ paletteOpen: !s.paletteOpen }); e.preventDefault(); return }
    if (s.paletteOpen || s.helpOpen) { if (e.key === 'Escape') setUI({ paletteOpen: false, helpOpen: false }); return }
    if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) useProject.getState().redo(); else useProject.getState().undo(); return }
    if (mod && k === 'y') { e.preventDefault(); useProject.getState().redo(); return }
    if (mod && k === 's') { e.preventDefault(); void saveToBackend(); return }
    if (mod && k === 'd') { e.preventDefault(); duplicateSelectedClips(); return }
    if (mod && k === 'b') { e.preventDefault(); setUI({ showBrowser: !s.showBrowser }); return }
    if (mod && k === 'i') { e.preventDefault(); setUI({ showInspector: !s.showInspector }); return }
    if (mod) return

    if (e.key === ' ') { e.preventDefault(); if (engine.playing) engine.stop(); else void engine.play(); return }
    if (e.key === '`') { setUI({ qwerty: !s.qwerty }); toast(s.qwerty ? 'Keyboard piano off' : 'Keyboard piano on: A–K play notes, Z/X change octave'); return }

    // computer keyboard piano takes over letter keys while on
    if (s.qwerty) {
      if (k === 'z') { octave = Math.max(0, octave - 1); toast(`Octave C${octave}`); return }
      if (k === 'x') { octave = Math.min(8, octave + 1); toast(`Octave C${octave}`); return }
      if (k === 'c') { velocity = Math.max(0.1, velocity - 0.1); toast(`Velocity ${Math.round(velocity * 127)}`); return }
      if (k === 'v') { velocity = Math.min(1, velocity + 0.1); toast(`Velocity ${Math.round(velocity * 127)}`); return }
      if (k in PIANO) {
        if (e.repeat || held.has(k)) return
        const track = liveTrack()
        if (!track) return
        const pitch = (octave + 1) * 12 + PIANO[k]
        held.set(k, { track, pitch })
        engine.liveNoteOn(track, pitch, velocity)
        return
      }
    }

    if (e.key === 'Tab') { e.preventDefault(); setUI({ view: s.view === 'arrange' ? 'launch' : 'arrange' }); return }
    if (e.key === 'Home') { engine.relocate(0); return }
    if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelectedClips(); return }
    if (e.key === '?') { setUI({ helpOpen: true }); return }
    switch (k) {
      case 'r': void toggleRecord(); break
      case 'l': edit((p) => { p.loop.on = !p.loop.on }); break
      case 'k': setUI({ metronome: !s.metronome }); break
      case 's': splitClipsAt(engine.position()); break
      case 'e': if (s.dock === 'editor' && s.dockOpen && s.editing) setUI({ tool: 'erase' }); else setUI({ dock: 'editor', dockOpen: true }); break
      case 'x': setUI({ dock: 'mixer', dockOpen: true }); break
      case 'a': setUI({ dock: 'analysis', dockOpen: true }); break
      case 'b': setUI({ tool: 'draw' }); break
      case 'v': setUI({ tool: 'select' }); break
      case 'q': if (s.editing) quantizeClip(s.editing, s.snap || 0.25); break
      case 'm': if (s.selectedTrack && s.selectedTrack !== 'master') updateTrack(s.selectedTrack, (t) => { t.mute = !t.mute }); break
      case ';': edit((p) => { p.markers.push({ id: Math.random().toString(36).slice(2, 10), beat: Math.round(engine.position()), name: `M${p.markers.length + 1}` }); p.markers.sort((a, b) => a.beat - b.beat) }); break
    }
  }
  const up = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase()
    const h = held.get(k)
    if (h) { engine.liveNoteOff(h.track, h.pitch); held.delete(k) }
  }
  window.addEventListener('keydown', down)
  window.addEventListener('keyup', up)
  window.addEventListener('blur', () => { for (const h of held.values()) engine.liveNoteOff(h.track, h.pitch); held.clear() })

  // Web MIDI (Chrome/Edge; permission prompts are handled by the browser)
  const nav = navigator as Navigator & { requestMIDIAccess?: () => Promise<MIDIAccess> }
  if (nav.requestMIDIAccess) {
    nav.requestMIDIAccess().then((access) => {
      const bind = () => {
        let n = 0
        access.inputs.forEach((input) => {
          n++
          input.onmidimessage = (m: MIDIMessageEvent) => {
            const [st, d1, d2] = m.data ?? []
            const cmd = st & 0xf0
            const track = liveTrack()
            if (!track) return
            if (cmd === 0x90 && d2 > 0) engine.liveNoteOn(track, d1, d2 / 127)
            else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) engine.liveNoteOff(track, d1)
          }
        })
        window.dispatchEvent(new CustomEvent('tessitura:midi', { detail: n }))
      }
      bind()
      access.onstatechange = bind
    }).catch(() => { /* MIDI unavailable or denied */ })
  }
}
