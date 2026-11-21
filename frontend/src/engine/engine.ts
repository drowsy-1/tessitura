import type { AudioClip, AutoParam, AutomationLane, Clip, Device, MidiClip, Project, Track } from '../state/types'
import { createDevice, type DeviceNode } from './devices'
import { createInstrument, type InstrumentNode } from './instruments'
import { buffers } from './assets'
import { clamp, dbToFader, dbToGain, faderToDb, kWeightCoeffs } from './dsp'
import { loadLimiter } from './limiter'
import { ensureStretched, stretchedNow } from './stretch'
import { isWarped, pitchRatio, stretchFactor } from '../state/clip'

const LOOKAHEAD = 0.12
const TICK_MS = 25

// ───────────────────────── Track graph ─────────────────────────
// input → [devices] → fader → pan → mute ─┬→ destination (master / return)
//                                        ├→ send A / send B (post-fader)
//                                        └→ meters
class TrackGraph {
  readonly id: string
  input: GainNode
  fader: GainNode
  panner: StereoPannerNode
  mute: GainNode
  sends: GainNode[] = []
  meters: AnalyserNode[]
  devices: DeviceNode[] = []
  instrument?: InstrumentNode
  private devSig = ''
  private instSig = ''
  private ctx: BaseAudioContext

  constructor(ctx: BaseAudioContext, id: string, dest: AudioNode, sendDests: AudioNode[]) {
    this.ctx = ctx
    this.id = id
    this.input = ctx.createGain()
    this.fader = ctx.createGain()
    this.panner = ctx.createStereoPanner()
    this.mute = ctx.createGain()
    this.input.connect(this.fader)
    this.fader.connect(this.panner).connect(this.mute).connect(dest)
    for (const d of sendDests) {
      const g = ctx.createGain()
      g.gain.value = 0
      this.mute.connect(g).connect(d)
      this.sends.push(g)
    }
    const split = ctx.createChannelSplitter(2)
    this.mute.connect(split)
    this.meters = [0, 1].map((ch) => {
      const a = ctx.createAnalyser()
      a.fftSize = 1024
      split.connect(a, ch)
      return a
    })
  }

  sync(t: Track, bpm: number, audible: boolean, automated: Set<AutoParam>) {
    const now = this.ctx.currentTime
    // instrument
    const instSig = t.instrument ? t.instrument.type : ''
    if (instSig !== this.instSig) {
      this.instrument?.dispose()
      this.instrument = t.instrument ? createInstrument(this.ctx, t.instrument) : undefined
      this.instrument?.out.connect(this.input)
      this.instSig = instSig
    } else if (t.instrument && this.instrument) this.instrument.setParams(t.instrument.params)
    // device chain (rebuilt only when order/type/bypass changes)
    this.syncDevices(t.devices, bpm)
    if (!automated.has('volume')) this.fader.gain.setTargetAtTime(dbToGain(t.volume), now, 0.015)
    if (!automated.has('pan')) this.panner.pan.setTargetAtTime(t.pan, now, 0.015)
    this.mute.gain.setTargetAtTime(audible ? 1 : 0, now, 0.01)
    const sendKeys: AutoParam[] = ['sendA', 'sendB']
    this.sends.forEach((g, i) => {
      if (!automated.has(sendKeys[i])) g.gain.setTargetAtTime(dbToGain(t.sends[i] ?? -60), now, 0.015)
    })
  }

  resetDevices() {
    this.devSig = ''
  }

  syncDevices(devs: Device[], bpm: number) {
    const sig = devs.map((d) => `${d.id}:${d.on}`).join('|')
    if (sig !== this.devSig) {
      this.input.disconnect()
      this.devices.forEach((d) => d.dispose())
      this.devices = devs.filter((d) => d.on).map((d) => createDevice(this.ctx, d, bpm))
      let node: AudioNode = this.input
      for (const d of this.devices) {
        node.connect(d.input)
        node = d.output
      }
      node.connect(this.fader)
      this.devSig = sig
    } else {
      for (const d of devs) this.devices.find((n) => n.id === d.id)?.update(d.params, bpm)
    }
  }

  dispose() {
    this.instrument?.dispose()
    this.devices.forEach((d) => d.dispose())
    ;[this.input, this.fader, this.panner, this.mute, ...this.sends].forEach((n) => n.disconnect())
  }
}

