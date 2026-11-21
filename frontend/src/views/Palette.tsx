import { useEffect, useMemo, useRef, useState } from 'react'
import { engine } from '../engine'
import {
  addTrack, commitLaunchesToArrangement, syncToTempo, importAudio, MEDIA_ACCEPT, ensureDemoAudio, deleteSelectedClips, duplicateSelectedClips, exportMix, exportProjectJson, exportStems, saveToBackend, splitClipsAt, toggleRecord, addDevice,
} from '../state/actions'
import { DEVICE_SPECS, SYNTH_PRESETS, DRUM_PRESETS, demoProject, emptyProject } from '../state/defaults'
import { edit, resolveClip, setUI, toast, ui, useProject, useUI } from '../state/store'
import { NOTE_NAMES, SCALES } from '../lib/music'
import type { DeviceType, ScaleName } from '../state/types'

interface Cmd { id: string; label: string; group: string; hint?: string; run: () => void }

function selAudio() {
  const ref = ui().editing ?? ui().selectedClips[0]
  if (!ref) return null
  const r = resolveClip(useProject.getState().project, ref)
  return r && r.clip.kind === 'audio' ? { ref, clip: r.clip } : null
}

function pickFiles(accept: string) {
  const inp = document.createElement('input')
  inp.type = 'file'
  inp.accept = accept
  inp.multiple = true
  inp.onchange = () => [...(inp.files ?? [])].forEach((f) => void importAudio(f, { beat: 0 }))
  inp.click()
}

function commands(): Cmd[] {
  const sel = ui().selectedTrack
  const list: Cmd[] = [
    { id: 'play', group: 'Transport', label: 'Play / stop', hint: 'Space', run: () => (engine.playing ? engine.stop() : void engine.play()) },
    { id: 'rec', group: 'Transport', label: 'Record on armed tracks', hint: 'R', run: () => void toggleRecord() },
    { id: 'loop', group: 'Transport', label: 'Toggle loop', hint: 'L', run: () => edit((q) => { q.loop.on = !q.loop.on }) },
    { id: 'click', group: 'Transport', label: 'Toggle metronome', hint: 'K', run: () => setUI({ metronome: !ui().metronome }) },
    { id: 'home', group: 'Transport', label: 'Go to start', hint: 'Home', run: () => engine.relocate(0) },
    { id: 'arr', group: 'View', label: 'Arrangement view', hint: 'Tab', run: () => setUI({ view: 'arrange' }) },
    { id: 'launch', group: 'View', label: 'Clip launcher view', hint: 'Tab', run: () => setUI({ view: 'launch' }) },
    { id: 'ed', group: 'View', label: 'Open editor', hint: 'E', run: () => setUI({ dock: 'editor', dockOpen: true }) },
    { id: 'mix', group: 'View', label: 'Open mixer', hint: 'X', run: () => setUI({ dock: 'mixer', dockOpen: true }) },
    { id: 'ana', group: 'View', label: 'Open analysis & stems', hint: 'A', run: () => setUI({ dock: 'analysis', dockOpen: true }) },
    { id: 'master', group: 'View', label: 'Show master chain', run: () => setUI({ selectedTrack: 'master', showInspector: true }) },
    { id: 'qwerty', group: 'View', label: 'Toggle computer-keyboard piano', hint: '`', run: () => setUI({ qwerty: !ui().qwerty }) },
    { id: 'help', group: 'View', label: 'Keyboard shortcuts', hint: '?', run: () => setUI({ helpOpen: true }) },
    { id: 'split', group: 'Edit', label: 'Split at playhead', hint: 'S', run: () => splitClipsAt(engine.position()) },
    { id: 'dup', group: 'Edit', label: 'Duplicate selection', hint: '⌘D', run: duplicateSelectedClips },
    { id: 'del', group: 'Edit', label: 'Delete selection', hint: '⌫', run: deleteSelectedClips },
    { id: 'undo', group: 'Edit', label: 'Undo', hint: '⌘Z', run: () => useProject.getState().undo() },
    { id: 'redo', group: 'Edit', label: 'Redo', hint: '⇧⌘Z', run: () => useProject.getState().redo() },
    { id: 'syncclip', group: 'Edit', label: 'Sync selected audio clip to tempo (warp)', run: () => { const r = selAudio(); if (r) void syncToTempo(r.clip.assetId, r.ref); else toast('Select an audio clip first', 'info') } },
    { id: 'tune', group: 'Edit', label: 'Pitch-correct selected audio clip…', run: () => { const r = selAudio(); if (r) setUI({ tuning: r.ref }); else toast('Select an audio clip first', 'info') } },
    { id: 'stemsel', group: 'Edit', label: 'Separate stems of selected audio clip…', run: () => { const r = selAudio(); if (r) setUI({ dock: 'analysis', dockOpen: true, analysisAsset: r.clip.assetId }); else toast('Select an audio clip first', 'info') } },
    { id: 'importvid', group: 'File', label: 'Import audio from a video…', run: () => pickFiles('video/*,.mp4,.m4v,.mov,.mkv,.webm,.avi,.wmv,.flv,.mpg,.mpeg,.3gp') },
    { id: 'importaud', group: 'File', label: 'Import audio…', run: () => pickFiles(MEDIA_ACCEPT) },
    { id: 'commit', group: 'Launcher', label: 'Commit launcher performance to arrangement', run: commitLaunchesToArrangement },
    { id: 'back', group: 'Launcher', label: 'Back to arrangement', run: () => engine.backToArrangement() },
    { id: 'stopall', group: 'Launcher', label: 'Stop all clips', run: () => engine.stopAllClips(ui().launchQuantize) },
    { id: 'at', group: 'Tracks', label: 'Add audio track', run: () => addTrack('audio') },
    ...Object.keys(SYNTH_PRESETS).map((n) => ({ id: `s-${n}`, group: 'Tracks', label: `Add synth track · ${n}`, run: () => void addTrack('synth', n) })),
    ...Object.keys(DRUM_PRESETS).map((n) => ({ id: `d-${n}`, group: 'Tracks', label: `Add drum track · ${n}`, run: () => void addTrack('drums', n) })),
    ...(sel ? (Object.keys(DEVICE_SPECS) as DeviceType[]).map((t) => ({ id: `fx-${t}`, group: 'Devices', label: `Add ${DEVICE_SPECS[t].label} to selected track`, run: () => addDevice(sel, t) })) : []),
    { id: 'save', group: 'File', label: 'Save version', hint: '⌘S', run: () => void saveToBackend() },
    { id: 'wav24', group: 'File', label: 'Export mix · WAV 24-bit', run: () => void exportMix(24) },
    { id: 'wav16', group: 'File', label: 'Export mix · WAV 16-bit dithered', run: () => void exportMix(16) },
    { id: 'stems', group: 'File', label: 'Export track stems', run: () => void exportStems() },
    { id: 'json', group: 'File', label: 'Download project JSON', run: exportProjectJson },
    { id: 'new', group: 'File', label: 'New empty project', run: () => { engine.stop(); useProject.getState().replace(emptyProject()); toast('New project', 'ok') } },
    { id: 'demo', group: 'File', label: 'Load the demo project', run: () => { engine.stop(); useProject.getState().replace(demoProject()); void ensureDemoAudio(); toast('Demo loaded. The texture loop renders in a moment.', 'ok') } },
    ...[60, 70, 80, 90, 100, 110, 120, 128, 140, 160, 174].map((b) => ({ id: `bpm-${b}`, group: 'Tempo', label: `Set tempo to ${b} BPM`, run: () => edit((q) => { q.bpm = b }) })),
    ...NOTE_NAMES.flatMap((n, i) =>
      (['major', 'minor'] as ScaleName[]).map((s) => ({ id: `key-${i}-${s}`, group: 'Key', label: `Set key: ${n} ${SCALES[s].label.toLowerCase()}`, run: () => edit((q) => { q.key = { root: i, scale: s } }) })),
    ),
  ]
  return list
}

