import { nanoid } from 'nanoid'
import type { Clip, Device, DeviceType, DrumParams, MidiClip, Note, Project, SynthParams, Track } from './types'

export const uid = () => nanoid(10)

export const TRACK_COLORS = ['#E9A23B', '#E57A5B', '#D9677F', '#9C84E0', '#5E9BE6', '#4FC0CC', '#6DBE7A', '#B8B45A']

// ───────────────────────── Device parameter specs ─────────────────────────
export interface ParamSpec {
  key: string
  label: string
  min: number
  max: number
  def: number
  unit?: string
  curve?: 'lin' | 'log'
  step?: number
  help?: string
}

export const DEVICE_SPECS: Record<DeviceType, { label: string; blurb: string; params: ParamSpec[] }> = {
  eq: {
    label: 'EQ Four',
    blurb: 'High-pass, low shelf, bell, high shelf. Drag the nodes on the curve.',
    params: [
      { key: 'hpf', label: 'High-pass', min: 20, max: 1000, def: 20, unit: 'Hz', curve: 'log' },
      { key: 'lowFreq', label: 'Low freq', min: 40, max: 600, def: 120, unit: 'Hz', curve: 'log' },
      { key: 'lowGain', label: 'Low gain', min: -18, max: 18, def: 0, unit: 'dB', step: 0.1 },
      { key: 'midFreq', label: 'Mid freq', min: 150, max: 8000, def: 1000, unit: 'Hz', curve: 'log' },
      { key: 'midGain', label: 'Mid gain', min: -18, max: 18, def: 0, unit: 'dB', step: 0.1 },
      { key: 'midQ', label: 'Mid Q', min: 0.2, max: 10, def: 1, curve: 'log', step: 0.01 },
      { key: 'highFreq', label: 'High freq', min: 1500, max: 18000, def: 8000, unit: 'Hz', curve: 'log' },
      { key: 'highGain', label: 'High gain', min: -18, max: 18, def: 0, unit: 'dB', step: 0.1 },
    ],
  },
  comp: {
    label: 'Compressor',
    blurb: 'Feed-forward compressor with make-up gain and a live gain-reduction meter.',
    params: [
      { key: 'threshold', label: 'Threshold', min: -60, max: 0, def: -18, unit: 'dB', step: 0.1 },
      { key: 'ratio', label: 'Ratio', min: 1, max: 20, def: 4, unit: ':1', curve: 'log', step: 0.1 },
      { key: 'attack', label: 'Attack', min: 0.1, max: 200, def: 10, unit: 'ms', curve: 'log', step: 0.1 },
      { key: 'release', label: 'Release', min: 10, max: 1000, def: 150, unit: 'ms', curve: 'log' },
      { key: 'knee', label: 'Knee', min: 0, max: 30, def: 6, unit: 'dB', step: 0.1 },
      { key: 'makeup', label: 'Make-up', min: 0, max: 24, def: 0, unit: 'dB', step: 0.1 },
    ],
  },
  filter: {
    label: 'Filter',
    blurb: 'Resonant filter. Drag the XY pad: X is cutoff, Y is resonance.',
    params: [
      { key: 'mode', label: 'Mode', min: 0, max: 2, def: 0, step: 1, help: '0 low-pass · 1 high-pass · 2 band-pass' },
      { key: 'cutoff', label: 'Cutoff', min: 30, max: 18000, def: 2400, unit: 'Hz', curve: 'log' },
      { key: 'res', label: 'Resonance', min: 0.1, max: 18, def: 1.2, curve: 'log', step: 0.01 },
    ],
  },
  sat: {
    label: 'Saturator',
    blurb: 'Soft-clip saturation (tanh) with dry/wet blend.',
    params: [
      { key: 'drive', label: 'Drive', min: 0, max: 36, def: 8, unit: 'dB', step: 0.1 },
      { key: 'mix', label: 'Mix', min: 0, max: 100, def: 100, unit: '%' },
      { key: 'output', label: 'Output', min: -24, max: 6, def: -4, unit: 'dB', step: 0.1 },
    ],
  },
  delay: {
    label: 'Echo',
    blurb: 'Tempo-synced delay with a damped feedback path.',
    params: [
      { key: 'division', label: 'Time', min: 0.125, max: 2, def: 0.75, unit: 'beat', step: 0.125 },
      { key: 'feedback', label: 'Feedback', min: 0, max: 95, def: 38, unit: '%' },
      { key: 'damp', label: 'Damping', min: 800, max: 16000, def: 5000, unit: 'Hz', curve: 'log' },
      { key: 'mix', label: 'Mix', min: 0, max: 100, def: 30, unit: '%' },
    ],
  },
  limiter: {
    label: 'Limiter',
    blurb: 'Look-ahead true-peak limiter (5 ms). Put it last on the master for streaming-safe peaks.',
    params: [
      { key: 'gain', label: 'Input gain', min: 0, max: 18, def: 0, unit: 'dB', step: 0.1 },
      { key: 'ceiling', label: 'Ceiling', min: -6, max: 0, def: -1, unit: 'dB', step: 0.1, help: 'True-peak ceiling (dBTP). −1 dBTP is the streaming recommendation' },
      { key: 'release', label: 'Release', min: 10, max: 500, def: 80, unit: 'ms', curve: 'log' },
    ],
  },
  reverb: {
    label: 'Space',
    blurb: 'Convolution reverb with a generated impulse response.',
    params: [
      { key: 'decay', label: 'Decay', min: 0.3, max: 8, def: 2.4, unit: 's', curve: 'log', step: 0.01 },
      { key: 'predelay', label: 'Pre-delay', min: 0, max: 120, def: 18, unit: 'ms' },
      { key: 'damp', label: 'Damping', min: 1500, max: 16000, def: 6500, unit: 'Hz', curve: 'log' },
      { key: 'mix', label: 'Mix', min: 0, max: 100, def: 100, unit: '%' },
    ],
  },
}

