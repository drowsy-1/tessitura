import type { DrumParams, Instrument, SynthParams } from '../state/types'
import { DRUM_VOICES } from '../state/defaults'
import { midiToFreq } from '../lib/music'
import { dbToGain, fromNorm } from './dsp'

export interface InstrumentNode {
  out: GainNode
  noteOn(pitch: number, vel: number, time: number, dur?: number): void
  noteOff(pitch: number, time: number): void
  allOff(): void
  setParams(p: Instrument['params']): void
  /** Automation hook: normalized 0..1 cutoff (synth only). */
  setCutoffAt?(time: number, norm: number, ramp: boolean): void
  releaseCutoff?(): void
  dispose(): void
}

export const CUTOFF_RANGE = { min: 40, max: 16000 }

// ───────────────────────── Subtractive synth ─────────────────────────
interface Voice {
  pitch: number
  start: number
  oscs: OscillatorNode[]
  amp: GainNode
  filter: BiquadFilterNode
  env: ConstantSourceNode
  vel: number
  end: number // when the voice falls silent (Infinity while held)
  released: boolean
  release(t: number): void
  kill(t?: number): void
}

export class Synth implements InstrumentNode {
  out: GainNode
  private ctx: BaseAudioContext
  private p: SynthParams
  private cutoffCV: ConstantSourceNode
  private voices = new Set<Voice>()
  private held = new Map<number, Voice>()
  private lastFreq = 0
  private automated = false

  constructor(ctx: BaseAudioContext, params: SynthParams) {
    this.ctx = ctx
    this.p = { ...params }
    this.out = ctx.createGain()
    this.out.gain.value = dbToGain(params.gain)
    this.cutoffCV = ctx.createConstantSource()
    this.cutoffCV.offset.value = params.cutoff
    this.cutoffCV.start()
  }

  setParams(params: Instrument['params']) {
    const p = params as SynthParams
    this.p = { ...p }
    const t = this.ctx.currentTime
    this.out.gain.setTargetAtTime(dbToGain(p.gain), t, 0.02)
    if (!this.automated) this.cutoffCV.offset.setTargetAtTime(p.cutoff, t, 0.02)
    for (const v of this.voices) v.filter.Q.setTargetAtTime(p.resonance, t, 0.02)
  }

  setCutoffAt(time: number, norm: number, ramp: boolean) {
    this.automated = true
    const hz = fromNorm(norm, CUTOFF_RANGE.min, CUTOFF_RANGE.max, 'log')
    if (ramp) this.cutoffCV.offset.linearRampToValueAtTime(hz, time)
    else this.cutoffCV.offset.setValueAtTime(hz, time)
  }

  releaseCutoff() {
    this.automated = false
    const t = this.ctx.currentTime
    this.cutoffCV.offset.cancelScheduledValues(t)
    this.cutoffCV.offset.setValueAtTime(this.p.cutoff, t)
  }

