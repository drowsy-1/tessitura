import { useRef } from 'react'
import { engine } from '../../engine'
import { clamp, fromNorm, toNorm } from '../../engine/dsp'
import { DRUM_PRESETS, DRUM_VOICES, SYNTH_PRESETS } from '../../state/defaults'
import { edit, findTrack, gestureKey, setUI } from '../../state/store'
import type { DrumParams, SynthParams, Track, Wave } from '../../state/types'
import { Bar, Menu, MenuItem, NumberField, Segmented, XYPad, fmtValue, startDrag } from '../../ui/controls'
import { Icon } from '../../ui/icons'
import { useElementWidth } from '../../ui/hooks'

const WAVES: { value: Wave; label: React.ReactNode; title: string }[] = [
  { value: 'sine', title: 'Sine', label: <svg width="18" height="10" viewBox="0 0 18 10"><path d="M1 5 C4 -1 6 -1 9 5 S14 11 17 5" stroke="currentColor" fill="none" strokeWidth="1.5" /></svg> },
  { value: 'triangle', title: 'Triangle', label: <svg width="18" height="10" viewBox="0 0 18 10"><path d="M1 5 L5 1 L13 9 L17 5" stroke="currentColor" fill="none" strokeWidth="1.5" /></svg> },
  { value: 'sawtooth', title: 'Saw', label: <svg width="18" height="10" viewBox="0 0 18 10"><path d="M1 9 L9 1 L9 9 L17 1" stroke="currentColor" fill="none" strokeWidth="1.5" /></svg> },
  { value: 'square', title: 'Square', label: <svg width="18" height="10" viewBox="0 0 18 10"><path d="M1 9 L1 1 L9 1 L9 9 L17 9 L17 1" stroke="currentColor" fill="none" strokeWidth="1.5" /></svg> },
]

function instrumentWriter(track: Track) {
  return (fn: (p: SynthParams & DrumParams) => void, coalesce?: string) =>
    edit((p) => {
      const t = findTrack(p, track.id)
      if (t?.instrument) {
        fn(t.instrument.params as SynthParams & DrumParams)
        t.instrument.preset = t.instrument.preset.endsWith('*') ? t.instrument.preset : `${t.instrument.preset}*`
      }
    }, { coalesce: coalesce ? `inst:${track.id}:${coalesce}` : undefined })
}

// ───────────────────────── ADSR envelope, edited by dragging its corners ─────────────────────────
function ADSR({ p, write }: { p: SynthParams; write: (fn: (x: SynthParams) => void, co?: string) => void }) {
  const wrap = useRef<HTMLDivElement>(null)
  const W = useElementWidth(wrap)
  const H = 84
  const seg = W / 3.3 // each time segment gets up to this many px
  const tx = (t: number, max: number) => toNorm(Math.max(0.001, t), 0.001, max, 'log') * seg
  const ax = tx(p.attack, 4)
  const dx = ax + tx(p.decay, 4)
  const sx = dx + seg * 0.3
  const rx = sx + tx(p.release, 8)
  const sy = 6 + (1 - p.sustain) * (H - 12)
  const drag = (e: React.PointerEvent, which: 'a' | 'd' | 'r') => {
    e.stopPropagation()
    const key = gestureKey()
    const r = wrap.current!.getBoundingClientRect()
    startDrag(e, (_x, _y, ev) => {
      const x = ev.clientX - r.left
      write((q) => {
        if (which === 'a') q.attack = Math.round(fromNorm(clamp(x / seg, 0, 1), 0.001, 4, 'log') * 1000) / 1000
        if (which === 'd') {
          q.decay = Math.round(fromNorm(clamp((x - ax) / seg, 0, 1), 0.001, 4, 'log') * 1000) / 1000
          q.sustain = Math.round(clamp(1 - (ev.clientY - r.top - 6) / (H - 12), 0, 1) * 100) / 100
        }
        if (which === 'r') q.release = Math.round(fromNorm(clamp((x - sx) / seg, 0, 1), 0.001, 8, 'log') * 1000) / 1000
      }, key)
      setUI({ hint: which === 'a' ? `Attack ${fmtValue(p.attack, 's')}` : which === 'd' ? `Decay ${fmtValue(p.decay, 's')} · Sustain ${Math.round(p.sustain * 100)}%` : `Release ${fmtValue(p.release, 's')}` })
    })
  }
  const handle = (x: number, y: number, which: 'a' | 'd' | 'r', help: string) => (
    <circle cx={x} cy={y} r={6} fill="var(--color-ink-0)" stroke="var(--color-cv)" strokeWidth={1.8} className="cursor-grab" onPointerDown={(e) => drag(e, which)}>
      <title>{help}</title>
    </circle>
  )
  return (
    <div ref={wrap} className="rounded-[5px] bg-ink-0 ring-1 ring-line ring-inset" data-help="Amp envelope · drag the corners: attack time, decay time + sustain level, release time">
      <svg width={W} height={H} className="block">
        <path d={`M0 ${H - 6} L${ax} 6 L${dx} ${sy} L${sx} ${sy} L${rx} ${H - 6}`} fill="rgba(88,196,208,0.08)" stroke="var(--color-cv)" strokeWidth={1.6} />
        {handle(ax, 6, 'a', 'Attack')}
        {handle(dx, sy, 'd', 'Decay / sustain')}
        {handle(rx, H - 6, 'r', 'Release')}
      </svg>
      <div className="num flex justify-between px-2 pb-1 text-[9px] text-fg-3">
        <span>A {fmtValue(p.attack, 's')}</span><span>D {fmtValue(p.decay, 's')}</span><span>S {Math.round(p.sustain * 100)}%</span><span>R {fmtValue(p.release, 's')}</span>
      </div>
    </div>
  )
}

