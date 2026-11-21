import { useEffect, useRef } from 'react'
import { engine, onFrame } from '../../engine'
import { biquadMagDb, clamp, fromNorm, toNorm } from '../../engine/dsp'
import { DEVICE_SPECS, type ParamSpec } from '../../state/defaults'
import { setUI } from '../../state/store'
import type { Device } from '../../state/types'
import { Bar, Segmented, XYPad, fmtValue, startDrag } from '../../ui/controls'
import { useElementWidth } from '../../ui/hooks'

type SetParam = (key: string, v: number) => void

export function ParamBar({ spec, value, set }: { spec: ParamSpec; value: number; set: SetParam }) {
  return (
    <Bar
      value={value}
      min={spec.min}
      max={spec.max}
      def={spec.def}
      curve={spec.curve}
      step={spec.step ?? (spec.curve === 'log' ? undefined : 1)}
      bipolar={spec.min < 0 && spec.max > 0}
      height={20}
      label={spec.label}
      help={spec.help ?? spec.label}
      format={(v) => fmtValue(v, spec.unit, spec.step)}
      onChange={(v) => set(spec.key, v)}
    />
  )
}

const spec = (d: Device, key: string) => DEVICE_SPECS[d.type].params.find((p) => p.key === key)!

// ───────────────────────── EQ with draggable curve ─────────────────────────
const F_MIN = 20, F_MAX = 20000, G_MAX = 18
export function EQView({ device, set }: { device: Device; set: SetParam }) {
  const wrap = useRef<HTMLDivElement>(null)
  const W = useElementWidth(wrap)
  const H = 132
  const p = device.params
  const xOf = (f: number) => toNorm(f, F_MIN, F_MAX, 'log') * W
  const fOf = (x: number) => fromNorm(x / W, F_MIN, F_MAX, 'log')
  const yOf = (g: number) => H / 2 - (g / G_MAX) * (H / 2 - 8)
  const gOf = (y: number) => clamp(((H / 2 - y) / (H / 2 - 8)) * G_MAX, -G_MAX, G_MAX)
  const resp = (f: number) =>
    (p.hpf > 21 ? biquadMagDb('highpass', p.hpf, 0, -3, f) : 0) +
    biquadMagDb('lowshelf', p.lowFreq, p.lowGain, 1, f) +
    biquadMagDb('peaking', p.midFreq, p.midGain, p.midQ, f) +
    biquadMagDb('highshelf', p.highFreq, p.highGain, 1, f)
  const pts: string[] = []
  for (let x = 0; x <= W; x += 2) pts.push(`${x},${clamp(yOf(resp(fOf(x))), 0, H)}`)
  const bands = [
    { id: 'hp', f: 'hpf', g: null, color: '#8a93a6', label: 'HP' },
    { id: 'lo', f: 'lowFreq', g: 'lowGain', color: '#e9a23b', label: 'L' },
    { id: 'mid', f: 'midFreq', g: 'midGain', color: '#58c4d0', label: 'M' },
    { id: 'hi', f: 'highFreq', g: 'highGain', color: '#d9677f', label: 'H' },
  ] as const
  const drag = (e: React.PointerEvent, b: (typeof bands)[number]) => {
    e.stopPropagation()
    const svg = (e.currentTarget as SVGElement).ownerSVGElement!.getBoundingClientRect()
    const fs = spec(device, b.f)
    const gs = b.g ? spec(device, b.g) : null
    startDrag(e, (_dx, _dy, ev) => {
      set(b.f, Math.round(clamp(fOf(ev.clientX - svg.left), fs.min, fs.max)))
      if (b.g && gs) set(b.g, Math.round(gOf(ev.clientY - svg.top) * 10) / 10)
      setUI({ hint: `${b.label}: ${fmtValue(p[b.f], 'Hz')}${b.g ? ` · ${fmtValue(p[b.g], 'dB')}` : ''}` })
    })
  }
  return (
    <div className="flex flex-col gap-2">
      <div ref={wrap} className="overflow-hidden rounded-[5px] bg-ink-0 ring-1 ring-line ring-inset">
        <svg width={W} height={H} className="block" data-help="EQ curve · drag a node: left/right = frequency, up/down = gain · wheel over the mid node = Q · double-click a node to flatten">
          {[100, 1000, 10000].map((f) => <line key={f} x1={xOf(f)} x2={xOf(f)} y1={0} y2={H} stroke="var(--color-line-soft)" />)}
          {[-12, -6, 0, 6, 12].map((g) => <line key={g} x1={0} x2={W} y1={yOf(g)} y2={yOf(g)} stroke={g === 0 ? 'var(--color-line)' : 'var(--color-line-soft)'} />)}
          {[100, 1000, 10000].map((f) => <text key={f} x={xOf(f) + 3} y={H - 4} fontSize={9} fill="var(--color-fg-3)">{f >= 1000 ? `${f / 1000}k` : f}</text>)}
          <polyline points={`0,${H / 2} ${pts.join(' ')} ${W},${H / 2}`} fill="rgba(233,162,59,0.08)" stroke="none" />
          <polyline points={pts.join(' ')} fill="none" stroke="var(--color-tape)" strokeWidth={1.6} />
          {bands.map((b) => (
            <g key={b.id} className="cursor-grab">
              <circle
                cx={xOf(p[b.f])}
                cy={b.g ? yOf(p[b.g]) : H / 2}
                r={7}
                fill="var(--color-ink-0)"
                stroke={b.color}
                strokeWidth={1.8}
                onPointerDown={(e) => drag(e, b)}
                onDoubleClick={() => (b.g ? set(b.g, 0) : set(b.f, 20))}
                onWheel={b.id === 'mid' ? (e) => set('midQ', clamp(p.midQ * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.2, 10)) : undefined}
              />
              <text x={xOf(p[b.f])} y={(b.g ? yOf(p[b.g]) : H / 2) + 3} fontSize={8} textAnchor="middle" fill={b.color} className="pointer-events-none font-semibold">{b.label}</text>
            </g>
          ))}
        </svg>
      </div>
      <div className="grid grid-cols-2 gap-[5px]">
        {DEVICE_SPECS.eq.params.map((s) => <ParamBar key={s.key} spec={s} value={p[s.key]} set={set} />)}
      </div>
    </div>
  )
}

