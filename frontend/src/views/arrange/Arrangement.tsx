import { useEffect, useMemo, useRef, useState } from 'react'
import { engine, onFrame } from '../../engine'
import { buffers } from '../../engine/assets'
import {
  addTrack, createMidiClipAt, deleteSelectedClips, duplicateSelectedClips, importAudio, isMedia, placeAsset, splitClipsAt,
} from '../../state/actions'
import { cloneClip, midiClip, SYNTH_PRESETS, DRUM_PRESETS } from '../../state/defaults'
import { beatsPerBar, edit, findTrack, projectEndBeat, setUI, snapBeat, useProject, useUI, type ClipRef, type Snap } from '../../state/store'
import type { Clip, Project, Track } from '../../state/types'
import { Segmented, startDrag } from '../../ui/controls'
import { srcSecPerBeat } from '../../state/clip'
import { Icon } from '../../ui/icons'
import { openContextMenu } from '../../ui/ContextMenu'
import { ClipBlock, type ClipGeom, type ClipHandle } from './ClipBlock'
import { TrackHeader } from './TrackHeader'
import { AutomationLane } from './AutomationLane'

export const HEADER_W = 216
const RULER_H = 30
const TRACK_H = 62
const AUTO_H = 58

interface Row { track: Track; y: number; h: number }

function rowsFor(p: Project): Row[] {
  let y = 0
  return p.tracks.map((track) => {
    const h = TRACK_H + (track.showAutomation ? AUTO_H : 0)
    const r = { track, y, h }
    y += h
    return r
  })
}

type Preview = Map<string, ClipGeom & { trackId: string }>

export const SNAP_OPTIONS: { value: Snap; label: string }[] = [
  { value: 0, label: 'Off' },
  { value: 0.125, label: '1/32' },
  { value: 0.25, label: '1/16' },
  { value: 0.5, label: '1/8' },
  { value: 1, label: '1/4' },
  { value: 4, label: 'Bar' },
]

