// Knob-free control set: faders, bar sliders, drag-number fields, XY pads, segmented switches.
// Every control supports: drag, Shift for fine adjustment, double-click to reset,
// mouse-wheel nudging, arrow keys, and typing a value.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { clamp, dbToFader, faderToDb, fromNorm, toNorm } from '../engine/dsp'
import { onFrame, engine } from '../engine'

export function startDrag(
  e: React.PointerEvent | PointerEvent,
  onMove: (dx: number, dy: number, ev: PointerEvent) => void,
  onEnd?: (ev: PointerEvent, moved: boolean) => void,
) {
  const x0 = e.clientX
  const y0 = e.clientY
  let moved = false
  const move = (ev: PointerEvent) => {
    if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) > 2) moved = true
    onMove(ev.clientX - x0, ev.clientY - y0, ev)
  }
  const up = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
    document.body.style.cursor = ''
    onEnd?.(ev, moved)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
}

const fmtDb = (db: number) => (db <= -60 ? '−∞' : `${db > 0 ? '+' : db < 0 ? '−' : ''}${Math.abs(db).toFixed(1)}`)
export { fmtDb }

export function fmtValue(v: number, unit?: string, step?: number) {
  if (unit === 'Hz') return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz` : `${Math.round(v)} Hz`
  if (unit === 'dB') return `${fmtDb(v)} dB`
  if (unit === 'ms') return v < 10 ? `${v.toFixed(1)} ms` : `${Math.round(v)} ms`
  if (unit === '%') return `${Math.round(v)}%`
  if (unit === 's') return `${v.toFixed(2)} s`
  if (unit === ':1') return `${v.toFixed(1)}:1`
  if (unit === 'beat') return beatDivision(v)
  const d = step && step < 1 ? Math.max(0, Math.min(3, Math.ceil(-Math.log10(step)))) : 0
  return `${v.toFixed(d)}${unit ? ` ${unit}` : ''}`
}

function beatDivision(b: number) {
  const map: Record<string, string> = { '0.125': '1/32', '0.25': '1/16', '0.375': '1/16.', '0.5': '1/8', '0.75': '1/8.', '1': '1/4', '1.5': '1/4.', '2': '1/2' }
  return map[String(b)] ?? `${b} beat`
}

// ───────────────────────── Vertical fader ─────────────────────────
export function Fader({ db, onChange, height = 150, help = 'Volume fader', id }: { db: number; onChange: (db: number) => void; height?: number; help?: string; id?: string }) {
  const n = dbToFader(db)
  const capH = 14
  const travel = height - capH
  const ticks = [6, 0, -6, -12, -24, -36, -60]
  const set = (v: number) => onChange(Math.round(clamp(v, -60, 6) * 10) / 10)
  return (
    <div
      id={id}
      role="slider"
      tabIndex={0}
      aria-label={help}
      aria-valuemin={-60}
      aria-valuemax={6}
      aria-valuenow={db}
      data-help={`${help} · drag · Shift = fine · double-click = 0 dB · wheel nudges`}
      className="relative cursor-ns-resize touch-none"
      style={{ height, width: 34 }}
      onPointerDown={(e) => {
        const start = n
        startDrag(e, (_dx, dy, ev) => set(faderToDb(start - (dy / travel) * (ev.shiftKey ? 0.15 : 1))))
      }}
      onDoubleClick={() => set(0)}
      onWheel={(e) => set(db - Math.sign(e.deltaY) * (e.shiftKey ? 0.1 : 0.5))}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') { set(db + (e.shiftKey ? 0.1 : 0.5)); e.preventDefault() }
        if (e.key === 'ArrowDown') { set(db - (e.shiftKey ? 0.1 : 0.5)); e.preventDefault() }
      }}
    >
      {ticks.map((t) => (
        <div key={t} className="absolute left-0 right-0 flex items-center" style={{ top: capH / 2 + (1 - dbToFader(t)) * travel - 5 }}>
          <span className="num w-[14px] text-right text-[8px] leading-[10px] text-fg-3">{t === -60 ? '∞' : Math.abs(t)}</span>
          <span className={`ml-[3px] h-px ${t === 0 ? 'w-[17px] bg-fg-3' : 'w-[9px] bg-line'}`} />
        </div>
      ))}
      <div className="absolute rounded-full bg-ink-0" style={{ left: 22, width: 4, top: capH / 2, bottom: capH / 2 }} />
      <div
        className="absolute rounded-full bg-tape/70"
        style={{ left: 22, width: 4, top: capH / 2 + (1 - n) * travel, bottom: capH / 2 }}
      />
      <div
        className="absolute rounded-[3px] border border-[#4a5160] bg-gradient-to-b from-[#3a404c] to-[#2a2f39] shadow-[0_2px_4px_rgba(0,0,0,0.5)]"
        style={{ left: 16, width: 16, height: capH, top: (1 - n) * travel }}
      >
        <div className="absolute left-[2px] right-[2px] top-1/2 h-px bg-fg" />
      </div>
    </div>
  )
}

// ───────────────────────── Horizontal bar slider ─────────────────────────
export function Bar({
  value, min, max, onChange, def, bipolar, curve = 'lin', label, format, height = 20, color = 'var(--color-tape)', help, step, className = '', id,
}: {
  value: number; min: number; max: number; onChange: (v: number) => void; def?: number; bipolar?: boolean; curve?: 'lin' | 'log'
  label?: ReactNode; format?: (v: number) => string; height?: number; color?: string; help?: string; step?: number; className?: string; id?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const n = clamp(toNorm(value, min, max, curve), 0, 1)
  const q = (v: number) => (step ? Math.round(v / step) * step : v)
  const set = (nn: number) => onChange(q(fromNorm(clamp(nn, 0, 1), min, max, curve)))
  const center = bipolar ? toNorm(def ?? 0, min, max, curve) : 0
  const lo = Math.min(center, n)
  const hi = Math.max(center, n)
  return (
    <div
      ref={ref}
      id={id}
      role="slider"
      tabIndex={0}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      data-help={`${help ?? (typeof label === 'string' ? label : 'Slider')} · click or drag · Shift = fine · double-click = reset`}
      className={`relative cursor-ew-resize touch-none overflow-hidden rounded-[4px] bg-ink-0 ring-1 ring-line ring-inset ${className}`}
      style={{ height }}
      onPointerDown={(e) => {
        const r = ref.current!.getBoundingClientRect()
        if (e.shiftKey) {
          const start = n
          startDrag(e, (dx) => set(start + (dx / r.width) * 0.15))
          return
        }
        set((e.clientX - r.left) / r.width)
        startDrag(e, (_dx, _dy, ev) => set((ev.clientX - r.left) / r.width))
      }}
      onDoubleClick={() => def !== undefined && onChange(def)}
      onWheel={(e) => set(n - Math.sign(e.deltaY) * (e.shiftKey ? 0.005 : 0.02))}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { set(n + (e.shiftKey ? 0.005 : 0.02)); e.preventDefault() }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { set(n - (e.shiftKey ? 0.005 : 0.02)); e.preventDefault() }
      }}
    >
      <div className="absolute inset-y-0 opacity-45" style={{ left: `${lo * 100}%`, width: `${(hi - lo) * 100}%`, background: color }} />
      <div className="absolute inset-y-0 w-[2px]" style={{ left: `calc(${n * 100}% - 1px)`, background: color }} />
      {bipolar && <div className="absolute inset-y-[3px] w-px bg-fg-3/50" style={{ left: `${center * 100}%` }} />}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-between gap-1 px-[6px] text-[10px] leading-none [text-shadow:0_0_3px_#0e1014,0_0_2px_#0e1014]">
        <span className="truncate text-fg-2">{label}</span>
        <span className="num shrink-0 text-fg">{format ? format(value) : value.toFixed(2)}</span>
      </div>
    </div>
  )
}

// ───────────────────────── Drag-number field ─────────────────────────
export function NumberField({
  value, onChange, min, max, step = 1, format, width = 64, help, curve = 'lin', def, className = '', id,
}: {
  value: number; onChange: (v: number) => void; min: number; max: number; step?: number; format?: (v: number) => string
  width?: number; help?: string; curve?: 'lin' | 'log'; def?: number; className?: string; id?: string
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const q = (v: number) => clamp(Math.round(v / step) * step, min, max)
  if (editing)
    return (
      <input
        id={id}
        autoFocus
        className={`field num h-[22px] px-1 text-right text-[11px] ${className}`}
        style={{ width }}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            const v = parseFloat(text.replace('−', '-'))
            if (!Number.isNaN(v)) onChange(q(v))
            setEditing(false)
          }
          if (e.key === 'Escape') setEditing(false)
        }}
      />
    )
  return (
    <div
      id={id}
      role="spinbutton"
      tabIndex={0}
      aria-valuenow={value}
      data-help={`${help ?? 'Value'} · drag up/down · Shift = fine · double-click to type`}
      className={`num flex h-[22px] shrink-0 cursor-ns-resize touch-none items-center justify-end whitespace-nowrap rounded-[4px] bg-ink-0 px-[6px] text-[11px] text-fg ring-1 ring-line ring-inset hover:ring-fg-3 ${className}`}
      style={{ width }}
      onPointerDown={(e) => {
        if (e.detail > 1) return
        const start = toNorm(value, min, max, curve)
        startDrag(e, (_dx, dy, ev) => {
          const range = ev.shiftKey ? 1200 : 200
          onChange(q(fromNorm(start - dy / range, min, max, curve)))
        })
      }}
      onDoubleClick={() => {
        setText(String(value))
        setEditing(true)
      }}
      onContextMenu={(e) => {
        if (def !== undefined) { e.preventDefault(); onChange(def) }
      }}
      onWheel={(e) => onChange(q(value - Math.sign(e.deltaY) * step * (e.shiftKey ? 1 : curve === 'log' ? Math.max(1, value * 0.02 / step) : 1)))}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') { onChange(q(value + step)); e.preventDefault() }
        if (e.key === 'ArrowDown') { onChange(q(value - step)); e.preventDefault() }
        if (e.key === 'Enter') { setText(String(value)); setEditing(true) }
      }}
    >
      {format ? format(value) : value}
    </div>
  )
}

// ───────────────────────── Segmented switch ─────────────────────────
export function Segmented<T extends string | number>({
  value, options, onChange, size = 'sm', help,
}: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; size?: 'xs' | 'sm'; help?: string }) {
  return (
    <div className="inline-flex rounded-[5px] bg-ink-0 p-[2px] ring-1 ring-line ring-inset" role="radiogroup" data-help={help}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          data-help={o.title ?? help}
          onClick={() => onChange(o.value)}
          className={`flex items-center gap-1 rounded-[4px] ${size === 'xs' ? 'h-[18px] px-[6px] text-[10px]' : 'h-[22px] px-2 text-[11px]'} font-medium transition-colors ${
            o.value === value ? 'bg-ink-3 text-fg shadow-[inset_0_-1.5px_0_var(--color-tape)]' : 'text-fg-3 hover:text-fg-2'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ───────────────────────── Small toggles (M / S / ● / etc.) ─────────────────────────
export function Toggle({ on, onClick, children, tone = 'tape', title, className = '' }: { on: boolean; onClick: (e: React.MouseEvent) => void; children: ReactNode; tone?: 'tape' | 'rec' | 'cv' | 'ok' | 'warn'; title: string; className?: string }) {
  const tones = { tape: 'bg-tape text-[#1a1204]', rec: 'bg-rec text-white', cv: 'bg-cv text-[#04181b]', ok: 'bg-ok text-[#08180b]', warn: 'bg-warn text-[#1a1604]' }
  return (
    <button
      aria-pressed={on}
      title={title}
      data-help={title}
      onClick={onClick}
      className={`flex h-[18px] min-w-[20px] items-center justify-center rounded-[3px] px-1 text-[10px] font-bold transition-colors ${on ? tones[tone] : 'bg-ink-3 text-fg-3 hover:text-fg-2'} ${className}`}
    >
      {children}
    </button>
  )
}

// ───────────────────────── XY pad ─────────────────────────
export function XYPad({
  x, y, onChange, xLabel, yLabel, fx, fy, height = 120, help, color = 'var(--color-tape)',
}: { x: number; y: number; onChange: (x: number, y: number) => void; xLabel: string; yLabel: string; fx: string; fy: string; height?: number; help?: string; color?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const set = (ev: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect()
    onChange(clamp((ev.clientX - r.left) / r.width, 0, 1), clamp(1 - (ev.clientY - r.top) / r.height, 0, 1))
  }
  return (
    <div
      ref={ref}
      data-help={help ?? `Drag: ${xLabel} (horizontal) and ${yLabel} (vertical)`}
      className="relative cursor-crosshair touch-none overflow-hidden rounded-[5px] bg-ink-0 ring-1 ring-line ring-inset"
      style={{ height, backgroundImage: 'linear-gradient(var(--color-line-soft) 1px, transparent 1px), linear-gradient(90deg, var(--color-line-soft) 1px, transparent 1px)', backgroundSize: '25% 25%' }}
      onPointerDown={(e) => {
        set(e)
        startDrag(e, (_a, _b, ev) => set(ev))
      }}
    >
      <div className="absolute inset-y-0 w-px opacity-50" style={{ left: `${x * 100}%`, background: color }} />
      <div className="absolute inset-x-0 h-px opacity-50" style={{ top: `${(1 - y) * 100}%`, background: color }} />
      <div className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-ink-0" style={{ left: `${x * 100}%`, top: `${(1 - y) * 100}%`, background: color, boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 30%, transparent)` }} />
      <div className="pointer-events-none absolute bottom-1 left-2 text-[10px] text-fg-3">{xLabel} <span className="num text-fg-2">{fx}</span></div>
      <div className="pointer-events-none absolute right-2 top-1 text-[10px] text-fg-3">{yLabel} <span className="num text-fg-2">{fy}</span></div>
    </div>
  )
}

// ───────────────────────── Stereo peak meter ─────────────────────────
export function Meter({ source, height = 150, width = 10 }: { source: string | 'master'; height?: number; width?: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current!
    const dpr = window.devicePixelRatio || 1
    c.width = width * dpr
    c.height = height * dpr
    const g = c.getContext('2d')!
    g.scale(dpr, dpr)
    const hold = [0, 0]
    const holdT = [0, 0]
    const disp = [0, 0]
    const grad = g.createLinearGradient(0, height, 0, 0)
    const pos = (db: number) => dbToFader(db)
    grad.addColorStop(0, '#3f8f5a')
    grad.addColorStop(pos(-18), '#6ccb7f')
    grad.addColorStop(pos(-6), '#e8c547')
    grad.addColorStop(pos(-1), '#ef5350')
    grad.addColorStop(1, '#ef5350')
    return onFrame(() => {
      const lv = engine.levels(source)
      const now = performance.now()
      g.clearRect(0, 0, width, height)
      const bw = (width - 1) / 2
      for (let i = 0; i < 2; i++) {
        const db = 20 * Math.log10(Math.max(lv[i], 1e-6))
        const n = dbToFader(Math.min(6, db))
        disp[i] = Math.max(n, disp[i] - 0.018)
        if (n >= hold[i]) { hold[i] = n; holdT[i] = now }
        else if (now - holdT[i] > 1200) hold[i] = Math.max(0, hold[i] - 0.01)
        const x = i * (bw + 1)
        g.fillStyle = '#0b0d11'
        g.fillRect(x, 0, bw, height)
        g.fillStyle = grad
        g.fillRect(x, height * (1 - disp[i]), bw, height * disp[i])
        if (hold[i] > 0.02) {
          g.fillStyle = hold[i] > dbToFader(-0.1) ? '#ef5350' : '#e9e5dc'
          g.fillRect(x, height * (1 - hold[i]), bw, 1.5)
        }
      }
    })
  }, [source, height, width])
  return <canvas ref={ref} style={{ width, height }} className="rounded-[2px]" data-help="Peak meter with 1.2 s peak hold. Red hold line = clipping." />
}

// ───────────────────────── Menu (click-away dropdown) ─────────────────────────
export function Menu({ trigger, children, align = 'left', width = 200 }: { trigger: (open: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; width?: number }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('pointerdown', h)
    window.addEventListener('keydown', k)
    return () => { window.removeEventListener('pointerdown', h); window.removeEventListener('keydown', k) }
  }, [open])
  return (
    <div ref={ref} className="relative">
      {trigger(() => setOpen((o) => !o))}
      {open && (
        <div
          className={`absolute top-full z-50 mt-1 rounded-[7px] border border-line bg-ink-2 p-1 shadow-[0_12px_32px_rgba(0,0,0,0.55)] ${align === 'right' ? 'right-0' : 'left-0'}`}
          style={{ width }}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

export function MenuItem({ onClick, children, hint, danger }: { onClick: () => void; children: ReactNode; hint?: string; danger?: boolean }) {
  return (
    <button onClick={onClick} className={`flex w-full items-center justify-between gap-3 rounded-[4px] px-2 py-[5px] text-left text-[12px] hover:bg-ink-3 ${danger ? 'text-rec' : 'text-fg'}`}>
      <span className="flex items-center gap-2">{children}</span>
      {hint && <span className="num text-[10px] text-fg-3">{hint}</span>}
    </button>
  )
}