// ───────────────────────── Launcher state ─────────────────────────
export interface LaunchEntry {
  trackId: string
  slot: number
  start: number // beat
  end: number // beat (Infinity while open)
}

export interface EngineSnapshot {
  playing: boolean
  recording: boolean
  launches: LaunchEntry[]
  detached: string[] // tracks not following the arrangement
  historyCount: number
}

type Listener = () => void

// ───────────────────────── Engine ─────────────────────────
export class Engine {
  readonly ctx: BaseAudioContext
  readonly realtime: boolean
  project!: Project
  private graphs = new Map<string, TrackGraph>()
  private returns = new Map<string, TrackGraph>()
  masterIn: GainNode
  private masterDevices: DeviceNode[] = []
  private masterDevSig = ''
  masterFader: GainNode
  masterMeters: AnalyserNode[]
  private lufsTaps: AnalyserNode[] = []

  // transport
  playing = false
  recording = false
  private anchors: { time: number; beat: number }[] = []
  private cursorBeat = 0
  private cursorTime = 0
  private fresh = true
  private timer: { stop(): void } | null = null
  private sources = new Set<AudioScheduledSourceNode>()
  playhead = 0 // beat when stopped
  private startedFrom = 0

  // launcher
  launches: LaunchEntry[] = []
  history: LaunchEntry[] = []
  detached = new Set<string>()

  // recording
  private recorder: MediaRecorder | null = null
  private recChunks: Blob[] = []
  private recStartBeat = 0
  private midiRec: { pitch: number; vel: number; start: number; dur: number }[] = []
  private midiHeld = new Map<number, { pitch: number; vel: number; start: number; dur: number }>()
  onRecorded?: (r: { kind: 'audio'; blob: Blob; startBeat: number; latency: number } | { kind: 'midi'; notes: { pitch: number; vel: number; start: number; dur: number }[]; startBeat: number; endBeat: number }) => void

  // loudness
  private lufsBlocks: number[] = []
  private lufsHistory: number[] = []
  private lufsTimer: ReturnType<typeof setInterval> | null = null
  loudness = { momentary: -Infinity, shortTerm: -Infinity, integrated: -Infinity, peakHold: -Infinity }

  private listeners = new Set<Listener>()
  private snap: EngineSnapshot = { playing: false, recording: false, launches: [], detached: [], historyCount: 0 }

  constructor(ctx: BaseAudioContext, realtime: boolean) {
    this.ctx = ctx
    this.realtime = realtime
    this.masterIn = ctx.createGain()
    this.masterFader = ctx.createGain()
    this.masterIn.connect(this.masterFader)
    this.masterFader.connect(ctx.destination)
    const split = ctx.createChannelSplitter(2)
    this.masterFader.connect(split)
    this.masterMeters = [0, 1].map((ch) => {
      const a = ctx.createAnalyser()
      a.fftSize = 2048
      split.connect(a, ch)
      return a
    })
    if (realtime) this.setupLoudness(split)
  }

  // ── subscription for React ──
  subscribe = (fn: Listener) => {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }
  getSnapshot = () => this.snap
  private emit() {
    this.snap = { playing: this.playing, recording: this.recording, launches: this.launches.map((l) => ({ ...l })), detached: [...this.detached], historyCount: this.history.length }
    this.listeners.forEach((l) => l())
  }

  get spb() {
    return 60 / this.project.bpm
  }