export function makeDevice(type: DeviceType, overrides: Record<string, number> = {}): Device {
  const params: Record<string, number> = {}
  for (const p of DEVICE_SPECS[type].params) params[p.key] = p.def
  return { id: uid(), type, on: true, params: { ...params, ...overrides } }
}

// ───────────────────────── Instruments ─────────────────────────
export const SYNTH_PRESETS: Record<string, SynthParams> = {
  'Velvet Pad': { osc1: 'sawtooth', osc2: 'sawtooth', osc2Semi: 0, osc2Detune: 12, oscMix: 0.5, cutoff: 900, resonance: 0.9, envAmount: 1400, attack: 0.45, decay: 0.8, sustain: 0.7, release: 1.4, glide: 0, gain: -12 },
  'Round Sub': { osc1: 'sine', osc2: 'triangle', osc2Semi: 12, osc2Detune: 0, oscMix: 0.25, cutoff: 420, resonance: 0.7, envAmount: 600, attack: 0.004, decay: 0.25, sustain: 0.85, release: 0.12, glide: 0, gain: -6 },
  'Glass Pluck': { osc1: 'triangle', osc2: 'square', osc2Semi: 12, osc2Detune: 4, oscMix: 0.3, cutoff: 700, resonance: 2.2, envAmount: 5200, attack: 0.002, decay: 0.28, sustain: 0.05, release: 0.35, glide: 0, gain: -10 },
  'Solder Lead': { osc1: 'sawtooth', osc2: 'square', osc2Semi: 7, osc2Detune: 6, oscMix: 0.35, cutoff: 1800, resonance: 3.2, envAmount: 2600, attack: 0.01, decay: 0.3, sustain: 0.6, release: 0.2, glide: 0.04, gain: -13 },
  'Tape Keys': { osc1: 'triangle', osc2: 'sine', osc2Semi: 12, osc2Detune: -5, oscMix: 0.4, cutoff: 2600, resonance: 0.7, envAmount: 1800, attack: 0.003, decay: 0.9, sustain: 0.3, release: 0.5, glide: 0, gain: -10 },
}

export const DRUM_VOICES = [
  { pitch: 36, name: 'Kick' },
  { pitch: 38, name: 'Snare' },
  { pitch: 39, name: 'Clap' },
  { pitch: 42, name: 'Closed hat' },
  { pitch: 46, name: 'Open hat' },
  { pitch: 45, name: 'Low tom' },
  { pitch: 48, name: 'High tom' },
  { pitch: 37, name: 'Rim' },
]

export const DRUM_PRESETS: Record<string, DrumParams> = {
  'Circuit 808': { tune: 0, decay: 1.4, tone: 0.45, levels: [0, -3, -4, -9, -11, -6, -6, -8] },
  'Tight Room': { tune: 2, decay: 0.7, tone: 0.7, levels: [0, -2, -5, -8, -10, -5, -5, -7] },
  'Dusty Break': { tune: -2, decay: 1, tone: 0.3, levels: [-1, -2, -6, -10, -12, -6, -7, -9] },
}