export function SynthView({ track }: { track: Track }) {
  if (track.instrument?.type !== 'synth') return null
  const p = track.instrument.params
  const write = instrumentWriter(track) as unknown as (fn: (x: SynthParams) => void, co?: string) => void
  return (
    <div className="flex flex-col gap-[10px]">
      <PresetMenu track={track} names={Object.keys(SYNTH_PRESETS)} />
      <div className="flex flex-col gap-[6px]">
        <div className="flex items-center justify-between"><span className="label">Osc 1</span><Segmented value={p.osc1} onChange={(v) => write((q) => { q.osc1 = v })} size="xs" options={WAVES} help="Oscillator 1 waveform" /></div>
        <div className="flex items-center justify-between"><span className="label">Osc 2</span><Segmented value={p.osc2} onChange={(v) => write((q) => { q.osc2 = v })} size="xs" options={WAVES} help="Oscillator 2 waveform" /></div>
        <div className="flex items-center gap-2">
          <span className="label w-[42px]">Tune</span>
          <NumberField value={p.osc2Semi} min={-24} max={24} step={1} width={58} def={0} format={(v) => `${v > 0 ? '+' : ''}${v} st`} help="Osc 2 coarse tune (semitones)" onChange={(v) => write((q) => { q.osc2Semi = v }, 'semi')} />
          <NumberField value={p.osc2Detune} min={-50} max={50} step={1} width={58} def={0} format={(v) => `${v > 0 ? '+' : ''}${v} ct`} help="Osc 2 fine tune (cents): small values thicken the sound" onChange={(v) => write((q) => { q.osc2Detune = v }, 'det')} />
        </div>
        <Bar value={p.oscMix} min={0} max={1} def={0.5} height={20} label="Osc 1 ⟷ Osc 2" format={(v) => `${Math.round((1 - v) * 100)}/${Math.round(v * 100)}`} onChange={(v) => write((q) => { q.oscMix = v }, 'mix')} help="Oscillator balance" />
      </div>
      <div className="flex flex-col gap-[6px]">
        <span className="label">Filter</span>
        <XYPad
          x={toNorm(p.cutoff, 40, 16000, 'log')}
          y={toNorm(p.resonance, 0.5, 18, 'log')}
          onChange={(x, y) => write((q) => { q.cutoff = Math.round(fromNorm(x, 40, 16000, 'log')); q.resonance = Math.round(fromNorm(y, 0.5, 18, 'log') * 100) / 100 }, 'xy')}
          xLabel="Cutoff"
          yLabel="Res"
          fx={fmtValue(p.cutoff, 'Hz')}
          fy={p.resonance.toFixed(2)}
          height={96}
        />
        <Bar value={p.envAmount} min={0} max={8000} def={1500} height={20} label="Env → cutoff" format={(v) => fmtValue(v, 'Hz')} onChange={(v) => write((q) => { q.envAmount = Math.round(v) }, 'env')} help="How far the envelope opens the filter" />
      </div>
      <div className="flex flex-col gap-[6px]">
        <span className="label">Envelope</span>
        <ADSR p={p} write={write} />
      </div>
      <div className="grid grid-cols-2 gap-[5px]">
        <Bar value={p.glide} min={0} max={0.5} def={0} height={20} label="Glide" format={(v) => (v ? `${Math.round(v * 1000)} ms` : 'off')} onChange={(v) => write((q) => { q.glide = Math.round(v * 1000) / 1000 }, 'glide')} help="Portamento time between notes" />
        <Bar value={p.gain} min={-36} max={0} def={-10} height={20} label="Level" format={(v) => fmtValue(v, 'dB')} onChange={(v) => write((q) => { q.gain = Math.round(v * 10) / 10 }, 'gain')} help="Instrument output level" />
      </div>
    </div>
  )
}

