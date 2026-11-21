import { useEffect, useRef } from 'react'
import { engine, onFrame } from '../engine'
import { updateTrack } from '../state/actions'
import { DEVICE_SPECS } from '../state/defaults'
import { edit, setUI, useProject, useUI } from '../state/store'
import type { Track } from '../state/types'
import { Bar, Fader, Meter, NumberField, Toggle, fmtDb } from '../ui/controls'

const FADER_H = 128

function panFmt(v: number) {
  return Math.abs(v) < 0.01 ? 'C' : v < 0 ? `${Math.round(-v * 100)}L` : `${Math.round(v * 100)}R`
}

function Strip({ track, isReturn }: { track: Track; isReturn?: boolean }) {
  const selected = useUI((s) => s.selectedTrack === track.id)
  const project = useProject((s) => s.project)
  return (
    <div
      className={`flex w-[96px] shrink-0 flex-col gap-[6px] border-r border-line px-[7px] py-2 ${selected ? 'bg-ink-2' : 'bg-ink-1'}`}
      onPointerDown={() => setUI({ selectedTrack: track.id })}
    >
      <div className="flex items-center gap-[5px]">
        <span className="h-3 w-[3px] shrink-0 rounded-full" style={{ background: track.color }} />
        <span className="truncate text-[11px] font-semibold">{track.name}</span>
      </div>
      <div className="flex min-h-[30px] flex-col gap-[2px]" data-help="Device chain · click to open in the inspector">
        {track.devices.length ? (
          track.devices.slice(0, 3).map((d) => (
            <button key={d.id} onClick={() => setUI({ selectedTrack: track.id, showInspector: true })} className={`truncate rounded-[3px] px-1 text-left text-[10px] ${d.on ? 'bg-ink-3 text-fg-2' : 'bg-ink-0 text-fg-3 line-through'}`}>
              {DEVICE_SPECS[d.type].label}
            </button>
          ))
        ) : (
          <span className="text-[10px] text-fg-3">no devices</span>
        )}
        {track.devices.length > 3 && <span className="text-[9px] text-fg-3">+{track.devices.length - 3} more</span>}
      </div>
      {!isReturn && (
        <div className="flex flex-col gap-[3px]">
          {project.returns.map((r, i) => (
            <Bar
              key={r.id}
              value={track.sends[i] ?? -60}
              min={-60}
              max={6}
              def={-60}
              height={15}
              label={String.fromCharCode(65 + i)}
              color="var(--color-cv)"
              help={`Send to ${r.name} (post-fader)`}
              format={(v) => fmtDb(v)}
              onChange={(v) => updateTrack(track.id, (t) => { t.sends[i] = Math.round(v * 10) / 10 }, `send${i}`)}
            />
          ))}
        </div>
      )}
      <Bar value={track.pan} min={-1} max={1} def={0} bipolar height={15} label="Pan" color={track.color} format={panFmt} help={`${track.name} pan`} onChange={(v) => updateTrack(track.id, (t) => { t.pan = Math.round(v * 100) / 100 }, 'pan')} />
      <div className="flex justify-center gap-[5px]">
        <Fader db={track.volume} height={FADER_H} help={`${track.name} volume`} onChange={(v) => updateTrack(track.id, (t) => { t.volume = v }, 'vol')} />
        <Meter source={track.id} height={FADER_H} width={11} />
      </div>
      <NumberField value={track.volume} min={-60} max={6} step={0.1} width={80} def={0} format={(v) => `${fmtDb(v)} dB`} help="Volume in dB" onChange={(v) => updateTrack(track.id, (t) => { t.volume = v }, 'vol')} className="mx-auto" />
      <div className="flex justify-center gap-1">
        <Toggle on={track.mute} onClick={() => updateTrack(track.id, (t) => { t.mute = !t.mute })} title="Mute" tone="warn">M</Toggle>
        {!isReturn && <Toggle on={track.solo} onClick={() => updateTrack(track.id, (t) => { t.solo = !t.solo })} title="Solo" tone="cv">S</Toggle>}
        {!isReturn && <Toggle on={track.arm} onClick={() => updateTrack(track.id, (t) => { t.arm = !t.arm })} title="Arm for recording" tone="rec">●</Toggle>}
      </div>
    </div>
  )
}