// ───────────────────────── Factories ─────────────────────────
export function makeTrack(kind: 'midi' | 'audio', name: string, color: string, instrument?: Track['instrument']): Track {
  return {
    id: uid(),
    name,
    color,
    kind,
    instrument,
    volume: 0,
    pan: 0,
    mute: false,
    solo: false,
    arm: false,
    sends: [-60, -60],
    devices: [],
    clips: [],
    slots: [null, null, null, null, null, null],
    automation: [],
    showAutomation: null,
  }
}

export const synthInstrument = (preset = 'Velvet Pad'): Track['instrument'] => ({
  type: 'synth',
  preset,
  params: { ...SYNTH_PRESETS[preset] },
})

export const drumInstrument = (preset = 'Circuit 808'): Track['instrument'] => ({
  type: 'drums',
  preset,
  params: { ...DRUM_PRESETS[preset], levels: [...DRUM_PRESETS[preset].levels] },
})

export function midiClip(name: string, start: number, length: number, notes: Omit<Note, 'id'>[], color?: string): MidiClip {
  return { id: uid(), kind: 'midi', name, start, length, color, notes: notes.map((n) => ({ ...n, id: uid() })) }
}

export function cloneClip<T extends Clip>(c: T): T {
  const copy = structuredClone(c)
  copy.id = uid()
  if (copy.kind === 'midi') copy.notes = copy.notes.map((n) => ({ ...n, id: uid() }))
  return copy
}

// ───────────────────────── Demo project ─────────────────────────
// A short F♯-minor sketch at 118 BPM, so the app opens in a working state.
const n = (pitch: number, start: number, dur: number, vel = 0.8) => ({ pitch, start, dur, vel })

function drumBar(variant: 'a' | 'b' | 'fill'): Omit<Note, 'id'>[] {
  const out: Omit<Note, 'id'>[] = []
  const kicks = variant === 'b' ? [0, 1.5, 2.5] : [0, 1.75, 2.5]
  kicks.forEach((b) => out.push(n(36, b, 0.25, 0.95)))
  ;[1, 3].forEach((b) => out.push(n(38, b, 0.25, 0.85)))
  if (variant !== 'a') out.push(n(39, 3, 0.25, 0.6))
  for (let i = 0; i < 8; i++) out.push(n(42, i * 0.5, 0.2, i % 2 ? 0.45 : 0.7))
  out.push(n(46, 3.5, 0.4, 0.55))
  if (variant === 'fill') [2.5, 2.75, 3.25].forEach((b, i) => out.push(n(i < 2 ? 48 : 45, b, 0.25, 0.75)))
  return out
}

function repeatBars(bars: Omit<Note, 'id'>[][]) {
  return bars.flatMap((bar, i) => bar.map((x) => ({ ...x, start: x.start + i * 4 })))
}

// i – VI – III – VII in F♯ minor: F♯m, D, A, E
const CHORDS = [
  [54, 57, 61, 66],
  [50, 54, 57, 62],
  [49, 52, 57, 61],
  [52, 56, 59, 64],
]
const BASS_ROOTS = [42, 38, 45, 40]