export function DrumView({ track }: { track: Track }) {
  if (track.instrument?.type !== 'drums') return null
  const p = track.instrument.params
  const write = instrumentWriter(track) as unknown as (fn: (x: DrumParams) => void, co?: string) => void
  return (
    <div className="flex flex-col gap-[10px]">
      <PresetMenu track={track} names={Object.keys(DRUM_PRESETS)} />
      <div className="grid grid-cols-1 gap-[5px]">
        <Bar value={p.tune} min={-12} max={12} def={0} bipolar height={20} label="Tune" format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} st`} onChange={(v) => write((q) => { q.tune = Math.round(v * 10) / 10 }, 'tune')} help="Pitch of the whole kit" />
        <Bar value={p.decay} min={0.3} max={2.5} def={1} height={20} label="Decay" format={(v) => `×${v.toFixed(2)}`} onChange={(v) => write((q) => { q.decay = Math.round(v * 100) / 100 }, 'decay')} help="Length of every voice" />
        <Bar value={p.tone} min={0} max={1} def={0.5} height={20} label="Tone" format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => write((q) => { q.tone = Math.round(v * 100) / 100 }, 'tone')} help="Brightness of noise-based voices" />
      </div>
      <div className="flex flex-col gap-[4px]">
        <span className="label">Voices</span>
        {DRUM_VOICES.map((v, i) => (
          <div key={v.pitch} className="flex items-center gap-[6px]">
            <button
              className="flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-[3px] bg-ink-3 text-fg-3 hover:bg-tape hover:text-[#1a1204]"
              onPointerDown={() => engine.liveNoteOn(track.id, v.pitch, 0.9)}
              aria-label={`Play ${v.name}`}
              data-help={`Play ${v.name}`}
            >
              <Icon name="play" size={9} />
            </button>
            <Bar value={p.levels[i] ?? 0} min={-36} max={6} def={0} height={20} className="flex-1" label={v.name} format={(x) => fmtValue(x, 'dB')} onChange={(x) => write((q) => { q.levels[i] = Math.round(x * 10) / 10 }, `lvl${i}`)} help={`${v.name} level`} />
          </div>
        ))}
      </div>
    </div>
  )
}

function PresetMenu({ track, names }: { track: Track; names: string[] }) {
  const inst = track.instrument!
  return (
    <Menu
      width={220}
      trigger={(open) => (
        <button className="btn w-full justify-between" onClick={open} data-help="Load a preset (an asterisk means you've edited it)">
          <span className="truncate">{inst.preset}</span>
          <Icon name="chevronDown" size={12} />
        </button>
      )}
    >
      {(close) =>
        names.map((n) => (
          <MenuItem
            key={n}
            onClick={() => {
              edit((p) => {
                const t = findTrack(p, track.id)
                if (!t) return
                if (inst.type === 'synth') t.instrument = { type: 'synth', preset: n, params: { ...SYNTH_PRESETS[n] } }
                else t.instrument = { type: 'drums', preset: n, params: { ...DRUM_PRESETS[n], levels: [...DRUM_PRESETS[n].levels] } }
              }, { label: 'Load preset' })
              close()
            }}
          >
            {n}
          </MenuItem>
        ))
      }
    </Menu>
  )
}
