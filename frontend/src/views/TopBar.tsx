import { useEffect, useRef, useState } from 'react'
import { engine, onFrame, useEngine } from '../engine'
import { exportMix, exportProjectJson, exportStems, importProjectJson, saveToBackend, toggleRecord } from '../state/actions'
import { beatsPerBar, edit, setUI, useProject, useUI } from '../state/store'
import { formatBBT, formatTime, NOTE_NAMES, SCALES } from '../lib/music'
import { Icon } from '../ui/icons'
import { Menu, MenuItem, NumberField, Segmented } from '../ui/controls'
import type { ScaleName } from '../state/types'

function Position() {
  const bbt = useRef<HTMLSpanElement>(null)
  const time = useRef<HTMLSpanElement>(null)
  useEffect(
    () =>
      onFrame((pos) => {
        const p = useProject.getState().project
        if (bbt.current) bbt.current.textContent = formatBBT(pos, beatsPerBar(p))
        if (time.current) time.current.textContent = formatTime((pos * 60) / p.bpm)
      }),
    [],
  )
  return (
    <div className="flex h-[34px] min-w-[132px] shrink-0 flex-col justify-center rounded-[6px] bg-ink-0 px-3 ring-1 ring-line ring-inset" data-help="Playhead position: bar.beat.sixteenth and minutes:seconds">
      <span ref={bbt} className="num text-[15px] font-medium leading-none text-tape">1.1.1</span>
      <span ref={time} className="num mt-[3px] text-[10px] leading-none text-fg-3">0:00.00</span>
    </div>
  )
}

function Loudness() {
  const m = useRef<HTMLSpanElement>(null)
  const i = useRef<HTMLSpanElement>(null)
  useEffect(
    () =>
      onFrame(() => {
        const l = engine.loudness
        const f = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '—')
        if (m.current) m.current.textContent = f(l.momentary)
        if (i.current) {
          i.current.textContent = f(l.integrated)
          i.current.style.color = !Number.isFinite(l.integrated) ? '' : l.integrated > -9 ? 'var(--color-rec)' : l.integrated > -13 ? 'var(--color-warn)' : 'var(--color-ok)'
        }
      }),
    [],
  )
  return (
    <div className="hidden h-[34px] shrink-0 items-center gap-3 rounded-[6px] bg-ink-0 px-3 ring-1 ring-line ring-inset min-[1440px]:flex" data-help="Master loudness (BS.1770 K-weighted). M = momentary 400 ms, I = integrated since play started. Streaming target: −14 LUFS.">
      <div className="flex flex-col"><span className="label !text-[9px]">M lufs</span><span ref={m} className="num text-[12px] leading-none text-fg-2">—</span></div>
      <div className="flex flex-col"><span className="label !text-[9px]">I lufs</span><span ref={i} className="num text-[12px] leading-none">—</span></div>
    </div>
  )
}

function TapTempo() {
  const taps = useRef<number[]>([])
  return (
    <button
      className="btn btn-ghost h-[22px] px-2 text-[10px]"
      data-help="Tap tempo: click in time with the music (4+ taps)"
      onClick={() => {
        const now = performance.now()
        taps.current = [...taps.current.filter((t) => now - t < 2500), now].slice(-8)
        const t = taps.current
        if (t.length >= 3) {
          const avg = (t[t.length - 1] - t[0]) / (t.length - 1)
          const bpm = Math.round((60000 / avg) * 10) / 10
          edit((p) => { p.bpm = Math.min(240, Math.max(40, bpm)) }, { coalesce: 'bpm' })
        }
      }}
    >
      TAP
    </button>
  )
}