// ───────────────────────── Compressor with transfer curve + GR meter ─────────────────────────
export function CompView({ device, set, trackId }: { device: Device; set: SetParam; trackId: string | 'master' }) {
  const p = device.params
  const gr = useRef<HTMLDivElement>(null)
  const grText = useRef<HTMLSpanElement>(null)
  useEffect(
    () =>
      onFrame(() => {
        const r = engine.deviceReduction(trackId, device.id)
        if (gr.current) gr.current.style.width = `${Math.min(1, -r / 24) * 100}%`
        if (grText.current) grText.current.textContent = `${r.toFixed(1)} dB`
      }),
    [trackId, device.id],
  )
  const S = 108
  const lo = -60
  const map = (db: number) => ((db - lo) / -lo) * S
  const curve: string[] = []
  for (let i = lo; i <= 0; i += 1) {
    const k = p.knee
    let out = i
    if (2 * (i - p.threshold) < -k) out = i
    else if (2 * Math.abs(i - p.threshold) <= k && k > 0) out = i + ((1 / p.ratio - 1) * (i - p.threshold + k / 2) ** 2) / (2 * k)
    else out = p.threshold + (i - p.threshold) / p.ratio
    curve.push(`${map(i)},${S - map(out + p.makeup)}`)
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <svg width={S} height={S} className="shrink-0 rounded-[5px] bg-ink-0 ring-1 ring-line ring-inset" data-help="Transfer curve: input level (x) against output level (y), including make-up gain">
          <line x1={0} y1={S} x2={S} y2={0} stroke="var(--color-line)" strokeDasharray="3 3" />
          <line x1={map(p.threshold)} x2={map(p.threshold)} y1={0} y2={S} stroke="var(--color-cv)" strokeOpacity={0.4} />
          <polyline points={curve.join(' ')} fill="none" stroke="var(--color-tape)" strokeWidth={1.6} />
        </svg>
        <div className="flex flex-1 flex-col justify-end gap-1">
          <div className="flex items-baseline justify-between"><span className="label">Gain reduction</span><span ref={grText} className="num text-[11px]">0.0 dB</span></div>
          <div className="h-[8px] overflow-hidden rounded-[2px] bg-ink-0 ring-1 ring-line ring-inset" data-help="Live gain reduction (0 to 24 dB)">
            <div ref={gr} className="h-full bg-warn" style={{ width: 0 }} />
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-[5px]">
        {DEVICE_SPECS.comp.params.map((s) => <ParamBar key={s.key} spec={s} value={p[s.key]} set={set} />)}
      </div>
    </div>
  )
}

