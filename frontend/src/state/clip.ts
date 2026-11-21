import type { AudioClip } from './types'

/** Pitch ratio from the clip's transpose (semitones). */
export const pitchRatio = (c: AudioClip) => Math.pow(2, c.transpose / 12)

/** True when the clip is locked to the project tempo. */
export const isWarped = (c: AudioClip) => !!c.warp?.on && c.warp.bpm > 0

/**
 * Seconds of *source* audio consumed per beat of the timeline.
 * Warped: one beat of the file's own tempo, whatever the project tempo (transpose keeps tempo).
 * Not warped: real time at the project tempo, sped up or slowed by varispeed.
 */
export function srcSecPerBeat(c: AudioClip, projectBpm: number) {
  return isWarped(c) ? 60 / c.warp!.bpm : (60 / projectBpm) * pitchRatio(c)
}

/**
 * Time-stretch factor the engine needs for a warped clip: output duration ÷ input duration,
 * pre-multiplied by the pitch ratio because the stretched buffer is then played at that rate.
 */
export function stretchFactor(c: AudioClip, projectBpm: number) {
  return isWarped(c) ? (c.warp!.bpm / projectBpm) * pitchRatio(c) : 1
}

/** Round detected tempos that are within a quarter BPM of an integer (most music is). */
export function tidyBpm(bpm: number) {
  const r = Math.round(bpm)
  return Math.abs(bpm - r) < 0.25 ? r : Math.round(bpm * 100) / 100
}