  // ───────────────── Sync with project ─────────────────
  sync(p: Project) {
    const bpmChanged = this.project && this.project.bpm !== p.bpm
    const prev = this.project
    this.project = p
    // returns first (tracks send into them)
    const seenR = new Set<string>()
    for (const r of p.returns) {
      seenR.add(r.id)
      let g = this.returns.get(r.id)
      if (!g) {
        g = new TrackGraph(this.ctx, r.id, this.masterIn, [])
        this.returns.set(r.id, g)
      }
      g.sync(r, p.bpm, !r.mute, new Set())
    }
    for (const [id, g] of this.returns) if (!seenR.has(id)) { g.dispose(); this.returns.delete(id) }
    const retInputs = p.returns.map((r) => this.returns.get(r.id)!.input)

    const anySolo = p.tracks.some((t) => t.solo)
    const seen = new Set<string>()
    for (const t of p.tracks) {
      seen.add(t.id)
      let g = this.graphs.get(t.id)
      if (!g) {
        g = new TrackGraph(this.ctx, t.id, this.masterIn, retInputs)
        this.graphs.set(t.id, g)
      }
      const audible = !t.mute && (!anySolo || t.solo)
      g.sync(t, p.bpm, audible, this.playing ? this.automatedParams(t) : new Set())
    }
    for (const [id, g] of this.graphs) if (!seen.has(id)) { g.dispose(); this.graphs.delete(id) }

    // master
    const sig = p.master.devices.map((d) => `${d.id}:${d.on}`).join('|')
    if (sig !== this.masterDevSig) {
      this.masterIn.disconnect()
      this.masterDevices.forEach((d) => d.dispose())
      this.masterDevices = p.master.devices.filter((d) => d.on).map((d) => createDevice(this.ctx, d, p.bpm))
      let node: AudioNode = this.masterIn
      for (const d of this.masterDevices) { node.connect(d.input); node = d.output }
      node.connect(this.masterFader)
      this.masterDevSig = sig
    } else for (const d of p.master.devices) this.masterDevices.find((n) => n.id === d.id)?.update(d.params, p.bpm)
    this.masterFader.gain.setTargetAtTime(dbToGain(p.master.volume), this.ctx.currentTime, 0.015)

    const loopChanged = prev && (prev.loop.on !== p.loop.on || prev.loop.start !== p.loop.start || prev.loop.end !== p.loop.end)
    if (this.playing && prev && (bpmChanged || loopChanged)) this.relocate(this.position())
  }

  private automatedParams(t: Track) {
    return new Set(t.automation.filter((l) => l.points.length > 0).map((l) => l.param))
  }

  /** Rebuild every device chain (e.g. once the limiter worklet has loaded). */
  rebuildDevices() {
    for (const g of [...this.graphs.values(), ...this.returns.values()]) g.resetDevices()
    this.masterDevSig = ''
    this.sync(this.project)
  }

  graph(id: string) {
    return this.graphs.get(id) ?? this.returns.get(id)
  }

  deviceReduction(trackId: string | 'master', deviceId: string) {
    const list = trackId === 'master' ? this.masterDevices : this.graph(trackId)?.devices
    return list?.find((d) => d.id === deviceId)?.reduction?.() ?? 0
  }

  // ───────────────── Transport ─────────────────
  position() {
    if (!this.playing) return this.playhead
    const t = this.ctx.currentTime
    let a = this.anchors[0]
    for (const x of this.anchors) if (x.time <= t) a = x
    if (!a) return this.playhead
    return Math.max(0, a.beat + (t - a.time) / this.spb)
  }

  async play(from = this.playhead) {
    if (this.realtime) await (this.ctx as AudioContext).resume()
    if (this.playing) this.hardStop(false)
    this.playing = true
    this.startedFrom = from
    const t0 = this.ctx.currentTime + 0.05
    this.cursorBeat = from
    this.cursorTime = t0
    this.fresh = true
    this.anchors = [{ time: t0, beat: from }]
    this.launches = this.launches.filter((l) => l.end === Infinity && l.start <= from).map((l) => ({ ...l }))
    this.resetLoudness()
    this.sync(this.project)
    this.startTimer()
    this.emit()
  }

  stop() {
    if (!this.playing) {
      // second press returns to the start
      this.playhead = this.playhead === this.startedFrom ? 0 : this.startedFrom
      this.emit()
      return
    }
    this.playhead = this.position()
    this.hardStop(true)
    this.emit()
  }

  private hardStop(finishRec: boolean) {
    const pos = this.position()
    this.timer?.stop()
    this.timer = null
    this.playing = false
    for (const s of this.sources) { try { s.stop() } catch { /* ok */ } }
    this.sources.clear()
    for (const g of this.graphs.values()) {
      g.instrument?.allOff()
      g.instrument?.releaseCutoff?.()
      for (const p of [g.fader.gain, g.panner.pan, ...g.sends.map((s) => s.gain)]) p.cancelScheduledValues(this.ctx.currentTime)
    }
    // close launches at the stop point (history keeps them for "commit to arrangement");
    // tracks that were playing session clips stay detached until "Back to arrangement"
    for (const l of this.launches) {
      if (l.start <= pos) this.detached.add(l.trackId)
      if (l.end === Infinity) l.end = Math.max(l.start, pos)
    }
    this.history = this.history.filter((l) => l.end > l.start)
    this.launches = []
    this.sync(this.project)
    if (finishRec && this.recording) this.finishRecording(pos)
  }

