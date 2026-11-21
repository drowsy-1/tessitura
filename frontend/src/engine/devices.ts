import type { Device } from '../state/types'
import { dbToGain, makeImpulse } from './dsp'
import { limiterReady } from './limiter'

export interface DeviceNode {
  id: string
  type: Device['type']
  input: AudioNode
  output: AudioNode
  update(p: Record<string, number>, bpm: number): void
  reduction?(): number
  dispose(): void
}

function wetDry(ctx: BaseAudioContext) {
  const input = ctx.createGain()
  const output = ctx.createGain()
  const dry = ctx.createGain()
  const wet = ctx.createGain()
  input.connect(dry).connect(output)
  wet.connect(output)
  const set = (mix01: number) => {
    const t = ctx.currentTime
    // equal-power crossfade
    dry.gain.setTargetAtTime(Math.cos((mix01 * Math.PI) / 2), t, 0.02)
    wet.gain.setTargetAtTime(Math.sin((mix01 * Math.PI) / 2), t, 0.02)
  }
  return { input, output, wet, set }
}

const smooth = (param: AudioParam, v: number, ctx: BaseAudioContext) => param.setTargetAtTime(v, ctx.currentTime, 0.015)

export function createDevice(ctx: BaseAudioContext, d: Device, bpm: number): DeviceNode {
  switch (d.type) {
    case 'eq': {
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.Q.value = -3
      const lo = ctx.createBiquadFilter(); lo.type = 'lowshelf'
      const mid = ctx.createBiquadFilter(); mid.type = 'peaking'
      const hi = ctx.createBiquadFilter(); hi.type = 'highshelf'
      hp.connect(lo).connect(mid).connect(hi)
      const node: DeviceNode = {
        id: d.id, type: d.type, input: hp, output: hi,
        update(p) {
          smooth(hp.frequency, p.hpf, ctx)
          smooth(lo.frequency, p.lowFreq, ctx); smooth(lo.gain, p.lowGain, ctx)
          smooth(mid.frequency, p.midFreq, ctx); smooth(mid.gain, p.midGain, ctx); smooth(mid.Q, p.midQ, ctx)
          smooth(hi.frequency, p.highFreq, ctx); smooth(hi.gain, p.highGain, ctx)
        },
        dispose() { [hp, lo, mid, hi].forEach((n) => n.disconnect()) },
      }
      node.update(d.params, bpm)
      return node
    }
    case 'comp': {
      const c = ctx.createDynamicsCompressor()
      const makeup = ctx.createGain()
      c.connect(makeup)
      const node: DeviceNode = {
        id: d.id, type: d.type, input: c, output: makeup,
        update(p) {
          smooth(c.threshold, p.threshold, ctx); smooth(c.ratio, p.ratio, ctx); smooth(c.knee, p.knee, ctx)
          smooth(c.attack, p.attack / 1000, ctx); smooth(c.release, p.release / 1000, ctx)
          smooth(makeup.gain, dbToGain(p.makeup), ctx)
        },
        reduction: () => c.reduction,
        dispose() { c.disconnect(); makeup.disconnect() },
      }
      node.update(d.params, bpm)
      return node
    }
    case 'filter': {
      const f = ctx.createBiquadFilter()
      const node: DeviceNode = {
        id: d.id, type: d.type, input: f, output: f,
        update(p) {
          f.type = (['lowpass', 'highpass', 'bandpass'] as const)[Math.round(p.mode)] ?? 'lowpass'
          smooth(f.frequency, p.cutoff, ctx)
          // lowpass/highpass Q is in dB in Web Audio; map the linear resonance to dB
          smooth(f.Q, f.type === 'bandpass' ? p.res : 20 * Math.log10(p.res), ctx)
        },
        dispose() { f.disconnect() },
      }
      node.update(d.params, bpm)
      return node
    }
    case 'sat': {
      const wd = wetDry(ctx)
      const pre = ctx.createGain()
      const shaper = ctx.createWaveShaper()
      const post = ctx.createGain()
      const curve = new Float32Array(2048)
      // tanh(3x) over the shaper's ±1 input range: soft knee, flat (not hard) at the edges
      for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(3 * ((i / (curve.length - 1)) * 2 - 1)) / Math.tanh(3)
      shaper.curve = curve
      shaper.oversample = '4x'
      wd.input.connect(pre).connect(shaper).connect(wd.wet)
      wd.output.connect(post)
      const node: DeviceNode = {
        id: d.id, type: d.type, input: wd.input, output: post,
        update(p) {
          smooth(pre.gain, dbToGain(p.drive) / 3, ctx) // ÷3 keeps small-signal gain at unity
          wd.set(p.mix / 100)
          smooth(post.gain, dbToGain(p.output), ctx)
        },
        dispose() { [wd.input, wd.output, pre, shaper, post].forEach((n) => n.disconnect()) },
      }
      node.update(d.params, bpm)
      return node
    }
    case 'delay': {
      const wd = wetDry(ctx)
      const dl = ctx.createDelay(4)
      const fb = ctx.createGain()
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'
      wd.input.connect(dl)
      dl.connect(lp).connect(fb).connect(dl)
      lp.connect(wd.wet)
      const node: DeviceNode = {
        id: d.id, type: d.type, input: wd.input, output: wd.output,
        update(p, tempo) {
          smooth(dl.delayTime, Math.min(4, (p.division * 60) / tempo), ctx)
          smooth(fb.gain, p.feedback / 100, ctx)
          smooth(lp.frequency, p.damp, ctx)
          wd.set(p.mix / 100)
        },
        dispose() { [wd.input, wd.output, dl, fb, lp].forEach((n) => n.disconnect()) },
      }
      node.update(d.params, bpm)
      return node
    }
    case 'limiter': {
      if (limiterReady(ctx)) {
        // look-ahead true-peak limiter worklet (see limiter.ts)
        const w = new AudioWorkletNode(ctx, 'tessitura-limiter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] })
        let gr = 0
        w.port.onmessage = (e: MessageEvent<number>) => { gr = e.data }
        const P = (n: string) => w.parameters.get(n)!
        const node: DeviceNode = {
          id: d.id, type: d.type, input: w, output: w,
          update(p) {
            P('ceiling').setValueAtTime(p.ceiling, ctx.currentTime)
            P('gain').setValueAtTime(p.gain, ctx.currentTime)
            P('release').setValueAtTime(p.release, ctx.currentTime)
          },
          reduction: () => gr,
          dispose() { w.port.onmessage = null; w.disconnect() },
        }
        node.update(d.params, bpm)
        return node
      }
      // fallback where worklets are unavailable: compressor as a fast limiter (it has ~6 ms of built-in look-ahead), then a hard ceiling
      const pre = ctx.createGain()
      const c = ctx.createDynamicsCompressor()
      c.knee.value = 0
      c.ratio.value = 20
      c.attack.value = 0.001
      const down = ctx.createGain()
      const clip = ctx.createWaveShaper()
      clip.curve = new Float32Array([-1, 1]) // linear inside ±1, clamps outside
      // no oversampling here on purpose: the resampling filters would ring past the ceiling
      const up = ctx.createGain()
      pre.connect(c).connect(down).connect(clip).connect(up)
      const node: DeviceNode = {
        id: d.id, type: d.type, input: pre, output: up,
        update(p) {
          const ceil = dbToGain(p.ceiling)
          smooth(pre.gain, dbToGain(p.gain), ctx)
          smooth(c.threshold, p.ceiling - 2, ctx) // compressor does the work; the clipper only catches what slips past
          smooth(c.release, p.release / 1000, ctx)
          down.gain.setValueAtTime(1 / ceil, ctx.currentTime)
          up.gain.setValueAtTime(ceil, ctx.currentTime)
        },
        reduction: () => c.reduction,
        dispose() { [pre, c, down, clip, up].forEach((n) => n.disconnect()) },
      }
      node.update(d.params, bpm)
      return node
    }
    case 'reverb': {
      const wd = wetDry(ctx)
      const conv = ctx.createConvolver()
      wd.input.connect(conv).connect(wd.wet)
      let key = ''
      let timer: ReturnType<typeof setTimeout> | undefined
      const node: DeviceNode = {
        id: d.id, type: d.type, input: wd.input, output: wd.output,
        update(p) {
          wd.set(p.mix / 100)
          const k = `${p.decay.toFixed(2)}|${Math.round(p.damp)}|${Math.round(p.predelay)}`
          if (k === key) return
          key = k
          clearTimeout(timer)
          const build = () => { conv.buffer = makeImpulse(ctx, p.decay, p.damp, p.predelay) }
          // regenerate the impulse lazily while dragging, immediately on first build
          if (!conv.buffer) build()
          else timer = setTimeout(build, 120)
        },
        dispose() { clearTimeout(timer); [wd.input, wd.output, conv].forEach((n) => n.disconnect()) },
      }
      node.update(d.params, bpm)
      return node
    }
  }
}