function score(label: string, q: string) {
  if (!q) return 1
  const l = label.toLowerCase()
  const norm = q.toLowerCase().replace(/#/g, '♯').replace(/\b([a-g])b\b/g, '$1♭')
  const words = norm.split(/\s+/).filter(Boolean)
  let s = 0
  for (const w of words) {
    const i = l.indexOf(w)
    if (i < 0) return 0
    s += i === 0 || l[i - 1] === ' ' ? 3 : 1
  }
  return s
}

export function Palette() {
  const open = useUI((s) => s.paletteOpen)
  // mount fresh on every open so the query and highlight always start empty
  return open ? <PaletteDialog /> : null
}

function PaletteDialog() {
  const open = true
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const all = useMemo(() => (open ? commands() : []), [open])
  const results = useMemo(() => all.map((c) => ({ c, s: score(`${c.group} ${c.label}`, q) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 60).map((x) => x.c), [all, q])
  useEffect(() => { setI(0) }, [q])
  useEffect(() => { listRef.current?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' }) }, [i])
  const run = (c: Cmd) => { setUI({ paletteOpen: false }); c.run() }
  return (
    <div className="fixed inset-0 z-[90] flex items-start justify-center bg-black/50 pt-[12vh]" onPointerDown={() => setUI({ paletteOpen: false })}>
      <div className="w-[560px] max-w-[92vw] overflow-hidden rounded-[10px] border border-line bg-ink-2 shadow-[0_24px_64px_rgba(0,0,0,0.6)]" onPointerDown={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <input
          id="palette-input"
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Type a command: “add drums”, “export”, “key f# minor”, “tempo 128”…"
          className="h-[46px] w-full border-b border-line bg-transparent px-4 text-[14px] outline-none placeholder:text-fg-3"
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') setUI({ paletteOpen: false })
            if (e.key === 'ArrowDown') { setI((x) => Math.min(results.length - 1, x + 1)); e.preventDefault() }
            if (e.key === 'ArrowUp') { setI((x) => Math.max(0, x - 1)); e.preventDefault() }
            if (e.key === 'Enter' && results[i]) run(results[i])
          }}
        />
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto p-1">
          {results.length === 0 && <div className="px-3 py-4 text-[12px] text-fg-3">No matching command.</div>}
          {results.map((c, k) => (
            <button
              key={c.id}
              data-i={k}
              onPointerEnter={() => setI(k)}
              onClick={() => run(c)}
              className={`flex w-full items-center gap-3 rounded-[5px] px-3 py-[7px] text-left text-[13px] ${k === i ? 'bg-ink-3' : ''}`}
            >
              <span className="w-[68px] shrink-0 text-[10px] font-semibold uppercase tracking-wider text-fg-3">{c.group}</span>
              <span className="flex-1 truncate">{c.label}</span>
              {c.hint && <span className="num text-[10px] text-fg-3">{c.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
