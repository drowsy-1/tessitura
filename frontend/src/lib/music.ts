import type { ScaleName } from '../state/types'

export const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']

export const SCALES: Record<ScaleName, { label: string; steps: number[] }> = {
  major: { label: 'Major', steps: [0, 2, 4, 5, 7, 9, 11] },
  minor: { label: 'Minor', steps: [0, 2, 3, 5, 7, 8, 10] },
  dorian: { label: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
  mixolydian: { label: 'Mixolydian', steps: [0, 2, 4, 5, 7, 9, 10] },
  harmonicMinor: { label: 'Harmonic minor', steps: [0, 2, 3, 5, 7, 8, 11] },
  majorPent: { label: 'Major pentatonic', steps: [0, 2, 4, 7, 9] },
  minorPent: { label: 'Minor pentatonic', steps: [0, 3, 5, 7, 10] },
  chromatic: { label: 'Chromatic', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
}

export const noteName = (p: number) => `${NOTE_NAMES[((p % 12) + 12) % 12]}${Math.floor(p / 12) - 1}`
export const midiToFreq = (p: number) => 440 * Math.pow(2, (p - 69) / 12)

export function inScale(pitch: number, root: number, scale: ScaleName) {
  const pc = (((pitch - root) % 12) + 12) % 12
  return SCALES[scale].steps.includes(pc)
}

/** Nearest in-scale pitch (ties resolve downward). */
export function snapToScale(pitch: number, root: number, scale: ScaleName) {
  for (let d = 0; d < 12; d++) {
    if (inScale(pitch - d, root, scale)) return pitch - d
    if (inScale(pitch + d, root, scale)) return pitch + d
  }
  return pitch
}

export type ChordShape = 'off' | 'triad' | 'seventh' | 'power' | 'sus2'

/** Diatonic chord stacked in thirds from `pitch`, staying inside the current key. */
export function diatonicChord(pitch: number, root: number, scale: ScaleName, shape: ChordShape): number[] {
  if (shape === 'off') return [pitch]
  if (shape === 'power') return [pitch, pitch + 7, pitch + 12]
  const steps = SCALES[scale].steps
  if (steps.length !== 7) {
    // pentatonic/chromatic: fall back to fixed shapes
    const q = shape === 'seventh' ? [0, 4, 7, 10] : shape === 'sus2' ? [0, 2, 7] : [0, 4, 7]
    return q.map((i) => pitch + i)
  }
  const base = snapToScale(pitch, root, scale)
  const pc = (((base - root) % 12) + 12) % 12
  const deg = steps.indexOf(pc)
  const degrees = shape === 'seventh' ? [0, 2, 4, 6] : shape === 'sus2' ? [0, 1, 4] : [0, 2, 4]
  return degrees.map((d) => {
    const idx = deg + d
    const oct = Math.floor(idx / 7)
    return base - pc + steps[idx % 7] + oct * 12
  })
}

export const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII']

// Camelot wheel: number 1..12, letter A (minor) / B (major)
const CAMELOT_MAJOR: Record<number, number> = { 11: 1, 6: 2, 1: 3, 8: 4, 3: 5, 10: 6, 5: 7, 0: 8, 7: 9, 2: 10, 9: 11, 4: 12 }
const CAMELOT_MINOR: Record<number, number> = { 8: 1, 3: 2, 10: 3, 5: 4, 0: 5, 7: 6, 2: 7, 9: 8, 4: 9, 11: 10, 6: 11, 1: 12 }

export function camelot(root: number, minor: boolean) {
  return `${(minor ? CAMELOT_MINOR : CAMELOT_MAJOR)[root]}${minor ? 'A' : 'B'}`
}

export function camelotToKey(code: string): { root: number; minor: boolean } | null {
  const m = /^(\d{1,2})([AB])$/.exec(code)
  if (!m) return null
  const n = Number(m[1])
  const minor = m[2] === 'A'
  const table = minor ? CAMELOT_MINOR : CAMELOT_MAJOR
  const root = Number(Object.keys(table).find((k) => table[Number(k)] === n))
  return { root, minor }
}

/** Harmonic-mixing neighbours: same code, ±1 on the wheel, relative major/minor. */
export function camelotNeighbours(code: string) {
  const m = /^(\d{1,2})([AB])$/.exec(code)
  if (!m) return []
  const n = Number(m[1])
  const l = m[2]
  const wrap = (x: number) => ((x - 1 + 12) % 12) + 1
  return [`${n}${l}`, `${wrap(n - 1)}${l}`, `${wrap(n + 1)}${l}`, `${n}${l === 'A' ? 'B' : 'A'}`]
}

export function keyLabel(root: number, scale: ScaleName) {
  return `${NOTE_NAMES[root]} ${SCALES[scale].label.toLowerCase()}`
}

/** Smallest semitone shift (−6..+5) that moves `fromRoot` onto `toRoot`. */
export function semitoneShift(fromRoot: number, toRoot: number) {
  let d = (((toRoot - fromRoot) % 12) + 12) % 12
  if (d > 6) d -= 12
  return d
}

export function formatBBT(beat: number, beatsPerBar: number) {
  const b = Math.max(0, beat)
  const bar = Math.floor(b / beatsPerBar) + 1
  const bt = Math.floor(b % beatsPerBar) + 1
  const sixteenth = Math.floor((b % 1) * 4) + 1
  return `${bar}.${bt}.${sixteenth}`
}

export function formatTime(sec: number) {
  const s = Math.max(0, sec)
  const m = Math.floor(s / 60)
  const r = s - m * 60
  return `${m}:${r.toFixed(2).padStart(5, '0')}`
}
