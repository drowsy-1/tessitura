// Project data model. Everything here is plain JSON so projects diff cleanly in git.

export type ID = string

export type Wave = 'sine' | 'triangle' | 'sawtooth' | 'square'

export interface Note {
  id: ID
  pitch: number // MIDI note number
  start: number // beats, relative to clip start
  dur: number // beats
  vel: number // 0..1
}

export type AutoParam = 'volume' | 'pan' | 'sendA' | 'sendB' | 'cutoff'

export interface AutoPoint {
  beat: number // absolute arrangement beat
  value: number // normalized 0..1
}

export interface AutomationLane {
  param: AutoParam
  points: AutoPoint[]
}

export interface SynthParams {
  osc1: Wave
  osc2: Wave
  osc2Semi: number
  osc2Detune: number // cents
  oscMix: number // 0 = osc1 only, 1 = osc2 only
  cutoff: number // Hz
  resonance: number // Q
  envAmount: number // Hz added at envelope peak
  attack: number
  decay: number
  sustain: number
  release: number
  glide: number
  gain: number // dB
}

export interface DrumParams {
  tune: number // semitones
  decay: number // multiplier
  tone: number // 0..1 brightness
  levels: number[] // per voice, dB
}

export type Instrument =
  | { type: 'synth'; preset: string; params: SynthParams }
  | { type: 'drums'; preset: string; params: DrumParams }

export type DeviceType = 'eq' | 'comp' | 'filter' | 'sat' | 'delay' | 'reverb' | 'limiter'

export interface Device {
  id: ID
  type: DeviceType
  on: boolean
  params: Record<string, number>
}

interface ClipBase {
  id: ID
  name: string
  start: number // beats (arrangement position; ignored for launcher slots)
  length: number // beats
  color?: string
}

export interface MidiClip extends ClipBase {
  kind: 'midi'
  notes: Note[]
}

export interface AudioClip extends ClipBase {
  kind: 'audio'
  assetId: ID
  offset: number // seconds into the source
  gain: number // dB
  fadeIn: number // beats
  fadeOut: number // beats
  transpose: number // semitones: varispeed when not warped, key-locked pitch shift when warped
  /** Warp: lock the audio to the project tempo. `bpm` is the source file's own tempo. */
  warp?: { on: boolean; bpm: number }
  /** Set after pitch correction so the editor can A/B against the untouched take. */
  origAssetId?: ID
  tunedAssetId?: ID // the tuned take while A/B-ing back to the original
}

export type Clip = MidiClip | AudioClip

export type TrackKind = 'midi' | 'audio' | 'return'

export interface Track {
  id: ID
  name: string
  color: string
  kind: TrackKind
  instrument?: Instrument
  volume: number // dB
  pan: number // -1..1
  mute: boolean
  solo: boolean
  arm: boolean
  sends: [number, number] // dB, -inf represented as -60
  devices: Device[]
  clips: Clip[]
  slots: (Clip | null)[]
  automation: AutomationLane[]
  showAutomation: AutoParam | null
}

export interface Scene {
  id: ID
  name: string
}

export interface AssetMeta {
  id: ID
  name: string
  duration: number
  sampleRate: number
  channels: number
  bpm?: number
  key?: string
  source?: 'import' | 'record' | 'stem' | 'render' | 'demo' | 'warp' | 'video' | 'tuned'
  firstBeat?: number // seconds: first beat (ideally the downbeat) in the source
  jobId?: string // stems: the backend job they came from
}

export interface Marker {
  id: ID
  beat: number
  name: string
}

export interface Project {
  version: 1
  name: string
  bpm: number
  timeSig: [number, number]
  key: { root: number; scale: ScaleName }
  tracks: Track[]
  returns: Track[]
  master: { volume: number; devices: Device[] }
  scenes: Scene[]
  loop: { on: boolean; start: number; end: number }
  markers: Marker[]
  assets: Record<ID, AssetMeta>
}

export type ScaleName =
  | 'major'
  | 'minor'
  | 'dorian'
  | 'mixolydian'
  | 'harmonicMinor'
  | 'majorPent'
  | 'minorPent'
  | 'chromatic'

export type ViewName = 'arrange' | 'launch'
export type DockTab = 'editor' | 'mixer' | 'analysis'
export type Tool = 'draw' | 'select' | 'erase'