  /** Jump while playing (loop edits, tempo changes, clicking the ruler). */
  relocate(beat: number) {
    if (!this.playing) {
      this.playhead = Math.max(0, beat)
      this.emit()
      return
    }
    this.timer?.stop()
    for (const s of this.sources) { try { s.stop() } catch { /* ok */ } }
    this.sources.clear()
    for (const g of this.graphs.values()) g.instrument?.allOff()
    const t0 = this.ctx.currentTime + 0.03
    this.cursorBeat = Math.max(0, beat)
    this.cursorTime = t0
    this.fresh = true
    this.anchors = [{ time: t0, beat: this.cursorBeat }]
    this.startTimer()
  }

  private startTimer() {
    const tick = () => this.tick()
    // A worker clock keeps scheduling alive when the tab is in the background.
    try {
      const src = `let id;onmessage=e=>{clearInterval(id);if(e.data>0)id=setInterval(()=>postMessage(0),e.data)}`
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })))
      w.onmessage = tick
      w.postMessage(TICK_MS)
      this.timer = { stop: () => { w.postMessage(0); w.terminate() } }
    } catch {
      const id = setInterval(tick, TICK_MS)
      this.timer = { stop: () => clearInterval(id) }
    }
    tick()
  }

  private tick() {
    if (!this.playing) return
    const ahead = this.ctx.currentTime + LOOKAHEAD
    let guard = 0
    while (this.cursorTime < ahead && guard++ < 8) {
      const spb = this.spb
      const from = this.cursorBeat
      let to = from + (ahead - this.cursorTime) / spb
      const loop = this.project.loop
      if (loop.on && loop.end > loop.start && from < loop.end && to >= loop.end) {
        to = loop.end
        this.scheduleRange(from, to, this.cursorTime, this.fresh, loop.end)
        this.cursorTime += (to - from) * spb
        this.cursorBeat = loop.start
        this.fresh = true
        this.anchors.push({ time: this.cursorTime, beat: loop.start })
        if (this.anchors.length > 16) this.anchors.splice(0, this.anchors.length - 16)
        continue
      }
      this.scheduleRange(from, to, this.cursorTime, this.fresh, loop.on && from < loop.end ? loop.end : Infinity)
      this.fresh = false
      this.cursorTime += (to - from) * spb
      this.cursorBeat = to
    }
  }

  /**
   * Schedule everything that starts in [from, to) beats. `t0` is the context time of `from`.
   * `fresh` means playback (re)starts at `from`, so already-sounding audio clips start mid-way.
   * `hardEnd` is a beat where audio must stop (the loop end).
   */
  scheduleRange(from: number, to: number, t0: number, fresh: boolean, hardEnd = Infinity) {
    const p = this.project
    const spb = this.spb
    const at = (b: number) => t0 + (b - from) * spb
    for (const track of p.tracks) {
      const g = this.graphs.get(track.id)
      if (!g) continue
      // launcher entries overlapping this window
      const entries = this.launches.filter((l) => l.trackId === track.id && l.start < to && l.end > from)
      const detachedAt = this.detachedFrom(track.id)
      for (const e of entries) {
        const clip = track.slots[e.slot]
        if (!clip || clip.length <= 0) continue
        const a = Math.max(from, e.start)
        const b = Math.min(to, e.end)
        const k0 = Math.floor((a - e.start) / clip.length)
        const k1 = Math.floor((b - e.start - 1e-9) / clip.length)
        for (let k = k0; k <= k1; k++) {
          const base = e.start + k * clip.length
          const stopAt = Math.min(e.end, base + clip.length, hardEnd)
          if (clip.kind === 'midi') this.scheduleNotes(g, clip, base, a, b, stopAt, at)
          else this.scheduleAudio(g, clip, base, a, b, stopAt, at, fresh && k === k0)
        }
      }
      // arrangement clips (only where the track still follows the arrangement)
      const arrEnd = Math.min(to, detachedAt)
      if (arrEnd > from) {
        for (const clip of track.clips) {
          if (clip.start >= arrEnd || clip.start + clip.length <= from) continue
          const stopAt = Math.min(clip.start + clip.length, hardEnd, detachedAt)
          if (clip.kind === 'midi') this.scheduleNotes(g, clip, clip.start, from, arrEnd, stopAt, at)
          else this.scheduleAudio(g, clip, clip.start, from, arrEnd, stopAt, at, fresh)
        }
      }
      this.scheduleAutomation(g, track, from, to, at, fresh)
    }
    if (this.realtime && this.metronome) this.scheduleClicks(from, to, at)
  }

  private detachedFrom(trackId: string) {
    let d = Infinity
    for (const l of this.launches) if (l.trackId === trackId) d = Math.min(d, l.start)
    return this.detached.has(trackId) ? -Infinity : d
  }

  private scheduleNotes(g: TrackGraph, clip: MidiClip, base: number, a: number, b: number, stopAt: number, at: (b: number) => number) {
    if (!g.instrument) return
    for (const n of clip.notes) {
      if (n.start >= clip.length || n.start < 0) continue
      const nb = base + n.start
      if (nb < a || nb >= b || nb >= stopAt) continue
      const dur = Math.max(0.01, Math.min(n.dur, stopAt - nb))
      g.instrument.noteOn(n.pitch, n.vel, Math.max(at(nb), this.ctx.currentTime), dur * this.spb)
    }
  }

  private scheduleAudio(g: TrackGraph, clip: AudioClip, base: number, a: number, b: number, stopAt: number, at: (b: number) => number, fresh: boolean) {
    const source = buffers.get(clip.assetId)
    if (!source) return
    let startBeat: number
    if (base >= a && base < b) startBeat = base
    else if (fresh && base < a && a < stopAt) startBeat = a
    else return
    if (startBeat >= stopAt) return
    const spb = this.spb
    const pitch = pitchRatio(clip)
    const elapsed = (startBeat - base) * spb // output seconds into the clip
    let buf = source
    let rate = pitch
    let offset = clip.offset + elapsed * pitch
    if (isWarped(clip)) {
      // warped: play a WSOLA-stretched copy at the pitch ratio, so tempo follows the project
      // and transpose keeps the tempo (see stretch.ts / clip.ts)
      const D = clip.warp!.bpm / this.project.bpm
      const stretched = stretchedNow(clip.assetId, D * pitch)
      if (stretched) {
        buf = stretched
        offset = (clip.offset * D + elapsed) * pitch
      } else {
        // not stretched yet: stay locked to the grid with varispeed until it is
        rate = 1 / D
        offset = clip.offset + elapsed / D
        void ensureStretched(clip.assetId, D * pitch)
      }
    }
    if (offset >= buf.duration) return
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = rate
    const env = this.ctx.createGain()
    const tStart = Math.max(at(startBeat), this.ctx.currentTime)
    const tEnd = at(stopAt)
    const level = dbToGain(clip.gain)
    // fades (in beats, relative to the clip's own timeline)
    const clipEnd = base + clip.length
    const fadeGain = (beat: number) => {
      let gg = 1
      if (clip.fadeIn > 0 && beat < base + clip.fadeIn) gg *= clamp((beat - base) / clip.fadeIn, 0, 1)
      if (clip.fadeOut > 0 && beat > clipEnd - clip.fadeOut) gg *= clamp((clipEnd - beat) / clip.fadeOut, 0, 1)
      return gg
    }
    env.gain.setValueAtTime(level * fadeGain(startBeat), tStart)
    if (clip.fadeIn > 0 && startBeat < base + clip.fadeIn) env.gain.linearRampToValueAtTime(level, at(base + clip.fadeIn))
    if (clip.fadeOut > 0) {
      const fo = Math.max(startBeat, clipEnd - clip.fadeOut)
      if (fo < stopAt) {
        env.gain.setValueAtTime(level * fadeGain(fo), at(fo))
        env.gain.linearRampToValueAtTime(level * fadeGain(stopAt), tEnd)
      }
    }
    // short declick at a hard stop
    env.gain.setValueAtTime(env.gain.value, Math.max(tStart, tEnd - 0.004))
    src.connect(env).connect(g.input)
    src.start(tStart, offset)
    src.stop(tEnd + 0.002)
    this.sources.add(src)
    src.onended = () => { this.sources.delete(src); env.disconnect() }
  }

  private scheduleAutomation(g: TrackGraph, track: Track, from: number, to: number, at: (b: number) => number, fresh: boolean) {
    for (const lane of track.automation) {
      if (!lane.points.length) continue
      const step = 0.125
      const beats: number[] = [from]
      for (let b = Math.ceil(from / step) * step; b < to; b += step) if (b > from) beats.push(b)
      for (const [i, b] of beats.entries()) {
        const v = evalLane(lane, b)
        const t = Math.max(at(b), this.ctx.currentTime)
        const ramp = !(fresh && i === 0)
        applyAuto(g, lane.param, v, t, ramp)
      }
    }
  }

  metronome = false
  private scheduleClicks(from: number, to: number, at: (b: number) => number) {
    const bpb = (this.project.timeSig[0] * 4) / this.project.timeSig[1]
    for (let b = Math.ceil(from - 1e-9); b < to; b++) {
      const t = at(b)
      if (t < this.ctx.currentTime) continue
      const o = this.ctx.createOscillator()
      const e = this.ctx.createGain()
      o.frequency.value = b % bpb === 0 ? 1760 : 1175
      e.gain.setValueAtTime(0.0001, t)
      e.gain.exponentialRampToValueAtTime(b % bpb === 0 ? 0.35 : 0.2, t + 0.002)
      e.gain.exponentialRampToValueAtTime(0.0001, t + 0.05)
      o.connect(e).connect(this.ctx.destination)
      o.start(t)
      o.stop(t + 0.06)
    }
  }

  // ───────────────── Clip launcher ─────────────────
  private quantizedBeat(q: number) {
    const pos = this.position()
    if (!q) return pos
    return Math.ceil((pos - 1e-6) / q) * q
  }

  async launch(trackId: string, slot: number, q: number) {
    if (!this.playing) {
      const bpb = (this.project.timeSig[0] * 4) / this.project.timeSig[1]
      const from = Math.floor(this.playhead / bpb) * bpb
      this.launches = this.launches.filter((l) => l.end !== Infinity || l.trackId !== trackId)
      this.addLaunch({ trackId, slot, start: from, end: Infinity })
      await this.play(from)
      return
    }
    const at = this.quantizedBeat(q)
    for (const l of this.launches) if (l.trackId === trackId && l.end === Infinity) l.end = Math.max(l.start, at)
    this.launches = this.launches.filter((l) => !(l.trackId === trackId && l.end <= l.start && l.start >= at))
    this.addLaunch({ trackId, slot, start: at, end: Infinity })
    this.emit()
  }

  private addLaunch(l: LaunchEntry) {
    this.launches.push(l)
    this.history.push(l) // same object: closing it later updates the history too
  }

  stopTrack(trackId: string, q: number) {
    const at = this.playing ? this.quantizedBeat(q) : this.playhead
    for (const l of this.launches) if (l.trackId === trackId && l.end === Infinity) l.end = Math.max(l.start, at)
    this.detached.add(trackId)
    this.emit()
  }

  launchScene(slot: number, q: number) {
    const tracks = this.project.tracks.filter((t) => t.slots[slot])
    if (!tracks.length) return
    if (!this.playing) {
      const bpb = (this.project.timeSig[0] * 4) / this.project.timeSig[1]
      const from = Math.floor(this.playhead / bpb) * bpb
      for (const t of this.project.tracks) {
        this.launches = this.launches.filter((l) => l.trackId !== t.id || l.end !== Infinity)
        if (t.slots[slot]) this.addLaunch({ trackId: t.id, slot, start: from, end: Infinity })
        else this.detached.add(t.id)
      }
      void this.play(from)
      return
    }
    for (const t of this.project.tracks) {
      if (t.slots[slot]) void this.launch(t.id, slot, q)
      else this.stopTrack(t.id, q)
    }
  }

  stopAllClips(q: number) {
    for (const t of this.project.tracks) this.stopTrack(t.id, q)
  }

  backToArrangement() {
    const pos = this.position()
    for (const l of this.launches) if (l.end === Infinity) l.end = Math.max(l.start, pos)
    this.history = this.history.filter((l) => l.end > l.start)
    this.launches = []
    this.detached.clear()
    if (this.playing) this.relocate(pos)
    this.emit()
  }

  /** Performance history from the launcher, for "commit to arrangement". */
  takeLaunchHistory() {
    const pos = this.position()
    return this.history.map((l) => ({ ...l, end: l.end === Infinity ? pos : l.end })).filter((l) => l.end > l.start)
  }

  clearLaunchHistory() {
    this.history = this.history.filter((l) => l.end === Infinity)
    this.emit()
  }

  // ───────────────── Live input & recording ─────────────────
  liveNoteOn(trackId: string, pitch: number, vel: number) {
    if (this.realtime) void (this.ctx as AudioContext).resume()
    const g = this.graphs.get(trackId)
    g?.instrument?.noteOn(pitch, vel, this.ctx.currentTime)
    if (this.recording && this.playing) {
      const n = { pitch, vel, start: this.position(), dur: 0.25 }
      this.midiHeld.set(pitch, n)
      this.midiRec.push(n)
    }
  }

  liveNoteOff(trackId: string, pitch: number) {
    this.graphs.get(trackId)?.instrument?.noteOff(pitch, this.ctx.currentTime)
    const n = this.midiHeld.get(pitch)
    if (n) {
      n.dur = Math.max(0.05, this.position() - n.start)
      this.midiHeld.delete(pitch)
    }
  }

  async record(audioTrack: boolean) {
    if (!this.realtime) return
    this.midiRec = []
    this.midiHeld.clear()
    if (audioTrack) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
      this.recorder = new MediaRecorder(stream)
      this.recChunks = []
      this.recorder.ondataavailable = (e) => this.recChunks.push(e.data)
      this.recorder.start()
    }
    this.recording = true
    this.recStartBeat = this.playhead
    await this.play(this.playhead)
  }

  private finishRecording(endBeat: number) {
    this.recording = false
    const start = this.recStartBeat
    if (this.recorder) {
      const rec = this.recorder
      this.recorder = null
      rec.onstop = () => {
        rec.stream.getTracks().forEach((t) => t.stop())
        const ac = this.ctx as AudioContext
        const latency = (ac.baseLatency ?? 0) + (ac.outputLatency ?? 0)
        this.onRecorded?.({ kind: 'audio', blob: new Blob(this.recChunks, { type: rec.mimeType }), startBeat: start, latency })
      }
      rec.stop()
    }
    if (this.midiRec.length) {
      for (const n of this.midiHeld.values()) n.dur = Math.max(0.05, endBeat - n.start)
      this.onRecorded?.({ kind: 'midi', notes: this.midiRec, startBeat: start, endBeat })
      this.midiRec = []
    }
  }

  // ───────────────── Metering ─────────────────
  private meterBuf = new Float32Array(2048)
  peak(an: AnalyserNode) {
    const buf = this.meterBuf.length === an.fftSize ? this.meterBuf : new Float32Array(an.fftSize)
    an.getFloatTimeDomainData(buf)
    let p = 0
    for (let i = 0; i < buf.length; i++) {
      const a = Math.abs(buf[i])
      if (a > p) p = a
    }
    return p
  }

  levels(trackId: string | 'master'): [number, number] {
    const m = trackId === 'master' ? this.masterMeters : this.graph(trackId)?.meters
    if (!m) return [0, 0]
    return [this.peak(m[0]), this.peak(m[1])]
  }

  private setupLoudness(split: ChannelSplitterNode) {
    const [s1, s2] = kWeightCoeffs(this.ctx.sampleRate)
    this.lufsTaps = [0, 1].map((ch) => {
      const f1 = this.ctx.createIIRFilter(s1.b, s1.a)
      const f2 = this.ctx.createIIRFilter(s2.b, s2.a)
      const an = this.ctx.createAnalyser()
      an.fftSize = 8192
      split.connect(f1, ch)
      f1.connect(f2).connect(an)
      return an
    })
    const block = Math.round(this.ctx.sampleRate * 0.1)
    const buf = new Float32Array(8192)
    this.lufsTimer = setInterval(() => {
      if (!this.playing) return
      let e = 0
      for (const an of this.lufsTaps) {
        an.getFloatTimeDomainData(buf)
        let s = 0
        for (let i = buf.length - block; i < buf.length; i++) s += buf[i] * buf[i]
        e += s / block
      }
      this.lufsBlocks.push(e)
      if (this.lufsBlocks.length > 30) this.lufsBlocks.shift()
      const L = (x: number) => -0.691 + 10 * Math.log10(Math.max(x, 1e-12))
      const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)
      const mom = mean(this.lufsBlocks.slice(-4))
      this.loudness.momentary = L(mom)
      this.loudness.shortTerm = this.lufsBlocks.length >= 30 ? L(mean(this.lufsBlocks)) : -Infinity
      if (this.lufsBlocks.length >= 4) this.lufsHistory.push(mom)
      const abs = this.lufsHistory.filter((x) => L(x) > -70)
      if (abs.length) {
        const rel = L(mean(abs)) - 10
        const gated = abs.filter((x) => L(x) > rel)
        this.loudness.integrated = gated.length ? L(mean(gated)) : -Infinity
      }
      const [l, r] = this.levels('master')
      const pk = 20 * Math.log10(Math.max(l, r, 1e-9))
      if (pk > this.loudness.peakHold) this.loudness.peakHold = pk
    }, 100)
  }

  resetLoudness() {
    this.lufsBlocks = []
    this.lufsHistory = []
    this.loudness = { momentary: -Infinity, shortTerm: -Infinity, integrated: -Infinity, peakHold: -Infinity }
  }

  dispose() {
    this.timer?.stop()
    if (this.lufsTimer) clearInterval(this.lufsTimer)
    for (const g of this.graphs.values()) g.dispose()
    for (const g of this.returns.values()) g.dispose()
  }
}