export function TopBar() {
  const project = useProject((s) => s.project)
  const canUndo = useProject((s) => s.past.length > 0)
  const canRedo = useProject((s) => s.future.length > 0)
  const { view, metronome, showBrowser, showInspector, qwerty } = useUI()
  const eng = useEngine()
  const [naming, setNaming] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  return (
    <header className="flex h-[48px] shrink-0 items-center gap-3 border-b border-line bg-ink-1 px-3 [&>*]:shrink-0">
      <div className="flex shrink-0 items-baseline gap-2">
        <span className="font-display text-[19px] font-semibold tracking-tight text-fg">Tessitura</span>
        {naming ? (
          <input
            autoFocus
            defaultValue={project.name}
            className="field h-[22px] w-[140px]"
            onBlur={(e) => { edit((p) => { p.name = e.target.value || 'Untitled' }); setNaming(false) }}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          />
        ) : (
          <button className="hidden max-w-[160px] truncate text-[12px] text-fg-3 hover:text-fg-2 min-[1400px]:inline" onClick={() => setNaming(true)} data-help="Project name, click to rename">
            {project.name}
          </button>
        )}
      </div>

      <div className="mx-1 h-6 w-px bg-line" />

      {/* Transport */}
      <div className="flex items-center gap-1">
        <button className="btn btn-ghost size-[30px] p-0" onClick={() => engine.relocate(0)} data-help="Go to start (Home)" aria-label="Go to start">
          <Icon name="back" size={15} />
        </button>
        <button
          className={`btn size-[34px] p-0 ${eng.playing ? 'bg-tape text-[#1a1204] hover:bg-tape' : ''}`}
          onClick={() => (eng.playing ? engine.stop() : engine.play())}
          data-help="Play / stop (Space). Press stop twice to return to the start."
          aria-label={eng.playing ? 'Stop' : 'Play'}
        >
          <Icon name={eng.playing ? 'stop' : 'play'} size={16} />
        </button>
        <button
          className={`btn size-[30px] p-0 ${eng.recording ? 'animate-blink bg-rec text-white hover:bg-rec' : 'btn-ghost text-rec/80'}`}
          onClick={() => void toggleRecord()}
          data-help="Record onto armed tracks (R). Audio tracks use your microphone/interface; MIDI tracks record the on-screen, computer or MIDI keyboard."
          aria-label="Record"
        >
          <Icon name="record" size={15} />
        </button>
        <button
          className={`btn size-[30px] p-0 ${project.loop.on ? 'bg-cv/20 text-cv hover:bg-cv/25' : 'btn-ghost'}`}
          onClick={() => edit((p) => { p.loop.on = !p.loop.on })}
          data-help="Loop the region shown on the ruler (L). Drag on the ruler's top strip to set it."
          aria-label="Loop"
        >
          <Icon name="loop" size={15} />
        </button>
        <button
          className={`btn size-[30px] p-0 ${metronome ? 'bg-ink-4 text-tape' : 'btn-ghost'}`}
          onClick={() => setUI({ metronome: !metronome })}
          data-help="Metronome click (K)"
          aria-label="Metronome"
        >
          <Icon name="metronome" size={15} />
        </button>
      </div>

      <Position />

      <div className="flex items-center gap-1" data-help="Tempo in BPM. Drag, wheel, or double-click to type.">
        <NumberField
          id="tempo"
          value={project.bpm}
          min={40}
          max={240}
          step={0.1}
          width={58}
          help="Tempo (BPM)"
          format={(v) => v.toFixed(1)}
          onChange={(v) => edit((p) => { p.bpm = v }, { coalesce: 'bpm' })}
        />
        <span className="label">bpm</span>
        <TapTempo />
      </div>

      <Menu
        width={260}
        trigger={(open) => (
          <button className="btn btn-ghost h-[26px] gap-1 px-2" onClick={open} data-help="Project key and scale. Drives scale highlighting, scale lock, chord stamps and key matching.">
            <span className="text-fg">{NOTE_NAMES[project.key.root]}</span>
            <span className="text-fg-3">{SCALES[project.key.scale].label.toLowerCase()}</span>
            <Icon name="chevronDown" size={12} />
          </button>
        )}
      >
        {(close) => (
          <div className="p-1">
            <div className="label mb-1 px-1">Root</div>
            <div className="mb-2 grid grid-cols-6 gap-1">
              {NOTE_NAMES.map((n, i) => (
                <button key={n} onClick={() => edit((p) => { p.key.root = i })} className={`h-6 rounded-[4px] text-[11px] ${project.key.root === i ? 'bg-tape text-[#1a1204]' : 'bg-ink-3 hover:bg-ink-4'}`}>
                  {n}
                </button>
              ))}
            </div>
            <div className="label mb-1 px-1">Scale</div>
            {(Object.keys(SCALES) as ScaleName[]).map((s) => (
              <MenuItem key={s} onClick={() => { edit((p) => { p.key.scale = s }); close() }}>
                <span className={project.key.scale === s ? 'text-tape' : ''}>{SCALES[s].label}</span>
              </MenuItem>
            ))}
          </div>
        )}
      </Menu>

      <Loudness />

      <div className="!shrink flex-1" />

      <Segmented
        value={view}
        onChange={(v) => setUI({ view: v })}
        help="Switch between the linear arrangement and the clip launcher (Tab)"
        options={[
          { value: 'arrange', label: <><Icon name="arrange" size={13} /> Arrange</>, title: 'Arrangement timeline (Tab)' },
          { value: 'launch', label: <><Icon name="grid" size={13} /> Launch</>, title: 'Clip launcher (Tab)' },
        ]}
      />

      <div className="mx-1 h-6 w-px bg-line" />

      <div className="flex items-center gap-[2px]">
        <button className="btn btn-ghost size-[28px] p-0" disabled={!canUndo} onClick={() => useProject.getState().undo()} data-help="Undo (⌘/Ctrl Z)" aria-label="Undo"><Icon name="undo" size={15} /></button>
        <button className="btn btn-ghost size-[28px] p-0" disabled={!canRedo} onClick={() => useProject.getState().redo()} data-help="Redo (⇧⌘/Ctrl Z)" aria-label="Redo"><Icon name="redo" size={15} /></button>
        <button className={`btn size-[28px] p-0 ${qwerty ? 'bg-ink-4 text-tape' : 'btn-ghost'}`} onClick={() => setUI({ qwerty: !qwerty })} data-help="Computer keyboard as a piano (`): A–K play notes, Z/X shift octave" aria-label="Computer keyboard piano"><Icon name="keyboard" size={15} /></button>
        <button className="btn btn-ghost h-[28px] gap-2 px-2" onClick={() => setUI({ paletteOpen: true })} data-help="Command palette: every action, searchable (⌘/Ctrl K)">
          <Icon name="search" size={14} /><span className="num text-[10px] text-fg-3">⌘K</span>
        </button>
      </div>

      <Menu
        align="right"
        width={250}
        trigger={(open) => (
          <button className="btn h-[28px]" onClick={open} data-help="Save, export and share">
            <Icon name="save" size={14} /> File <Icon name="chevronDown" size={12} />
          </button>
        )}
      >
        {(close) => (
          <>
            <MenuItem hint="⌘S" onClick={() => { close(); void saveToBackend() }}><Icon name="save" size={14} /> Save version</MenuItem>
            <MenuItem onClick={() => { close(); void exportMix(24) }}><Icon name="download" size={14} /> Export mix · WAV 24-bit</MenuItem>
            <MenuItem onClick={() => { close(); void exportMix(16) }}><Icon name="download" size={14} /> Export mix · WAV 16-bit dithered</MenuItem>
            <MenuItem onClick={() => { close(); void exportStems() }}><Icon name="layers" size={14} /> Export track stems</MenuItem>
            <div className="my-1 h-px bg-line" />
            <MenuItem onClick={() => { close(); exportProjectJson() }}><Icon name="download" size={14} /> Download project JSON</MenuItem>
            <MenuItem onClick={() => { close(); fileRef.current?.click() }}><Icon name="upload" size={14} /> Open project JSON…</MenuItem>
          </>
        )}
      </Menu>
      <input ref={fileRef} type="file" accept=".json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importProjectJson(f); e.target.value = '' }} />

      <div className="flex items-center gap-[2px]">
        <button className={`btn size-[28px] p-0 ${showBrowser ? 'text-fg' : 'btn-ghost'}`} onClick={() => setUI({ showBrowser: !showBrowser })} data-help="Show/hide the browser (⌘B)" aria-label="Toggle browser">
          <svg width="15" height="15" viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M9 4.5v15" stroke="currentColor" strokeWidth="1.7" /></svg>
        </button>
        <button className={`btn size-[28px] p-0 ${showInspector ? 'text-fg' : 'btn-ghost'}`} onClick={() => setUI({ showInspector: !showInspector })} data-help="Show/hide the inspector (⌘I)" aria-label="Toggle inspector">
          <svg width="15" height="15" viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M15 4.5v15" stroke="currentColor" strokeWidth="1.7" /></svg>
        </button>
        <button className="btn btn-ghost size-[28px] p-0" onClick={() => setUI({ helpOpen: true })} data-help="Keyboard shortcuts and tips (?)" aria-label="Help"><Icon name="help" size={15} /></button>
      </div>
    </header>
  )
}
