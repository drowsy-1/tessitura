import { useEffect, useMemo, useRef, useState } from 'react'
import { engine, onFrame } from '../../engine'
import { edit, gestureKey, resolveClip, setUI, snapBeat, useProject, useUI, type ClipRef } from '../../state/store'
import { DRUM_VOICES, uid } from '../../state/defaults'
import type { MidiClip, Note, Track } from '../../state/types'
import { diatonicChord, inScale, NOTE_NAMES, noteName, snapToScale, type ChordShape } from '../../lib/music'
import { Bar, NumberField, Segmented, Toggle, startDrag } from '../../ui/controls'
import { Icon } from '../../ui/icons'
import { SNAP_OPTIONS } from '../arrange/Arrangement'

const VEL_H = 62
const LOW = 24
const HIGH = 108

type Drag = { ids: Set<string>; dBeat: number; dPitch: number; dLen: number; copy: boolean } | null

export function PianoRoll({ refc, clip, track }: { refc: ClipRef; clip: MidiClip; track: Track }) {
  const project = useProject((s) => s.project)
  const { tool, snap, chord, scaleLock, foldScale } = useUI()
  const drums = track.instrument?.type === 'drums'
  const KEY_W = drums ? 86 : 58
  const { root, scale } = project.key
  const [ppb, setPpb] = useState(56)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [drag, setDragState] = useState<Drag>(null)
  const dragRef = useRef<Drag>(null)
  const setDrag = (d: Drag) => { dragRef.current = d; setDragState(d) }
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [drawLen, setDrawLen] = useState(0.25)
  const [drawVel, setDrawVel] = useState(0.8)
  const scrollRef = useRef<HTMLDivElement>(null)
  const velRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const playRef = useRef<HTMLDivElement>(null)

  // visible rows (top → bottom)
  const pitches = useMemo(() => {
    if (drums) return DRUM_VOICES.map((v) => v.pitch)
    const all: number[] = []
    for (let p = HIGH; p >= LOW; p--) if (!foldScale || inScale(p, root, scale) || clip.notes.some((n) => n.pitch === p)) all.push(p)
    return all
  }, [drums, foldScale, root, scale, clip.notes])
  const rowH = drums ? 24 : foldScale ? 16 : 13
  const rowOf = (pitch: number) => pitches.indexOf(pitch)
  const width = Math.max(clip.length + 4, 16) * ppb
  const height = pitches.length * rowH

  // start scrolled to the notes (or middle C)
  useEffect(() => {
    const sc = scrollRef.current
    if (!sc || drums) return
    const target = clip.notes.length ? Math.max(...clip.notes.map((n) => n.pitch)) + 4 : 72
    const r = rowOf(Math.min(HIGH, target))
    sc.scrollTop = Math.max(0, r * rowH - 8)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.id, foldScale])

  // playhead inside the clip
  useEffect(
    () =>
      onFrame((pos) => {
        const el = playRef.current
        if (!el) return
        let local = -1
        if (engine.playing) {
          if (refc.slot !== undefined) {
            const l = engine.launches.find((x) => x.trackId === refc.trackId && x.slot === refc.slot && x.start <= pos && x.end > pos)
            if (l) local = (pos - l.start) % clip.length
          } else if (pos >= clip.start && pos < clip.start + clip.length) local = pos - clip.start
        }
        el.style.display = local < 0 ? 'none' : 'block'
        el.style.transform = `translateX(${KEY_W + local * ppb}px)`
      }),
    [refc, clip.start, clip.length, ppb, KEY_W],
  )

  // ctrl+wheel zoom
  useEffect(() => {
    const sc = scrollRef.current!
    const h = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      setPpb((v) => Math.min(400, Math.max(12, v * (e.deltaY < 0 ? 1.15 : 1 / 1.15))))
    }
    sc.addEventListener('wheel', h, { passive: false })
    return () => sc.removeEventListener('wheel', h)
  }, [])

  const writeNotes = (fn: (notes: Note[], c: MidiClip) => void, coalesce?: string) =>
    edit((p) => {
      const r = resolveClip(p, refc)
      if (r && r.clip.kind === 'midi') fn(r.clip.notes, r.clip)
    }, { coalesce })

  const audition = (pitchesToPlay: number[], vel = drawVel) => {
    pitchesToPlay.forEach((p) => engine.liveNoteOn(track.id, p, vel))
    setTimeout(() => pitchesToPlay.forEach((p) => engine.liveNoteOff(track.id, p)), drums ? 50 : 220)
  }

  const coords = (clientX: number, clientY: number) => {
    const r = gridRef.current!.getBoundingClientRect()
    const beat = (clientX - r.left) / ppb
    const row = Math.floor((clientY - r.top) / rowH)
    return { beat, row, pitch: pitches[Math.max(0, Math.min(pitches.length - 1, row))] }
  }
  const lockPitch = (p: number) => (scaleLock && !drums ? snapToScale(p, root, scale) : p)
  const s = snap || 0

  // ── grid pointer: draw / marquee / step toggle ──
  const onGridDown = (e: React.PointerEvent) => {
    if (e.button === 2) return
    const { beat, pitch } = coords(e.clientX, e.clientY)
    if (tool === 'select' || e.shiftKey) {
      const r = gridRef.current!.getBoundingClientRect()
      const x0 = e.clientX - r.left, y0 = e.clientY - r.top
      startDrag(e, (_a, _b, ev) => setMarquee({ x0, y0, x1: ev.clientX - r.left, y1: ev.clientY - r.top }), (ev, moved) => {
        setMarquee(null)
        if (!moved) { setSel(new Set()); return }
        const x1 = ev.clientX - r.left, y1 = ev.clientY - r.top
        const b0 = Math.min(x0, x1) / ppb, b1 = Math.max(x0, x1) / ppb
        const r0 = Math.floor(Math.min(y0, y1) / rowH), r1 = Math.floor(Math.max(y0, y1) / rowH)
        const next = new Set(e.shiftKey ? sel : [])
        for (const n of clip.notes) {
          const row = rowOf(n.pitch)
          if (row >= r0 && row <= r1 && n.start < b1 && n.start + n.dur > b0) next.add(n.id)
        }
        setSel(next)
      })
      return
    }
    if (tool === 'erase') {
      const key = gestureKey()
      const eraseAt = (x: number, y: number) => {
        const c = coords(x, y)
        writeNotes((notes) => {
          const i = notes.findIndex((n) => n.pitch === c.pitch && c.beat >= n.start && c.beat < n.start + n.dur)
          if (i >= 0) notes.splice(i, 1)
        }, key)
      }
      eraseAt(e.clientX, e.clientY)
      startDrag(e, (_a, _b, ev) => eraseAt(ev.clientX, ev.clientY))
      return
    }
    // draw
    const start = Math.max(0, Math.floor(beat / (s || 0.0625)) * (s || 0.0625))
    if (start >= clip.length) return
    const len0 = drums ? Math.max(0.125, s || 0.25) : drawLen
    const shape: ChordShape = drums ? 'off' : chord
    const ps = diatonicChord(lockPitch(pitch), root, scale, shape).filter((p) => p >= 0 && p <= 127)
    // drum step toggle: clicking an existing hit removes it
    if (drums) {
      const hit = clip.notes.find((n) => n.pitch === pitch && Math.abs(n.start - start) < 1e-6)
      if (hit) { writeNotes((notes) => { notes.splice(notes.findIndex((n) => n.id === hit.id), 1) }); return }
    }
    const created = ps.map((p) => ({ id: uid(), pitch: p, start, dur: len0, vel: drawVel }))
    const key = gestureKey()
    writeNotes((notes) => { notes.push(...created) }, key)
    setSel(new Set(created.map((n) => n.id)))
    audition(ps)
    if (drums) return
    let lastLen = len0
    startDrag(e, (dx, _dy, ev) => {
      const q = ev.altKey ? 0 : s
      const len = Math.max(q || 0.0625, snapBeat(len0 + dx / ppb, q))
      lastLen = len
      writeNotes((notes) => { for (const n of notes) if (created.some((c) => c.id === n.id)) n.dur = len }, key)
    }, (_ev, moved) => { if (moved) setDrawLen(lastLen) })
  }

  // ── note pointer: move / resize / duplicate ──
  const onNoteDown = (e: React.PointerEvent, note: Note, edge: boolean) => {
    e.stopPropagation()
    if (e.button === 2 || tool === 'erase') {
      writeNotes((notes) => { const i = notes.findIndex((n) => n.id === note.id); if (i >= 0) notes.splice(i, 1) })
      return
    }
    let ids = sel
    if (e.shiftKey) { ids = new Set(sel); if (ids.has(note.id)) ids.delete(note.id); else ids.add(note.id) }
    else if (!sel.has(note.id)) ids = new Set([note.id])
    setSel(ids)
    if (!edge) audition([note.pitch], note.vel)
    const copy = e.altKey
    startDrag(
      e,
      (dx, dy, ev) => {
        const q = ev.altKey && !copy ? 0 : s
        if (edge) setDrag({ ids, dBeat: 0, dPitch: 0, dLen: snapBeat(note.dur + dx / ppb, q) - note.dur, copy: false })
        else {
          const dBeat = snapBeat(note.start + dx / ppb, q) - note.start
          const rowD = Math.round(dy / rowH)
          const targetRow = Math.max(0, Math.min(pitches.length - 1, rowOf(note.pitch) + rowD))
          const dPitch = lockPitch(pitches[targetRow]) - note.pitch
          setDrag({ ids, dBeat, dPitch, dLen: 0, copy })
        }
      },
      (_ev, moved) => {
        const d = dragRef.current
        setDrag(null)
        // step-sequencer behaviour: clicking an existing hit removes it
        if (!moved && drums && tool === 'draw' && !e.shiftKey) {
          writeNotes((notes) => { const i = notes.findIndex((n) => n.id === note.id); if (i >= 0) notes.splice(i, 1) })
          return
        }
        if (!moved || !d) return
        const newIds: string[] = []
        writeNotes((notes) => {
          const targets = notes.filter((n) => d.ids.has(n.id))
          for (const n of targets) {
            const t = d.copy ? { ...n, id: uid() } : n
            t.start = Math.max(0, n.start + d.dBeat)
            t.pitch = drums ? n.pitch : Math.max(0, Math.min(127, n.pitch + d.dPitch))
            t.dur = Math.max(0.0625, n.dur + d.dLen)
            if (d.copy) { notes.push(t); newIds.push(t.id) }
          }
        })
        if (d.copy) setSel(new Set(newIds))
        if (d.dPitch) audition([note.pitch + d.dPitch], note.vel)
      },
    )
  }

  // ── velocity lane ──
  const onVelDown = (e: React.PointerEvent) => {
    const r = velRef.current!.getBoundingClientRect()
    const beat = (e.clientX - r.left + scrollRef.current!.scrollLeft) / ppb
    const target = [...clip.notes].sort((a, b) => Math.abs(a.start - beat) - Math.abs(b.start - beat))[0]
    if (!target || Math.abs(target.start - beat) * ppb > 10) return
    const group = sel.has(target.id) ? sel : new Set([target.id])
    const base = new Map(clip.notes.filter((n) => group.has(n.id)).map((n) => [n.id, n.vel]))
    const key = gestureKey()
    const set = (clientY: number) => {
      const v = Math.max(0.02, Math.min(1, 1 - (clientY - r.top) / r.height))
      const d = v - target.vel
      writeNotes((notes) => { for (const n of notes) if (base.has(n.id)) n.vel = Math.max(0.02, Math.min(1, group.size > 1 ? base.get(n.id)! + d : v)) }, key)
      setUI({ hint: `Velocity ${Math.round(v * 127)}` })
    }
    set(e.clientY)
    startDrag(e, (_a, _b, ev) => set(ev.clientY))
  }

  // ── keyboard shortcuts scoped to the editor ──
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input,textarea')) return
      if (!scrollRef.current?.closest('[data-editor]')?.matches(':hover') && !sel.size) return
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'a') { setSel(new Set(clip.notes.map((n) => n.id))); e.preventDefault(); e.stopPropagation() }
      if (!sel.size) return
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1)
        writeNotes((notes) => { for (const n of notes) if (sel.has(n.id)) n.pitch = drums ? n.pitch : Math.max(0, Math.min(127, n.pitch + d)) })
        e.preventDefault(); e.stopPropagation()
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const d = (e.key === 'ArrowRight' ? 1 : -1) * (s || 0.25) * (e.shiftKey ? 4 : 1)
        writeNotes((notes) => { for (const n of notes) if (sel.has(n.id)) n.start = Math.max(0, n.start + d) })
        e.preventDefault(); e.stopPropagation()
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        writeNotes((notes) => { for (let i = notes.length - 1; i >= 0; i--) if (sel.has(notes[i].id)) notes.splice(i, 1) })
        setSel(new Set()); e.preventDefault(); e.stopPropagation()
      }
      if (mod && e.key.toLowerCase() === 'd') {
        const chosen = clip.notes.filter((n) => sel.has(n.id))
        const span = Math.max(...chosen.map((n) => n.start + n.dur)) - Math.min(...chosen.map((n) => n.start))
        const q = s || 0.25
        const shift = Math.ceil(span / q) * q
        const copies = chosen.map((n) => ({ ...n, id: uid(), start: n.start + shift }))
        writeNotes((notes) => { notes.push(...copies) })
        setSel(new Set(copies.map((c) => c.id)))
        e.preventDefault(); e.stopPropagation()
      }
    }
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  })

  // ── bulk operations ──
  const target = (n: Note) => sel.size === 0 || sel.has(n.id)
  const quantize = () => writeNotes((notes) => { for (const n of notes) if (target(n)) n.start = Math.max(0, snapBeat(n.start, s || 0.25)) })
  const transpose = (d: number) => writeNotes((notes) => { for (const n of notes) if (target(n)) n.pitch = Math.max(0, Math.min(127, n.pitch + d)) })
  const legato = () => writeNotes((notes, c) => {
    const sorted = notes.filter(target).sort((a, b) => a.start - b.start)
    for (let i = 0; i < sorted.length; i++) {
      const next = sorted.find((m) => m.start > sorted[i].start + 1e-6)
      sorted[i].dur = Math.max(0.0625, (next ? next.start : c.length) - sorted[i].start)
    }
  })
  const humanize = () => writeNotes((notes) => {
    for (const n of notes) if (target(n)) {
      n.start = Math.max(0, n.start + (Math.random() - 0.5) * 0.03)
      n.vel = Math.max(0.05, Math.min(1, n.vel + (Math.random() - 0.5) * 0.16))
    }
  })
  const fitScale = () => writeNotes((notes) => { for (const n of notes) if (target(n)) n.pitch = snapToScale(n.pitch, root, scale) })

  const shown = (n: Note) => {
    if (!drag || !drag.ids.has(n.id)) return n
    return { ...n, start: Math.max(0, n.start + drag.dBeat), pitch: drums ? n.pitch : n.pitch + drag.dPitch, dur: Math.max(0.0625, n.dur + drag.dLen) }
  }
  const ghost = drag?.copy ? clip.notes.filter((n) => drag.ids.has(n.id)) : []

  const barPx = ppb * 4
  const gridBg = {
    backgroundImage: [
      `repeating-linear-gradient(90deg, #2a303b 0 1px, transparent 1px ${barPx}px)`,
      `repeating-linear-gradient(90deg, #1b2029 0 1px, transparent 1px ${ppb}px)`,
      ppb * (s || 0.25) >= 10 ? `repeating-linear-gradient(90deg, #14181e 0 1px, transparent 1px ${ppb * (s || 0.25)}px)` : '',
    ].filter(Boolean).join(','),
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-editor>
      {/* toolbar */}
      <div className="flex h-[36px] shrink-0 items-center gap-2 overflow-x-auto border-b border-line bg-ink-1 px-2">
        <span className="h-3 w-[3px] shrink-0 rounded-full" style={{ background: track.color }} />
        <input
          id="clip-name"
          className="field h-[24px] w-[120px] shrink-0"
          value={clip.name}
          onChange={(e) => edit((p) => { const r = resolveClip(p, refc); if (r) r.clip.name = e.target.value }, { coalesce: `name:${clip.id}` })}
          onKeyDown={(e) => e.stopPropagation()}
          aria-label="Clip name"
        />
        <span className="label shrink-0">Length</span>
        <NumberField
          id="clip-length"
          value={clip.length / 4}
          min={0.25}
          max={64}
          step={0.25}
          width={62}
          help="Clip length in bars"
          format={(v) => `${v} bar`}
          onChange={(v) => edit((p) => { const r = resolveClip(p, refc); if (r) r.clip.length = v * 4 }, { coalesce: `len:${clip.id}` })}
        />
        {refc.slot === undefined && (
          <button className="btn btn-ghost h-[24px] shrink-0 px-2 text-[11px]" onClick={() => edit((p) => { p.loop = { on: true, start: clip.start, end: clip.start + clip.length } })} data-help="Loop playback over this clip">
            <Icon name="loop" size={13} /> Loop clip
          </button>
        )}
        <Segmented
          value={tool}
          onChange={(v) => setUI({ tool: v })}
          size="xs"
          options={[
            { value: 'draw', label: <Icon name="pencil" size={12} />, title: drums ? 'Step: click cells to toggle hits (B)' : 'Draw: click to add, drag to set length (B)' },
            { value: 'select', label: <Icon name="cursor" size={12} />, title: 'Select: drag a box around notes (V)' },
            { value: 'erase', label: <Icon name="eraser" size={12} />, title: 'Erase: click or drag over notes. Right-click erases in any tool (E)' },
          ]}
        />
        <Segmented value={snap} onChange={(v) => setUI({ snap: v })} size="xs" options={SNAP_OPTIONS} help="Grid" />
        {!drums && (
          <>
            <div className="flex items-center gap-1" data-help="Chord stamp: each click draws a chord built from the project key">
              <Icon name="chord" size={13} className="text-fg-3" />
              <Segmented
                value={chord}
                onChange={(v) => setUI({ chord: v })}
                size="xs"
                options={[
                  { value: 'off', label: 'Note' },
                  { value: 'triad', label: 'Triad' },
                  { value: 'seventh', label: '7th' },
                  { value: 'sus2', label: 'Sus2' },
                  { value: 'power', label: '5th' },
                ]}
              />
            </div>
            <Toggle on={scaleLock} onClick={() => setUI({ scaleLock: !scaleLock })} title={`Scale lock: new and moved notes snap to ${NOTE_NAMES[root]} ${scale}`} tone="cv" className="h-[22px] px-2">Lock</Toggle>
            <Toggle on={foldScale} onClick={() => setUI({ foldScale: !foldScale })} title="Fold: hide rows outside the key" tone="cv" className="h-[22px] px-2">Fold</Toggle>
          </>
        )}
        <div className="w-[110px] shrink-0">
          <Bar value={drawVel} min={0.05} max={1} def={0.8} height={22} label="Vel" format={(v) => String(Math.round(v * 127))} onChange={setDrawVel} help="Velocity for new notes" />
        </div>
        <div className="mx-1 h-4 w-px shrink-0 bg-line" />
        <button className="btn btn-ghost h-[24px] shrink-0 px-2 text-[11px]" onClick={quantize} data-help="Quantize selected notes (or all) to the grid (Q)">Quantize</button>
        {!drums && <button className="btn btn-ghost h-[24px] shrink-0 px-2 text-[11px]" onClick={legato} data-help="Legato: stretch each note to the next">Legato</button>}
        <button className="btn btn-ghost h-[24px] shrink-0 px-2 text-[11px]" onClick={humanize} data-help="Humanize: small random timing and velocity changes">Humanize</button>
        {!drums && <button className="btn btn-ghost h-[24px] shrink-0 px-2 text-[11px]" onClick={fitScale} data-help="Move out-of-key notes to the nearest note in the project key">Fit to key</button>}
        {!drums && (
          <div className="flex shrink-0 items-center gap-[2px]" data-help="Transpose selected notes (or all). Arrow keys also work; Shift = octave.">
            <button className="btn btn-ghost h-[24px] px-[6px] text-[10px]" onClick={() => transpose(-12)}>−12</button>
            <button className="btn btn-ghost h-[24px] px-[6px] text-[10px]" onClick={() => transpose(-1)}>−1</button>
            <button className="btn btn-ghost h-[24px] px-[6px] text-[10px]" onClick={() => transpose(1)}>+1</button>
            <button className="btn btn-ghost h-[24px] px-[6px] text-[10px]" onClick={() => transpose(12)}>+12</button>
          </div>
        )}
      </div>

      {/* grid */}
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto" onScroll={(e) => { if (velRef.current) velRef.current.scrollLeft = (e.target as HTMLDivElement).scrollLeft }}>
        <div className="relative flex" style={{ width: KEY_W + width, height }}>
          {/* keys */}
          <div className="sticky left-0 z-20 shrink-0 border-r border-line bg-ink-1" style={{ width: KEY_W }}>
            {pitches.map((p) => {
              const black = [1, 3, 6, 8, 10].includes(p % 12)
              const inKey = inScale(p, root, scale)
              return (
                <div
                  key={p}
                  className={`flex cursor-pointer items-center justify-end border-b pr-[6px] text-[9px] ${drums ? 'justify-start pl-2 text-[10px] text-fg-2' : ''} ${black && !drums ? 'border-black/40 bg-[#1b1e25] text-fg-3' : 'border-line-soft bg-[#cfcac0] text-[#3a3730]'} ${drums ? '!bg-ink-2 !border-line-soft' : ''}`}
                  style={{ height: rowH }}
                  onPointerDown={() => { engine.liveNoteOn(track.id, p, drawVel); const up = () => { engine.liveNoteOff(track.id, p); window.removeEventListener('pointerup', up) }; window.addEventListener('pointerup', up) }}
                  data-help={drums ? `${DRUM_VOICES.find((v) => v.pitch === p)?.name} · click to audition` : `${noteName(p)}${inKey ? ' · in key' : ''} · click to audition`}
                >
                  {drums ? DRUM_VOICES.find((v) => v.pitch === p)?.name : p % 12 === 0 || foldScale ? noteName(p) : ''}
                  {!drums && inKey && <span className="ml-1 size-[4px] rounded-full bg-cv/80" />}
                </div>
              )
            })}
          </div>
          {/* note grid */}
          <div ref={gridRef} className="relative" style={{ width, height }} onPointerDown={onGridDown} onContextMenu={(e) => e.preventDefault()}>
            {pitches.map((p, i) => (
              <div
                key={p}
                className="absolute inset-x-0 border-b border-[#171b22]"
                style={{ top: i * rowH, height: rowH, background: drums ? (i % 2 ? '#0f1216' : '#12151a') : inScale(p, root, scale) ? (p % 12 === root ? '#171c24' : '#13171d') : '#0d0f13' }}
              />
            ))}
            <div className="pointer-events-none absolute inset-0" style={gridBg} />
            {/* region past the clip end */}
            <div className="pointer-events-none absolute inset-y-0 bg-black/45" style={{ left: clip.length * ppb, right: 0 }}>
              <div className="h-full w-[2px] bg-tape/60" />
            </div>
            {ghost.map((n) => (
              <div key={`g${n.id}`} className="pointer-events-none absolute rounded-[2px] bg-fg/15" style={{ left: n.start * ppb, top: rowOf(n.pitch) * rowH + 1, width: Math.max(4, n.dur * ppb - 1), height: rowH - 2 }} />
            ))}
            {clip.notes.map((n0) => {
              const n = shown(n0)
              const row = rowOf(n.pitch)
              if (row < 0) return null
              const selected = sel.has(n.id)
              const w = drums ? Math.max(8, Math.min(n.dur, s || 0.25) * ppb - 2) : Math.max(4, n.dur * ppb - 1)
              return (
                <div
                  key={n.id}
                  className={`absolute cursor-move rounded-[2px] ${selected ? 'ring-[1.5px] ring-fg' : ''}`}
                  style={{
                    left: n.start * ppb,
                    top: row * rowH + 1,
                    width: w,
                    height: rowH - 2,
                    background: `color-mix(in srgb, ${track.color} ${45 + n.vel * 55}%, #0e1014)`,
                    opacity: n.start >= clip.length ? 0.35 : 1,
                  }}
                  onPointerDown={(e) => onNoteDown(e, n0, false)}
                  onDoubleClick={() => tool === 'draw' && !drums && writeNotes((notes) => { const i = notes.findIndex((x) => x.id === n0.id); if (i >= 0) notes.splice(i, 1) })}
                  data-help={`${drums ? DRUM_VOICES.find((v) => v.pitch === n.pitch)?.name : noteName(n.pitch)} · vel ${Math.round(n.vel * 127)} · drag to move (Alt = copy) · right edge = length · right-click = delete`}
                >
                  {!drums && rowH >= 13 && w > 26 && <span className="pointer-events-none absolute left-[3px] top-0 text-[8px] leading-[11px] text-black/60">{noteName(n.pitch)}</span>}
                  {!drums && <div className="absolute inset-y-0 right-0 w-[5px] cursor-e-resize" onPointerDown={(e) => onNoteDown(e, n0, true)} />}
                </div>
              )
            })}
            {marquee && (
              <div className="pointer-events-none absolute border border-tape/70 bg-tape/10" style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }} />
            )}
          </div>
          <div ref={playRef} className="pointer-events-none absolute left-0 top-0 z-10 w-px bg-tape" style={{ height, display: 'none' }} />
        </div>
      </div>

      {/* velocity lane */}
      <div className="flex shrink-0 border-t border-line" style={{ height: VEL_H }}>
        <div className="flex shrink-0 flex-col justify-center border-r border-line bg-ink-1 px-2" style={{ width: KEY_W }}>
          <span className="label">Vel</span>
          <span className="num text-[9px] text-fg-3">{sel.size ? `${sel.size} sel` : 'all'}</span>
        </div>
        <div ref={velRef} className="relative flex-1 cursor-ns-resize overflow-hidden bg-ink-0" onPointerDown={onVelDown} data-help="Velocity · drag a bar up or down · selected notes move together">
          <div className="relative h-full" style={{ width }}>
            {clip.notes.map((n0) => {
              const n = shown(n0)
              return (
                <div key={n.id} className="absolute bottom-0" style={{ left: n.start * ppb, width: 5, height: `${n.vel * 100}%` }}>
                  <div className="absolute inset-x-[2px] bottom-0 top-0 rounded-t-[1px]" style={{ background: sel.has(n.id) ? 'var(--color-fg)' : track.color, opacity: 0.8 }} />
                  <div className="absolute -left-[1px] top-0 size-[7px] rounded-full" style={{ background: sel.has(n.id) ? 'var(--color-fg)' : track.color }} />
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