  noteOn(pitch: number, vel: number, time: number, dur?: number) {
    const { ctx, p } = this
    // steal only among voices actually sounding at `time` (offline renders schedule every note up front)
    const sounding = [...this.voices].filter((v) => v.start <= time && v.end > time)
    if (sounding.length >= 24) sounding.sort((a, b) => a.start - b.start)[0].kill(time)
    const f = midiToFreq(pitch)
    const amp = ctx.createGain()
    amp.gain.value = 0
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 0
    filter.Q.value = p.resonance
    this.cutoffCV.connect(filter.frequency)
    const env = ctx.createConstantSource()
    env.offset.value = 0
    env.connect(filter.frequency)
    const mix = [1 - p.oscMix, p.oscMix]
    const oscs = [p.osc1, p.osc2].map((w, i) => {
      const o = ctx.createOscillator()
      o.type = w
      const target = i === 0 ? f : f * Math.pow(2, p.osc2Semi / 12)
      if (p.glide > 0 && this.lastFreq) {
        const from = i === 0 ? this.lastFreq : this.lastFreq * Math.pow(2, p.osc2Semi / 12)
        o.frequency.setValueAtTime(from, time)
        o.frequency.exponentialRampToValueAtTime(target, time + p.glide)
      } else o.frequency.value = target
      if (i === 1) o.detune.value = p.osc2Detune
      const g = ctx.createGain()
      g.gain.value = mix[i] * 0.5
      o.connect(g).connect(filter)
      o.start(time)
      return o
    })
    this.lastFreq = f
    filter.connect(amp).connect(this.out)
    const v = vel
    const a = Math.max(0.001, p.attack)
    const d = Math.max(0.01, p.decay)
    amp.gain.setValueAtTime(0, time)
    amp.gain.linearRampToValueAtTime(v, time + a)
    amp.gain.setTargetAtTime(p.sustain * v, time + a, d / 3)
    env.offset.setValueAtTime(0, time)
    env.offset.linearRampToValueAtTime(p.envAmount * (0.4 + 0.6 * v), time + a)
    env.offset.setTargetAtTime(p.envAmount * p.sustain * 0.5, time + a, d / 3)
    env.start(time)
    const envAt = (dt: number, peak: number, sus: number) => (dt < a ? (peak * dt) / a : sus + (peak - sus) * Math.exp(-(dt - a) / (d / 3)))

    const voice: Voice = {
      pitch, start: time, oscs, amp, filter, env, vel, end: Infinity, released: false,
      release: (tr: number) => {
        if (voice.released) return
        voice.released = true
        const rel = Math.max(0.01, p.release)
        const dt = Math.max(0, tr - time)
        amp.gain.cancelScheduledValues(tr)
        amp.gain.setValueAtTime(envAt(dt, v, p.sustain * v), tr)
        amp.gain.setTargetAtTime(0, tr, rel / 4)
        env.offset.cancelScheduledValues(tr)
        env.offset.setValueAtTime(envAt(dt, p.envAmount * (0.4 + 0.6 * v), p.envAmount * p.sustain * 0.5), tr)
        env.offset.setTargetAtTime(0, tr, rel / 4)
        const end = tr + rel * 1.6 + 0.05
        voice.end = end
        oscs.forEach((o) => o.stop(end))
        env.stop(end)
        oscs[0].onended = () => {
          this.voices.delete(voice)
          try { this.cutoffCV.disconnect(filter.frequency) } catch { /* already gone */ }
          amp.disconnect()
        }
      },
      kill: (at?: number) => {
        const t = Math.max(at ?? 0, ctx.currentTime)
        voice.end = t + 0.05
        amp.gain.cancelScheduledValues(t)
        amp.gain.setTargetAtTime(0, t, 0.008)
        voice.released = true
        try {
          oscs.forEach((o) => o.stop(t + 0.05))
          env.stop(t + 0.05)
        } catch { /* not started yet */ }
        if (at === undefined) this.voices.delete(voice)
      },
    }
    this.voices.add(voice)
    if (dur !== undefined) voice.release(time + dur)
    else {
      this.held.get(pitch)?.release(time)
      this.held.set(pitch, voice)
    }
  }

  noteOff(pitch: number, time: number) {
    const v = this.held.get(pitch)
    if (v) {
      v.release(Math.max(time, this.ctx.currentTime))
      this.held.delete(pitch)
    }
  }

  allOff() {
    for (const v of this.voices) v.kill()
    this.voices.clear()
    this.held.clear()
  }

  dispose() {
    this.allOff()
    this.cutoffCV.stop()
    this.out.disconnect()
  }
}

// ───────────────────────── Synthesized drum kit ─────────────────────────
const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>()
function noise(ctx: BaseAudioContext) {
  let b = noiseCache.get(ctx)
  if (!b) {
    b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
    const d = b.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
    noiseCache.set(ctx, b)
  }
  return b
}

export class DrumKit implements InstrumentNode {
  out: GainNode
  private ctx: BaseAudioContext
  private p: DrumParams
  private live = new Set<AudioScheduledSourceNode>()
  private openHat: { g: GainNode; t: number } | null = null

  constructor(ctx: BaseAudioContext, params: DrumParams) {
    this.ctx = ctx
    this.p = { ...params, levels: [...params.levels] }
    this.out = ctx.createGain()
  }

  setParams(params: Instrument['params']) {
    const p = params as DrumParams
    this.p = { ...p, levels: [...p.levels] }
  }

  private track(src: AudioScheduledSourceNode, t: number, stop: number) {
    src.start(t)
    src.stop(stop)
    this.live.add(src)
    src.onended = () => this.live.delete(src)
  }

  private env(t: number, peak: number, decay: number) {
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(peak, t + 0.0015)
    g.gain.exponentialRampToValueAtTime(0.0008, t + decay)
    g.connect(this.out)
    return g
  }

