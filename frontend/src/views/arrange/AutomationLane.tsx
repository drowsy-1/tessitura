import { useRef } from 'react'
import { updateTrack } from '../../state/actions'
import { AUTO_LABELS, snapBeat, setUI } from '../../state/store'
import type { AutoParam, Track } from '../../state/types'
import { laneDefault } from '../../engine/engine'
import { clamp, faderToDb, fromNorm } from '../../engine/dsp'
import { startDrag, fmtDb } from '../../ui/controls'

export function autoValueLabel(param: AutoParam, v: number) {
  switch (param) {
    case 'volume':
    case 'sendA':
    case 'sendB': return `${fmtDb(faderToDb(v))} dB`
    case 'pan': { const p = Math.round((v * 2 - 1) * 100); return p === 0 ? 'C' : p < 0 ? `${-p}L` : `${p}R` }
    case 'cutoff': { const hz = fromNorm(v, 40, 16000, 'log'); return hz >= 1000 ? `${(hz / 1000).toFixed(2)} kHz` : `${Math.round(hz)} Hz` }
  }
}

export function AutomationLane({ track, param, ppb, width, height, snap }: { track: Track; param: AutoParam; ppb: number; width: number; height: number; snap: number }) {
  const ref = useRef<SVGSVGElement>(null)
  const lane = track.automation.find((l) => l.param === param)
  const pts = lane?.points ?? []
  const pad = 6
  const yOf = (v: number) => pad + (1 - v) * (height - pad * 2)
  const vOf = (y: number) => clamp(1 - (y - pad) / (height - pad * 2), 0, 1)
  const hint = (v: number) => setUI({ hint: `${AUTO_LABELS[param]}: ${autoValueLabel(param, v)}` })

  const write = (fn: (points: { beat: number; value: number }[]) => void, coalesce?: string) =>
    updateTrack(track.id, (t) => {
      let l = t.automation.find((x) => x.param === param)
      if (!l) { l = { param, points: [] }; t.automation.push(l) }
      fn(l.points)
      l.points.sort((a, b) => a.beat - b.beat)
    }, coalesce)

  const addAt = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    const beat = Math.max(0, snapBeat((e.clientX - r.left) / ppb, snap))
    const value = vOf(e.clientY - r.top)
    write((p) => { p.push({ beat, value }) })
    hint(value)
    dragPoint(e, beat, value) // keep dragging the point that was just added
  }

  const dragPoint = (e: React.PointerEvent, beat0: number, value0: number) => {
    e.stopPropagation()
    let cur = { beat: beat0, value: value0 }
    startDrag(e, (dx, dy, ev) => {
      const beat = Math.max(0, snapBeat(beat0 + dx / ppb, ev.altKey ? 0 : snap))
      const value = clamp(vOf(yOf(value0) + dy), 0, 1)
      const prev = cur
      write((p) => {
        const i = p.findIndex((x) => x.beat === prev.beat && Math.abs(x.value - prev.value) < 1e-9)
        if (i >= 0) p[i] = { beat, value }
      }, `auto:${param}`)
      cur = { beat, value }
      hint(value)
    })
  }

  const path = pts.length
    ? `M0 ${yOf(pts[0].value)} ` + pts.map((p) => `L${p.beat * ppb} ${yOf(p.value)}`).join(' ') + ` L${width} ${yOf(pts[pts.length - 1].value)}`
    : ''
  const staticV = laneDefault(track, param)

  return (
    <svg
      ref={ref}
      width={width}
      height={height}
      className="block cursor-crosshair bg-[#0c0e12]"
      onPointerDown={(e) => { if (e.button === 0) addAt(e) }}
      data-help={`${AUTO_LABELS[param]} automation · click to add a point · drag points · Alt = no snap · double-click a point to delete`}
    >
      <line x1={0} x2={width} y1={yOf(0.5)} y2={yOf(0.5)} stroke="var(--color-line-soft)" strokeDasharray="2 4" />
      {!pts.length && (
        <>
          <line x1={0} x2={width} y1={yOf(staticV)} y2={yOf(staticV)} stroke="var(--color-cv)" strokeOpacity={0.35} strokeDasharray="4 4" />
          <text x={8} y={height / 2 + 3} fill="var(--color-fg-3)" fontSize={10}>Click to draw {AUTO_LABELS[param].toLowerCase()} automation</text>
        </>
      )}
      {path && (
        <>
          <path d={`${path} L${width} ${height} L0 ${height} Z`} fill="var(--color-cv)" opacity={0.08} />
          <path d={path} stroke="var(--color-cv)" strokeWidth={1.5} fill="none" />
        </>
      )}
      {pts.map((p, i) => (
        <circle
          key={i}
          cx={p.beat * ppb}
          cy={yOf(p.value)}
          r={4}
          fill="var(--color-ink-0)"
          stroke="var(--color-cv)"
          strokeWidth={1.5}
          className="cursor-grab hover:fill-[var(--color-cv)]"
          onPointerDown={(e) => { if (e.button === 0 && e.detail < 2) dragPoint(e, p.beat, p.value); else e.stopPropagation() }}
          onDoubleClick={(e) => { e.stopPropagation(); write((arr) => { arr.splice(arr.findIndex((x) => x.beat === p.beat && x.value === p.value), 1) }) }}
          onPointerEnter={() => hint(p.value)}
        />
      ))}
    </svg>
  )
}