// ───────────────────────── Automation helpers ─────────────────────────
export function evalLane(lane: AutomationLane, beat: number) {
  const pts = lane.points
  if (!pts.length) return 0
  if (beat <= pts[0].beat) return pts[0].value
  for (let i = 1; i < pts.length; i++) {
    if (beat <= pts[i].beat) {
      const a = pts[i - 1], b = pts[i]
      const f = b.beat === a.beat ? 1 : (beat - a.beat) / (b.beat - a.beat)
      return a.value + (b.value - a.value) * f
    }
  }
  return pts[pts.length - 1].value
}

function applyAuto(g: TrackGraph, param: AutoParam, v: number, t: number, ramp: boolean) {
  const set = (p: AudioParam, val: number) => (ramp ? p.linearRampToValueAtTime(val, t) : p.setValueAtTime(val, t))
  switch (param) {
    case 'volume': set(g.fader.gain, dbToGain(faderToDb(v))); break
    case 'pan': set(g.panner.pan, v * 2 - 1); break
    case 'sendA': if (g.sends[0]) set(g.sends[0].gain, dbToGain(faderToDb(v))); break
    case 'sendB': if (g.sends[1]) set(g.sends[1].gain, dbToGain(faderToDb(v))); break
    case 'cutoff': g.instrument?.setCutoffAt?.(t, v, ramp); break
  }
}