export function Arrangement() {
  const project = useProject((s) => s.project)
  const { pxPerBeat: ppb, snap, selectedClips, tool } = useUI()
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const playheadRef = useRef<HTMLDivElement>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [draft, setDraft] = useState<{ trackId: string; a: number; b: number } | null>(null)
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [dropBeat, setDropBeat] = useState<number | null>(null)

  const bpb = beatsPerBar(project)
  const rows = useMemo(() => rowsFor(project), [project])
  const totalBeats = Math.max(projectEndBeat(project) + 16 * bpb, 48 * bpb)
  const width = totalBeats * ppb
  const lanesH = rows.reduce((a, r) => a + r.h, 0)
  const selIds = useMemo(() => new Set(selectedClips.map((s) => s.clipId)), [selectedClips])

  // ── coordinates ──
  const beatAt = (clientX: number) => (clientX - contentRef.current!.getBoundingClientRect().left - HEADER_W) / ppb
  const rowAt = (clientY: number) => {
    const y = clientY - contentRef.current!.getBoundingClientRect().top - RULER_H
    return rows.findIndex((r) => y >= r.y && y < r.y + r.h)
  }

  // ── playhead + follow ──
  useEffect(
    () =>
      onFrame((pos) => {
        const x = HEADER_W + pos * useUI.getState().pxPerBeat
        if (playheadRef.current) playheadRef.current.style.transform = `translateX(${x}px)`
        const sc = scrollRef.current
        if (sc && engine.playing && useUI.getState().follow) {
          if (x > sc.scrollLeft + sc.clientWidth - 60 || x < sc.scrollLeft + HEADER_W) sc.scrollLeft = x - HEADER_W - 40
        }
      }),
    [],
  )

  // ── ctrl/cmd + wheel zoom around the pointer ──
  useEffect(() => {
    const sc = scrollRef.current!
    const h = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const cur = useUI.getState().pxPerBeat
      const beat = beatAt(e.clientX)
      const next = Math.min(240, Math.max(4, cur * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
      setUI({ pxPerBeat: next })
      requestAnimationFrame(() => { sc.scrollLeft += beat * (next - cur) })
    }
    sc.addEventListener('wheel', h, { passive: false })
    return () => sc.removeEventListener('wheel', h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── clip interaction ──
  const onClipDown = (e: React.PointerEvent, track: Track, clip: Clip, handle: ClipHandle) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const ref: ClipRef = { trackId: track.id, clipId: clip.id }
    let sel = selectedClips.filter((s) => s.slot === undefined)
    if (e.shiftKey) sel = selIds.has(clip.id) ? sel.filter((s) => s.clipId !== clip.id) : [...sel, ref]
    else if (!selIds.has(clip.id)) sel = [ref]
    setUI({ selectedClips: sel, selectedTrack: track.id })
    if (useUI.getState().editing && clip.kind === 'midi') setUI({ editing: ref })
    const p = useProject.getState().project
    const moving = handle === 'body' ? sel : [ref]
    const originals = moving
      .map((r) => ({ r, t: findTrack(p, r.trackId), c: findTrack(p, r.trackId)?.clips.find((c) => c.id === r.clipId) }))
      .filter((x): x is { r: ClipRef; t: Track; c: Clip } => !!x.t && !!x.c)
    if (!originals.length) return
    const row0 = rows.findIndex((r) => r.track.id === track.id)
    const minStart = Math.min(...originals.map((o) => o.c.start))
    const spb = 60 / p.bpm
    const copy = e.altKey
    let last: Preview | null = null
    startDrag(
      e,
      (dx, _dy, ev) => {
        const s = ev.altKey || ev.metaKey ? 0 : snap
        const pv: Preview = new Map()
        const d = dx / ppb
        if (handle === 'body') {
          let dBeat = snapBeat(clip.start + d, s) - clip.start
          dBeat = Math.max(-minStart, dBeat)
          const rowNow = rowAt(ev.clientY)
          const dRow = rowNow < 0 ? 0 : rowNow - row0
          for (const o of originals) {
            const oi = rows.findIndex((r) => r.track.id === o.t.id)
            const target = rows[Math.min(rows.length - 1, Math.max(0, oi + dRow))]?.track
            const ok = target && (target.kind === 'midi') === (o.c.kind === 'midi')
            pv.set(o.c.id, { start: o.c.start + dBeat, length: o.c.length, trackId: ok ? target.id : o.t.id })
          }
        } else {
          const o = originals[0]
          const c = o.c
          const sspb = c.kind === 'audio' ? srcSecPerBeat(c, p.bpm) : spb // source seconds per beat
          const minLen = s || 0.125
          if (handle === 'end') {
            let end = snapBeat(c.start + c.length + d, s)
            if (c.kind === 'audio') {
              const dur = buffers.get(c.assetId)?.duration ?? Infinity
              end = Math.min(end, c.start + (dur - c.offset) / sspb)
            }
            pv.set(c.id, { start: c.start, length: Math.max(minLen, end - c.start), trackId: o.t.id })
          } else if (handle === 'start') {
            let start = snapBeat(c.start + d, s)
            start = Math.min(start, c.start + c.length - minLen)
            if (c.kind === 'audio') start = Math.max(start, c.start - c.offset / sspb)
            start = Math.max(0, start)
            const shift = start - c.start
            pv.set(c.id, { start, length: c.length - shift, trackId: o.t.id, offset: c.kind === 'audio' ? c.offset + shift * sspb : undefined })
          } else if (c.kind === 'audio') {
            if (handle === 'fadeIn') pv.set(c.id, { start: c.start, length: c.length, trackId: o.t.id, fadeIn: Math.max(0, Math.min(c.length - c.fadeOut, c.fadeIn + d)) })
            else pv.set(c.id, { start: c.start, length: c.length, trackId: o.t.id, fadeOut: Math.max(0, Math.min(c.length - c.fadeIn, c.fadeOut - d)) })
          }
        }
        last = pv
        setPreview(pv)
      },
      (_ev, moved) => {
        setPreview(null)
        if (!moved || !last) return
        const pv = last
        const newSel: ClipRef[] = []
        edit((pp) => {
          for (const o of originals) {
            const g = pv.get(o.c.id)
            if (!g) continue
            const src = findTrack(pp, o.t.id)
            const dst = findTrack(pp, g.trackId)
            const idx = src?.clips.findIndex((c) => c.id === o.c.id) ?? -1
            if (!src || !dst || idx < 0) continue
            let c = src.clips[idx]
            if (handle === 'body' && copy) c = cloneClip(c)
            else if (dst !== src) src.clips.splice(idx, 1)
            c.start = g.start
            if (handle === 'start' && c.kind === 'midi') {
              const shift = g.start - o.c.start
              c.notes = c.notes.map((n) => ({ ...n, start: n.start - shift })).filter((n) => n.start + n.dur > 0)
            }
            c.length = g.length
            if (c.kind === 'audio') {
              if (g.offset !== undefined) c.offset = g.offset
              if (g.fadeIn !== undefined) c.fadeIn = g.fadeIn
              if (g.fadeOut !== undefined) c.fadeOut = g.fadeOut
            }
            if ((handle === 'body' && copy) || dst !== src) dst.clips.push(c)
            newSel.push({ trackId: dst.id, clipId: c.id })
          }
        }, { label: copy ? 'Copy clips' : 'Edit clips' })
        setUI({ selectedClips: newSel })
      },
    )
  }

  const openEditor = (track: Track, clip: Clip) => setUI({ editing: { trackId: track.id, clipId: clip.id }, dock: 'editor', dockOpen: true, selectedTrack: track.id })

  const clipMenu = (e: React.MouseEvent, track: Track, clip: Clip) => {
    const ref = { trackId: track.id, clipId: clip.id }
    if (!selIds.has(clip.id)) setUI({ selectedClips: [ref] })
    openContextMenu(e, [
      { label: 'Edit', onClick: () => openEditor(track, clip), hint: 'dbl-click' },
      { label: 'Duplicate', onClick: duplicateSelectedClips, hint: '⌘D' },
      { label: 'Split at playhead', onClick: () => splitClipsAt(engine.position()), hint: 'S' },
      { label: 'Copy to launcher slot', onClick: () => edit((p) => {
        const t = findTrack(p, track.id)
        if (!t) return
        const i = t.slots.findIndex((s) => !s)
        const c = cloneClip(clip)
        c.start = 0
        if (i >= 0) t.slots[i] = c
        else { t.slots.push(c) }
      }) },
      { label: 'Loop this clip', onClick: () => edit((p) => { p.loop = { on: true, start: clip.start, end: clip.start + clip.length } }) },
      { label: '', divider: true },
      { label: 'Delete', danger: true, onClick: deleteSelectedClips, hint: '⌫' },
    ])
  }

  // ── empty-lane interaction: draw a clip (pencil) or marquee-select ──
  const onLaneDown = (e: React.PointerEvent, track: Track) => {
    if (e.button !== 0) return
    setUI({ selectedTrack: track.id })
    const b0 = beatAt(e.clientX)
    const content = contentRef.current!.getBoundingClientRect()
    const x0 = e.clientX - content.left
    const y0 = e.clientY - content.top
    const pencil = tool === 'draw' && track.kind === 'midi'
    let moved = false
    startDrag(
      e,
      (_dx, _dy, ev) => {
        moved = true
        if (pencil) {
          const b1 = beatAt(ev.clientX)
          const a = Math.floor(Math.min(b0, b1) / bpb) * bpb
          const b = Math.ceil(Math.max(b0, b1) / bpb) * bpb
          setDraft({ trackId: track.id, a: Math.max(0, a), b: Math.max(a + bpb, b) })
        } else {
          const c = contentRef.current!.getBoundingClientRect()
          setMarquee({ x0, y0, x1: ev.clientX - c.left, y1: ev.clientY - c.top })
        }
      },
      (ev) => {
        if (pencil && moved) {
          setDraft(null)
          const b1 = beatAt(ev.clientX)
          const a = Math.max(0, Math.floor(Math.min(b0, b1) / bpb) * bpb)
          const b = Math.max(a + bpb, Math.ceil(Math.max(b0, b1) / bpb) * bpb)
          const clip = midiClip('Clip', a, b - a, [])
          edit((p) => { findTrack(p, track.id)?.clips.push(clip) }, { label: 'Draw clip' })
          const ref = { trackId: track.id, clipId: clip.id }
          setUI({ selectedClips: [ref], editing: ref, dock: 'editor', dockOpen: true })
          return
        }
        if (moved) {
          const c = contentRef.current!.getBoundingClientRect()
          const x1 = ev.clientX - c.left
          const y1 = ev.clientY - c.top
          setMarquee(null)
          const ba = (Math.min(x0, x1) - HEADER_W) / ppb
          const bb = (Math.max(x0, x1) - HEADER_W) / ppb
          const ya = Math.min(y0, y1) - RULER_H
          const yb = Math.max(y0, y1) - RULER_H
          const sel: ClipRef[] = []
          for (const r of rows) {
            if (r.y + TRACK_H < ya || r.y > yb) continue
            for (const c2 of r.track.clips) if (c2.start < bb && c2.start + c2.length > ba) sel.push({ trackId: r.track.id, clipId: c2.id })
          }
          setUI({ selectedClips: sel })
          return
        }
        // plain click: deselect and move the playhead
        setUI({ selectedClips: [] })
        engine.relocate(Math.max(0, snapBeat(b0, snap)))
      },
    )
  }

  // ── drag & drop (files from the OS, items from the browser panel) ──
  const onDrop = (e: React.DragEvent, track?: Track) => {
    e.preventDefault()
    setDropBeat(null)
    const beat = Math.max(0, snapBeat(beatAt(e.clientX), snap || 1))
    const files = [...e.dataTransfer.files].filter(isMedia)
    if (files.length) {
      files.forEach((f, i) => void importAudio(f, { trackId: i === 0 ? track?.id : undefined, beat }))
      return
    }
    const raw = e.dataTransfer.getData('application/x-tessitura')
    if (!raw) return
    const item = JSON.parse(raw) as { kind: 'asset' | 'synth' | 'drums'; id: string }
    if (item.kind === 'asset') placeAsset(item.id, track?.id, beat)
    else if (item.kind === 'synth' && track?.instrument?.type === 'synth' && SYNTH_PRESETS[item.id])
      edit((p) => { const t = findTrack(p, track.id); if (t) t.instrument = { type: 'synth', preset: item.id, params: { ...SYNTH_PRESETS[item.id] } } })
    else if (item.kind === 'drums' && track?.instrument?.type === 'drums' && DRUM_PRESETS[item.id])
      edit((p) => { const t = findTrack(p, track.id); if (t) t.instrument = { type: 'drums', preset: item.id, params: { ...DRUM_PRESETS[item.id], levels: [...DRUM_PRESETS[item.id].levels] } } })
    else addTrack(item.kind, item.id)
  }

  // ── track reorder ──
  const onReorderStart = (e: React.PointerEvent, track: Track) => {
    e.stopPropagation()
    const from = project.tracks.findIndex((t) => t.id === track.id)
    startDrag(e, () => { document.body.style.cursor = 'grabbing' }, (ev, moved) => {
      if (!moved) return
      const to = rowAt(ev.clientY)
      if (to < 0 || to === from) return
      edit((p) => { const [t] = p.tracks.splice(from, 1); p.tracks.splice(to, 0, t) }, { label: 'Reorder tracks' })
    })
  }

  // ── grid background ──
  const barPx = bpb * ppb
  const beatLines = ppb >= 8
  const grid = {
    backgroundImage: [
      `repeating-linear-gradient(90deg, #262b35 0 1px, transparent 1px ${barPx}px)`,
      beatLines ? `repeating-linear-gradient(90deg, #181c23 0 1px, transparent 1px ${ppb}px)` : '',
      `repeating-linear-gradient(90deg, rgba(255,255,255,0.012) 0 ${barPx * 4}px, transparent ${barPx * 4}px ${barPx * 8}px)`,
    ].filter(Boolean).join(','),
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ArrangeToolbar />
      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-auto bg-ink-0"
        onDragOver={(e) => { e.preventDefault(); setDropBeat(Math.max(0, snapBeat(beatAt(e.clientX), snap || 1))) }}
        onDragLeave={() => setDropBeat(null)}
        onDrop={(e) => onDrop(e)}
      >
        <div ref={contentRef} className="relative" style={{ width: HEADER_W + width, minHeight: '100%' }}>
          {/* Ruler */}
          <div className="sticky top-0 z-30 flex" style={{ height: RULER_H }}>
            <div className="sticky left-0 z-10 flex shrink-0 items-end border-b border-r border-line bg-ink-1 px-2 pb-1" style={{ width: HEADER_W }}>
              <span className="label">{project.tracks.length} tracks</span>
            </div>
            <Ruler project={project} ppb={ppb} width={width} beatAt={beatAt} />
          </div>

          {/* Rows */}
          {rows.map(({ track, h }) => {
            const own = track.clips.filter((c) => !preview?.has(c.id) || preview.get(c.id)!.trackId === track.id)
            const incoming = preview
              ? project.tracks.flatMap((t) => (t.id === track.id ? [] : t.clips.filter((c) => preview.get(c.id)?.trackId === track.id)))
              : []
            return (
              <div key={track.id} className="flex" style={{ height: h }}>
                <div className="sticky left-0 z-20 shrink-0 border-r border-line" style={{ width: HEADER_W }}>
                  <TrackHeader track={track} height={TRACK_H} onReorderStart={(e) => onReorderStart(e, track)} />
                  {track.showAutomation && <AutoHeader track={track} />}
                </div>
                <div className="relative flex-1">
                  <div
                    className="relative border-b border-line-soft"
                    style={{ height: TRACK_H, ...grid }}
                    onPointerDown={(e) => onLaneDown(e, track)}
                    onDoubleClick={(e) => track.kind === 'midi' && createMidiClipAt(track.id, beatAt(e.clientX))}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => { e.stopPropagation(); onDrop(e, track) }}
                    data-help={track.kind === 'midi' ? (tool === 'draw' ? 'Pencil: drag to draw a clip · double-click for a 1-bar clip · click to move the playhead' : 'Drag to select clips · double-click to create a clip') : 'Drop audio files here · drag to select clips · click to move the playhead'}
                  >
                    {[...own, ...incoming].map((c) => (
                      <ClipBlock
                        key={c.id}
                        clip={c}
                        color={c.color ?? (project.tracks.find((t) => t.clips.includes(c))?.color ?? track.color)}
                        ppb={ppb}
                        height={TRACK_H - 5}
                        bpm={project.bpm}
                        selected={selIds.has(c.id)}
                        geom={preview?.get(c.id)}
                        onPointerDown={(e, handle) => onClipDown(e, project.tracks.find((t) => t.clips.includes(c)) ?? track, c, handle)}
                        onDoubleClick={() => openEditor(track, c)}
                        onContextMenu={(e) => clipMenu(e, track, c)}
                      />
                    ))}
                    {preview && track.clips.filter((c) => preview.has(c.id) && preview.get(c.id)!.trackId !== track.id).map((c) => (
                      <ClipBlock key={`ghost-${c.id}`} clip={c} color={track.color} ppb={ppb} height={TRACK_H - 5} bpm={project.bpm} selected={false} ghost />
                    ))}
                    {draft?.trackId === track.id && (
                      <div className="pointer-events-none absolute top-[2px] rounded-[4px] border border-dashed border-tape bg-tape/10" style={{ left: draft.a * ppb, width: (draft.b - draft.a) * ppb, height: TRACK_H - 5 }} />
                    )}
                  </div>
                  {track.showAutomation && (
                    <div className="border-b border-line-soft" style={{ height: AUTO_H }}>
                      <AutomationLane track={track} param={track.showAutomation} ppb={ppb} width={width} height={AUTO_H - 1} snap={snap} />
                    </div>
                  )}
                </div>
              </div>
            )
          })}

          {/* Add-track row */}
          <div className="flex" style={{ height: 64 }}>
            <div className="sticky left-0 z-20 flex shrink-0 items-center gap-1 border-r border-line bg-ink-1 px-2" style={{ width: HEADER_W }}>
              <button className="btn btn-ghost h-[24px] px-2 text-[11px]" onClick={() => addTrack('synth')} data-help="Add a synth track"><Icon name="plus" size={12} /> Synth</button>
              <button className="btn btn-ghost h-[24px] px-2 text-[11px]" onClick={() => addTrack('drums')} data-help="Add a drum track"><Icon name="plus" size={12} /> Drums</button>
              <button className="btn btn-ghost h-[24px] px-2 text-[11px]" onClick={() => addTrack('audio')} data-help="Add an audio track"><Icon name="plus" size={12} /> Audio</button>
            </div>
            <div className="sticky z-10 flex items-center whitespace-nowrap pl-4 text-[11px] text-fg-3" style={{ left: HEADER_W }}>Drop audio or video files, or browser items, anywhere on the timeline</div>
          </div>

          {/* Loop shade + playhead + drop marker */}
          {project.loop.on && (
            <div className="pointer-events-none absolute z-[5] bg-cv/[0.04]" style={{ left: HEADER_W + project.loop.start * ppb, width: (project.loop.end - project.loop.start) * ppb, top: RULER_H, height: lanesH }}>
              <div className="absolute inset-y-0 left-0 w-px bg-cv/40" />
              <div className="absolute inset-y-0 right-0 w-px bg-cv/40" />
            </div>
          )}
          <div ref={playheadRef} className="pointer-events-none absolute left-0 top-0 z-40 w-px bg-tape" style={{ height: RULER_H + lanesH }}>
            <div className="absolute -left-[5px] top-[18px] size-0 border-x-[5.5px] border-t-[7px] border-x-transparent border-t-tape" />
          </div>
          {dropBeat !== null && <div className="pointer-events-none absolute top-0 z-40 w-[2px] bg-cv" style={{ left: HEADER_W + dropBeat * ppb, height: RULER_H + lanesH }} />}
          {marquee && (
            <div
              className="pointer-events-none absolute z-40 border border-tape/70 bg-tape/10"
              style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function AutoHeader({ track }: { track: Track }) {
  const lane = track.automation.find((l) => l.param === track.showAutomation)
  return (
    <div className="flex items-center justify-between gap-2 border-b border-line-soft bg-[#101318] pl-[13px] pr-2" style={{ height: AUTO_H }}>
      <div className="flex min-w-0 flex-col">
        <span className="label !text-cv">automation</span>
        <span className="truncate text-[11px] text-fg-2">{track.showAutomation && { volume: 'Volume', pan: 'Pan', sendA: 'Send A · Space', sendB: 'Send B · Echo', cutoff: 'Synth cutoff' }[track.showAutomation]}</span>
      </div>
      <div className="flex items-center gap-1">
        {lane && lane.points.length > 0 && (
          <button
            className="btn btn-ghost h-[20px] px-[6px] text-[10px]"
            onClick={() => edit((p) => { const t = findTrack(p, track.id); const l = t?.automation.find((x) => x.param === track.showAutomation); if (l) l.points = [] })}
            data-help="Remove all points in this lane (the parameter returns to its static value)"
          >
            Clear
          </button>
        )}
        <button className="btn btn-ghost size-[20px] p-0" onClick={() => edit((p) => { const t = findTrack(p, track.id); if (t) t.showAutomation = null })} data-help="Hide lane (points are kept)" aria-label="Hide automation lane">
          <Icon name="close" size={12} />
        </button>
      </div>
    </div>
  )
}

function Ruler({ project, ppb, width, beatAt }: { project: Project; ppb: number; width: number; beatAt: (x: number) => number }) {
  const bpb = beatsPerBar(project)
  const bars = Math.ceil(width / (bpb * ppb))
  const every = ppb * bpb < 28 ? 4 : ppb * bpb < 56 ? 2 : 1
  const loop = project.loop
  const snapLoop = (b: number) => Math.max(0, Math.round(b / (ppb * bpb < 40 ? bpb : 1)) * (ppb * bpb < 40 ? bpb : 1))
  const onLoopDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    const b0 = beatAt(e.clientX)
    const inside = loop.end > loop.start && b0 > loop.start + 0.25 && b0 < loop.end - 0.25
    const nearStart = Math.abs(b0 - loop.start) * ppb < 6
    const nearEnd = Math.abs(b0 - loop.end) * ppb < 6
    const orig = { ...loop }
    startDrag(e, (_dx, _dy, ev) => {
      const b1 = beatAt(ev.clientX)
      edit((p) => {
        if (nearStart) p.loop.start = Math.min(snapLoop(b1), orig.end - 1)
        else if (nearEnd) p.loop.end = Math.max(snapLoop(b1), orig.start + 1)
        else if (inside) {
          const d = snapLoop(b1 - b0 + orig.start) - orig.start
          p.loop.start = Math.max(0, orig.start + d)
          p.loop.end = p.loop.start + (orig.end - orig.start)
        } else {
          const a = snapLoop(Math.min(b0, b1)), b = snapLoop(Math.max(b0, b1))
          if (b > a) { p.loop.start = a; p.loop.end = b; p.loop.on = true }
        }
      }, { coalesce: 'loop' })
    })
  }
  const onScrub = (e: React.PointerEvent) => {
    const go = (x: number) => engine.relocate(Math.max(0, snapBeat(beatAt(x), useUI.getState().snap || 0.25)))
    go(e.clientX)
    startDrag(e, (_a, _b, ev) => { if (!engine.playing) go(ev.clientX) }, (ev) => { if (engine.playing) go(ev.clientX) })
  }
  return (
    <div className="relative shrink-0 border-b border-line bg-ink-1" style={{ width }}>
      <div
        className="absolute inset-x-0 top-0 h-[11px] cursor-col-resize"
        onPointerDown={onLoopDown}
        onDoubleClick={() => edit((p) => { p.loop.on = !p.loop.on })}
        data-help="Loop strip · drag to set a loop · drag its edges or body · double-click to toggle loop"
      >
        {loop.end > loop.start && (
          <div
            className={`absolute top-[2px] h-[7px] rounded-[2px] ${loop.on ? 'bg-cv/70' : 'bg-fg-3/30'}`}
            style={{ left: loop.start * ppb, width: (loop.end - loop.start) * ppb }}
          />
        )}
      </div>
      <div className="absolute inset-x-0 bottom-0 top-[11px] cursor-text" onPointerDown={onScrub} data-help="Click or drag to move the playhead">
        {Array.from({ length: Math.ceil(bars / every) }, (_, i) => i * every).map((bar) => (
          <div key={bar} className="absolute bottom-0 top-0 border-l border-fg-3/40 pl-1" style={{ left: bar * bpb * ppb }}>
            <span className="num text-[10px] text-fg-3">{bar + 1}</span>
          </div>
        ))}
        {project.markers.map((m) => (
          <button
            key={m.id}
            className="absolute top-[1px] z-10 flex h-[13px] items-center rounded-r-[3px] bg-ink-3 pl-[5px] pr-[6px] text-[9px] font-semibold uppercase tracking-wider text-fg-2 hover:bg-ink-4"
            style={{ left: m.beat * ppb }}
            onPointerDown={(e) => { e.stopPropagation(); engine.relocate(m.beat) }}
            onContextMenu={(e) => openContextMenu(e, [{ label: `Delete marker “${m.name}”`, danger: true, onClick: () => edit((p) => { p.markers = p.markers.filter((x) => x.id !== m.id) }) }])}
            data-help={`Marker “${m.name}” · click to jump · right-click to delete`}
          >
            {m.name}
          </button>
        ))}
      </div>
    </div>
  )
}

function ArrangeToolbar() {
  const { tool, snap, pxPerBeat, follow, selectedClips } = useUI()
  return (
    <div className="flex h-[34px] shrink-0 items-center gap-2 overflow-x-auto border-b border-line bg-ink-1 px-2 [&>*]:shrink-0">
      <Segmented
        value={tool === 'erase' ? 'select' : tool}
        onChange={(v) => setUI({ tool: v })}
        size="xs"
        options={[
          { value: 'select', label: <Icon name="cursor" size={12} />, title: 'Pointer: drag on empty lanes to select (V)' },
          { value: 'draw', label: <Icon name="pencil" size={12} />, title: 'Pencil: drag on MIDI lanes to draw clips (B)' },
        ]}
      />
      <div className="flex items-center gap-1">
        <Icon name="magnet" size={13} className="text-fg-3" />
        <Segmented value={snap} onChange={(v) => setUI({ snap: v })} size="xs" options={SNAP_OPTIONS} help="Grid snap. Hold Alt while dragging to bypass." />
      </div>
      <div className="mx-1 h-4 w-px bg-line" />
      <button className="btn btn-ghost h-[24px] px-2 text-[11px]" onClick={() => splitClipsAt(engine.position())} data-help="Split selected clips (or all clips under the playhead) at the playhead (S)"><Icon name="scissors" size={13} /> Split</button>
      <button className="btn btn-ghost h-[24px] px-2 text-[11px]" disabled={!selectedClips.length} onClick={duplicateSelectedClips} data-help="Duplicate the selection after itself (⌘/Ctrl D)"><Icon name="copy" size={13} /> Duplicate</button>
      <button className="btn btn-ghost h-[24px] px-2 text-[11px]" disabled={!selectedClips.length} onClick={deleteSelectedClips} data-help="Delete selected clips (Delete / Backspace)"><Icon name="trash" size={13} /></button>
      <button
        className="btn btn-ghost h-[24px] px-2 text-[11px]"
        onClick={() => edit((p) => { const b = engine.position(); p.markers.push({ id: crypto.randomUUID().slice(0, 8), beat: Math.round(b), name: `M${p.markers.length + 1}` }); p.markers.sort((a, c) => a.beat - c.beat) })}
        data-help="Add a marker at the playhead (;)"
      >
        + Marker
      </button>
      <div className="flex-1" />
      <button className={`btn h-[24px] px-2 text-[11px] ${follow ? 'text-tape' : 'btn-ghost'}`} onClick={() => setUI({ follow: !follow })} data-help="Follow: keep the playhead in view while playing"><Icon name="follow" size={13} /> Follow</button>
      <div className="flex items-center gap-1" data-help="Horizontal zoom (Ctrl/⌘ + wheel over the timeline)">
        <button className="btn btn-ghost size-[24px] p-0" onClick={() => setUI({ pxPerBeat: Math.max(4, pxPerBeat / 1.3) })} aria-label="Zoom out"><Icon name="zoomOut" size={14} /></button>
        <input
          id="zoom"
          type="range"
          min={4}
          max={240}
          value={pxPerBeat}
          onChange={(e) => setUI({ pxPerBeat: Number(e.target.value) })}
          className="h-1 w-[90px] accent-[var(--color-tape)]"
          aria-label="Zoom"
        />
        <button className="btn btn-ghost size-[24px] p-0" onClick={() => setUI({ pxPerBeat: Math.min(240, pxPerBeat * 1.3) })} aria-label="Zoom in"><Icon name="zoomIn" size={14} /></button>
      </div>
    </div>
  )
}