function MasterStrip() {
  const master = useProject((s) => s.project.master)
  const refs = { m: useRef<HTMLSpanElement>(null), s: useRef<HTMLSpanElement>(null), i: useRef<HTMLSpanElement>(null), p: useRef<HTMLSpanElement>(null), bar: useRef<HTMLDivElement>(null) }
  useEffect(
    () =>
      onFrame(() => {
        const l = engine.loudness
        const f = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '—')
        if (refs.m.current) refs.m.current.textContent = f(l.momentary)
        if (refs.s.current) refs.s.current.textContent = f(l.shortTerm)
        if (refs.i.current) refs.i.current.textContent = f(l.integrated)
        if (refs.p.current) {
          refs.p.current.textContent = f(l.peakHold)
          refs.p.current.style.color = l.peakHold > -1 ? 'var(--color-rec)' : ''
        }
        if (refs.bar.current) {
          const v = Number.isFinite(l.shortTerm) ? l.shortTerm : Number.isFinite(l.momentary) ? l.momentary : -40
          refs.bar.current.style.height = `${Math.max(0, Math.min(1, (v + 36) / 36)) * 100}%`
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  const row = (label: string, ref: React.RefObject<HTMLSpanElement | null>, help: string) => (
    <div className="flex items-baseline justify-between gap-2" data-help={help}>
      <span className="label !text-[9px]">{label}</span>
      <span ref={ref} className="num text-[12px] text-fg">—</span>
    </div>
  )
  return (
    <div className="flex w-[204px] shrink-0 flex-col gap-2 border-l border-line bg-ink-2 px-3 py-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em]">Master</span>
        <button className="text-[10px] text-fg-3 hover:text-fg-2" onClick={() => setUI({ selectedTrack: 'master', showInspector: true })} data-help="Open the master device chain in the inspector">
          {master.devices.length} device{master.devices.length === 1 ? '' : 's'}
        </button>
      </div>
      <div className="flex gap-3">
        <div className="flex flex-1 flex-col gap-[3px]">
          {row('Mom.', refs.m, 'Momentary loudness, 400 ms window (LUFS)')}
          {row('Short', refs.s, 'Short-term loudness, 3 s window (LUFS)')}
          {row('Integ.', refs.i, 'Integrated loudness since play started, gated per BS.1770 (LUFS)')}
          {row('Peak', refs.p, 'Highest sample peak since play started (dBFS). Keep under −1 dBTP for streaming.')}
          <div className="mt-1 rounded-[4px] bg-ink-0 p-[6px] text-[10px] leading-[14px] text-fg-3" data-help="Loudness normalisation targets">
            Spotify / YouTube <span className="num text-fg-2">−14</span><br />Apple Music <span className="num text-fg-2">−16</span><br />True peak ceiling <span className="num text-fg-2">−1 dBTP</span>
          </div>
          <button className="btn btn-ghost mt-auto h-[22px] text-[10px]" onClick={() => engine.resetLoudness()} data-help="Reset loudness measurement">Reset meter</button>
        </div>
        <div className="flex gap-[5px]">
          <div className="relative w-[8px] overflow-hidden rounded-[2px] bg-ink-0" style={{ height: FADER_H }} data-help="Short-term loudness bar: top = 0 LUFS, bottom = −36 LUFS; the tick marks −14">
            <div ref={refs.bar} className="absolute inset-x-0 bottom-0 bg-cv/70" />
            <div className="absolute inset-x-0 h-px bg-fg" style={{ bottom: `${(22 / 36) * 100}%` }} />
          </div>
          <Fader db={master.volume} height={FADER_H} help="Master volume" onChange={(v) => edit((p) => { p.master.volume = v }, { coalesce: 'mvol' })} />
          <Meter source="master" height={FADER_H} width={12} />
        </div>
      </div>
      <NumberField value={master.volume} min={-60} max={6} step={0.1} width={80} def={0} format={(v) => `${fmtDb(v)} dB`} help="Master volume in dB" onChange={(v) => edit((p) => { p.master.volume = v }, { coalesce: 'mvol' })} className="ml-auto" />
    </div>
  )
}

export function Mixer() {
  const project = useProject((s) => s.project)
  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 overflow-x-auto">
        {project.tracks.map((t) => <Strip key={t.id} track={t} />)}
        <div className="w-3 shrink-0 bg-ink-0" />
        {project.returns.map((t) => <Strip key={t.id} track={t} isReturn />)}
        <div className="flex-1 bg-ink-0" />
      </div>
      <MasterStrip />
    </div>
  )
}