/** Default normalized value for a new automation lane, taken from the track's static setting. */
export function laneDefault(track: Track, param: AutoParam) {
  switch (param) {
    case 'volume': return dbToFader(track.volume)
    case 'pan': return (track.pan + 1) / 2
    case 'sendA': return dbToFader(track.sends[0])
    case 'sendB': return dbToFader(track.sends[1])
    case 'cutoff': {
      const c = track.instrument?.type === 'synth' ? track.instrument.params.cutoff : 2000
      return Math.log(c / 40) / Math.log(16000 / 40)
    }
  }
}

// ───────────────────────── Offline rendering ─────────────────────────
export async function renderOffline(project: Project, opts: { from?: number; to: number; tail?: number; sampleRate?: number; onlyTrack?: string }) {
  const from = opts.from ?? 0
  const sr = opts.sampleRate ?? 48000
  const spb = 60 / project.bpm
  const dur = (opts.to - from) * spb + (opts.tail ?? 2)
  // every warped clip needs its stretched audio ready before an offline render
  await Promise.all(
    project.tracks.flatMap((t) => t.clips).filter((c): c is AudioClip => c.kind === 'audio' && isWarped(c))
      .map((c) => ensureStretched(c.assetId, stretchFactor(c, project.bpm))),
  )
  const ctx = new OfflineAudioContext(2, Math.ceil(dur * sr), sr)
  await loadLimiter(ctx)
  const p: Project = structuredClone(project)
  p.loop = { ...p.loop, on: false }
  if (opts.onlyTrack) for (const t of p.tracks) { t.solo = t.id === opts.onlyTrack; t.mute = t.id !== opts.onlyTrack && t.mute }
  const eng = new Engine(ctx, false)
  eng.sync(p)
  eng.playing = true
  eng.scheduleRange(from, opts.to, 0, true)
  const out = await ctx.startRendering()
  eng.dispose()
  return out
}

export function clipEnd(c: Clip) {
  return c.start + c.length
}