  private noiseSrc(t: number, dur: number, filterType: BiquadFilterType, freq: number, q: number, dest: AudioNode) {
    const s = this.ctx.createBufferSource()
    s.buffer = noise(this.ctx)
    const f = this.ctx.createBiquadFilter()
    f.type = filterType
    f.frequency.value = freq
    f.Q.value = q
    s.connect(f).connect(dest)
    this.track(s, t, t + dur)
  }

  noteOn(pitch: number, vel: number, time: number) {
    const idx = DRUM_VOICES.findIndex((v) => v.pitch === pitch)
    if (idx < 0) return
    const { ctx, p } = this
    const lvl = dbToGain(p.levels[idx] ?? 0) * (0.25 + 0.75 * vel)
    const tune = Math.pow(2, p.tune / 12)
    const dk = p.decay
    const bright = 0.5 + p.tone
    const t = time
    const osc = (type: OscillatorType, f0: number, f1: number, sweep: number, dest: AudioNode, dur: number) => {
      const o = ctx.createOscillator()
      o.type = type
      o.frequency.setValueAtTime(f0, t)
      o.frequency.exponentialRampToValueAtTime(f1, t + sweep)
      o.connect(dest)
      this.track(o, t, t + dur)
    }
    switch (idx) {
      case 0: { // kick
        const dec = 0.42 * dk
        const g = this.env(t, lvl * 1.1, dec)
        osc('sine', 160 * tune, 44 * tune, 0.07, g, dec + 0.05)
        const click = this.env(t, lvl * 0.35 * bright, 0.012)
        this.noiseSrc(t, 0.02, 'highpass', 2500, 0.7, click)
        break
      }
      case 1: { // snare
        const dec = 0.2 * dk
        const body = this.env(t, lvl * 0.55, dec * 0.7)
        osc('triangle', 240 * tune, 180 * tune, 0.04, body, dec)
        const n = this.env(t, lvl * 0.7, dec)
        this.noiseSrc(t, dec + 0.05, 'highpass', 1400 * bright, 0.6, n)
        break
      }
      case 2: { // clap: three quick bursts then a tail
        const g = ctx.createGain()
        g.gain.setValueAtTime(0, t)
        ;[0, 0.011, 0.023].forEach((o) => {
          g.gain.setValueAtTime(lvl * 0.9, t + o)
          g.gain.exponentialRampToValueAtTime(0.05 * lvl + 0.0005, t + o + 0.009)
        })
        g.gain.setValueAtTime(lvl * 0.7, t + 0.034)
        g.gain.exponentialRampToValueAtTime(0.0008, t + 0.034 + 0.22 * dk)
        g.connect(this.out)
        this.noiseSrc(t, 0.3 * dk + 0.05, 'bandpass', 1150 * bright, 1.6, g)
        break
      }
      case 3: { // closed hat, chokes the open hat
        if (this.openHat && this.openHat.t < t) {
          this.openHat.g.gain.cancelScheduledValues(t)
          this.openHat.g.gain.setTargetAtTime(0, t, 0.005)
        }
        const g = this.env(t, lvl * 0.45, 0.05 * dk)
        this.noiseSrc(t, 0.08 * dk, 'highpass', 6500 * bright, 0.8, g)
        break
      }
      case 4: { // open hat
        const g = this.env(t, lvl * 0.4, 0.38 * dk)
        this.noiseSrc(t, 0.4 * dk, 'highpass', 6000 * bright, 0.8, g)
        this.openHat = { g, t }
        break
      }
      case 5:
      case 6: { // toms
        const base = (idx === 5 ? 110 : 165) * tune
        const g = this.env(t, lvl * 0.8, 0.32 * dk)
        osc('sine', base * 1.6, base, 0.09, g, 0.35 * dk)
        break
      }
      case 7: { // rim
        const g = this.env(t, lvl * 0.5, 0.03)
        osc('triangle', 1700 * tune, 1600 * tune, 0.02, g, 0.04)
        this.noiseSrc(t, 0.02, 'bandpass', 3000, 2, g)
        break
      }
    }
  }

  noteOff() { /* one-shots */ }

  allOff() {
    const t = this.ctx.currentTime
    for (const s of this.live) {
      try { s.stop(t) } catch { /* ok */ }
    }
    this.live.clear()
  }

  dispose() {
    this.allOff()
    this.out.disconnect()
  }
}

export function createInstrument(ctx: BaseAudioContext, inst: Instrument): InstrumentNode {
  return inst.type === 'synth' ? new Synth(ctx, inst.params) : new DrumKit(ctx, inst.params)
}