export function demoProject(): Project {
  const drums = makeTrack('midi', 'Drums', TRACK_COLORS[0], drumInstrument())
  const bass = makeTrack('midi', 'Sub Bass', TRACK_COLORS[4], synthInstrument('Round Sub'))
  const pad = makeTrack('midi', 'Pad', TRACK_COLORS[3], synthInstrument('Velvet Pad'))
  const lead = makeTrack('midi', 'Pluck Lead', TRACK_COLORS[5], synthInstrument('Glass Pluck'))
  const loop = makeTrack('audio', 'Texture Loop', TRACK_COLORS[6])

  const drumA = repeatBars([drumBar('a'), drumBar('b'), drumBar('a'), drumBar('fill')])
  drums.clips = [
    midiClip('Beat A', 0, 16, drumA),
    midiClip('Beat A', 16, 16, drumA),
    midiClip('Beat B', 32, 16, repeatBars([drumBar('b'), drumBar('b'), drumBar('a'), drumBar('fill')])),
  ]
  drums.slots = [
    midiClip('Beat A', 0, 16, drumA),
    midiClip('Beat B', 0, 16, repeatBars([drumBar('b'), drumBar('b'), drumBar('a'), drumBar('fill')])),
    midiClip('Hats only', 0, 4, Array.from({ length: 16 }, (_, i) => n(42, i * 0.25, 0.15, i % 4 === 0 ? 0.8 : 0.45))),
    null, null, null,
  ]
  drums.devices = [makeDevice('comp', { threshold: -14, ratio: 3, attack: 8, release: 120, makeup: 2 })]
  drums.volume = -6
  drums.sends = [-22, -60]

  const bassNotes = BASS_ROOTS.flatMap((r, i) => [n(r, i * 4, 1.5, 0.9), n(r, i * 4 + 1.75, 0.5, 0.7), n(r, i * 4 + 2.5, 1.25, 0.8), n(r + 12, i * 4 + 3.5, 0.4, 0.6)])
  bass.clips = [midiClip('Bassline', 16, 16, bassNotes), midiClip('Bassline', 32, 16, bassNotes)]
  bass.slots = [midiClip('Bassline', 0, 16, bassNotes), midiClip('Root pulse', 0, 16, BASS_ROOTS.flatMap((r, i) => [0, 1, 2, 3].map((b) => n(r, i * 4 + b, 0.45, 0.8)))), null, null, null, null]
  bass.devices = [makeDevice('eq', { hpf: 30, lowGain: 2, lowFreq: 90, midGain: -3, midFreq: 350 })]
  bass.volume = -7

  const padNotes = CHORDS.flatMap((ch, i) => ch.map((p) => n(p, i * 4, 3.9, 0.6)))
  pad.clips = [midiClip('Chords', 0, 16, padNotes), midiClip('Chords', 16, 16, padNotes), midiClip('Chords', 32, 16, padNotes)]
  pad.slots = [midiClip('Chords', 0, 16, padNotes), null, null, null, null, null]
  pad.sends = [-10, -60]
  pad.volume = -9
  pad.devices = [makeDevice('filter', { mode: 0, cutoff: 3200, res: 0.9 })]
  pad.automation = [
    { param: 'cutoff', points: [{ beat: 0, value: 0.35 }, { beat: 16, value: 0.62 }, { beat: 32, value: 0.5 }, { beat: 44, value: 0.8 }, { beat: 48, value: 0.4 }] },
  ]
  pad.showAutomation = 'cutoff'

  const leadPhrase = [n(73, 0, 0.5), n(71, 0.5, 0.5), n(69, 1, 1), n(66, 2.5, 0.5), n(69, 3, 1), n(74, 4, 0.75), n(73, 5, 0.5), n(69, 5.5, 1.5), n(71, 8, 0.5), n(69, 8.5, 0.5), n(68, 9, 1), n(64, 10.5, 0.5), n(68, 11, 1), n(69, 12, 2), n(66, 14.5, 1)]
  lead.clips = [midiClip('Hook', 32, 16, leadPhrase)]
  lead.slots = [null, midiClip('Hook', 0, 16, leadPhrase), null, null, null, null]
  lead.sends = [-14, -12]
  lead.volume = -8

  loop.volume = -12
  loop.sends = [-18, -60]

  const reverb = makeTrack('audio', 'A · Space', '#8A93A6')
  reverb.kind = 'return'
  reverb.devices = [makeDevice('reverb', { decay: 2.8, mix: 100 })]
  const echo = makeTrack('audio', 'B · Echo', '#8A93A6')
  echo.kind = 'return'
  echo.devices = [makeDevice('delay', { division: 0.75, feedback: 42, mix: 100 })]

  return {
    version: 1,
    name: 'Late Bloom',
    bpm: 118,
    timeSig: [4, 4],
    key: { root: 6, scale: 'minor' },
    tracks: [drums, bass, pad, lead, loop],
    returns: [reverb, echo],
    master: { volume: 0, devices: [makeDevice('comp', { threshold: -14, ratio: 2, attack: 20, release: 200, knee: 10, makeup: 1.5 }), makeDevice('limiter', { gain: 0, ceiling: -1, release: 80 })] },
    scenes: ['Intro', 'Groove', 'Break', 'Scene 4', 'Scene 5', 'Scene 6'].map((name) => ({ id: uid(), name })),
    loop: { on: false, start: 0, end: 16 },
    markers: [
      { id: uid(), beat: 0, name: 'Intro' },
      { id: uid(), beat: 16, name: 'Verse' },
      { id: uid(), beat: 32, name: 'Hook' },
    ],
    assets: {},
  }
}

export function emptyProject(): Project {
  const p = demoProject()
  return { ...p, name: 'Untitled', tracks: [makeTrack('midi', 'Synth', TRACK_COLORS[3], synthInstrument())], markers: [], assets: {} }
}
