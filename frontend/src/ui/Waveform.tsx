import { useEffect, useRef, useSyncExternalStore } from 'react'
import { assetVersion, onAssets, peaks } from '../engine/assets'

/** Min/max waveform of `duration` seconds of an asset starting at `offset`. */
export function Waveform({ assetId, offset, duration, width, height, color, gain = 1 }: { assetId: string; offset: number; duration: number; width: number; height: number; color: string; gain?: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const v = useSyncExternalStore(onAssets, assetVersion)
  const w = Math.max(1, Math.min(16000, Math.round(width)))
  const h = Math.max(1, Math.round(height))
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    c.width = w * dpr
    c.height = h * dpr
    const g = c.getContext('2d')!
    g.scale(dpr, dpr)
    g.clearRect(0, 0, w, h)
    const pk = peaks.get(assetId)
    if (!pk) {
      g.fillStyle = color
      g.globalAlpha = 0.3
      g.fillRect(0, h / 2 - 0.5, w, 1)
      return
    }
    const perSec = pk.sampleRate / pk.samplesPerPeak
    const mid = h / 2
    g.fillStyle = color
    g.beginPath()
    for (let x = 0; x < w; x++) {
      const a = Math.floor((offset + (x / w) * duration) * perSec)
      const b = Math.max(a + 1, Math.floor((offset + ((x + 1) / w) * duration) * perSec))
      let lo = 0, hi = 0
      for (let i = a; i < b && i < pk.min.length; i++) {
        if (pk.min[i] < lo) lo = pk.min[i]
        if (pk.max[i] > hi) hi = pk.max[i]
      }
      const y1 = mid - Math.min(1, hi * gain) * mid * 0.95
      const y2 = mid - Math.max(-1, lo * gain) * mid * 0.95
      g.rect(x, y1, 1, Math.max(0.75, y2 - y1))
    }
    g.fill()
  }, [assetId, offset, duration, w, h, color, gain, v])
  return <canvas ref={ref} style={{ width: w, height: h }} className="pointer-events-none block" />
}