// ───────────────────────── Filter with XY pad ─────────────────────────
export function FilterView({ device, set }: { device: Device; set: SetParam }) {
  const p = device.params
  const c = spec(device, 'cutoff')
  const r = spec(device, 'res')
  return (
    <div className="flex flex-col gap-2">
      <Segmented
        value={Math.round(p.mode)}
        onChange={(v) => set('mode', v)}
        size="xs"
        options={[{ value: 0, label: 'Low-pass' }, { value: 1, label: 'High-pass' }, { value: 2, label: 'Band-pass' }]}
      />
      <XYPad
        x={toNorm(p.cutoff, c.min, c.max, 'log')}
        y={toNorm(p.res, r.min, r.max, 'log')}
        onChange={(x, y) => { set('cutoff', Math.round(fromNorm(x, c.min, c.max, 'log'))); set('res', Math.round(fromNorm(y, r.min, r.max, 'log') * 100) / 100) }}
        xLabel="Cutoff"
        yLabel="Res"
        fx={fmtValue(p.cutoff, 'Hz')}
        fy={p.res.toFixed(2)}
        height={110}
      />
    </div>
  )
}

export function LimiterView({ device, set, trackId }: { device: Device; set: SetParam; trackId: string | 'master' }) {
  const gr = useRef<HTMLDivElement>(null)
  const txt = useRef<HTMLSpanElement>(null)
  useEffect(
    () =>
      onFrame(() => {
        const r = engine.deviceReduction(trackId, device.id)
        if (gr.current) gr.current.style.width = `${Math.min(1, -r / 12) * 100}%`
        if (txt.current) txt.current.textContent = `${r.toFixed(1)} dB`
      }),
    [trackId, device.id],
  )
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between"><span className="label">Limiting</span><span ref={txt} className="num text-[11px]">0.0 dB</span></div>
      <div className="h-[8px] overflow-hidden rounded-[2px] bg-ink-0 ring-1 ring-line ring-inset" data-help="Live gain reduction (0 to 12 dB). Constant heavy limiting flattens transients.">
        <div ref={gr} className="h-full bg-warn" style={{ width: 0 }} />
      </div>
      <GenericDevice device={device} set={set} />
    </div>
  )
}

export function GenericDevice({ device, set }: { device: Device; set: SetParam }) {
  return (
    <div className="grid grid-cols-2 gap-[5px]">
      {DEVICE_SPECS[device.type].params.map((s) => <ParamBar key={s.key} spec={s} value={device.params[s.key]} set={set} />)}
    </div>
  )
}

export function DeviceBody({ device, set, trackId }: { device: Device; set: SetParam; trackId: string | 'master' }) {
  switch (device.type) {
    case 'eq': return <EQView device={device} set={set} />
    case 'comp': return <CompView device={device} set={set} trackId={trackId} />
    case 'limiter': return <LimiterView device={device} set={set} trackId={trackId} />
    case 'filter': return <FilterView device={device} set={set} />
    default: return <GenericDevice device={device} set={set} />
  }
}
