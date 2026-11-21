import { useRef, useState } from 'react'
import { useSyncExternalStore } from 'react'
import { assetVersion, buffers, onAssets } from '../../engine/assets'
import { normalizeClip, reverseClipAudio, syncToTempo } from '../../state/actions'
import { edit, gestureKey, resolveClip, setUI, useProject, type ClipRef } from '../../state/store'
import type { AudioClip, Track } from '../../state/types'
import { Bar, NumberField, Toggle, fmtDb, startDrag } from '../../ui/controls'
import { Icon } from '../../ui/icons'
import { Waveform } from '../../ui/Waveform'
import { useElementSize } from '../../ui/hooks'
import { isWarped, srcSecPerBeat } from '../../state/clip'

export function AudioEditor({ refc, clip, track }: { refc: ClipRef; clip: AudioClip; track: Track }) {
  const project = useProject((s) => s.project)
  useSyncExternalStore(onAssets, assetVersion)
  const buf = buffers.get(clip.assetId)
  const asset = project.assets[clip.assetId]
  const wrap = useRef<HTMLDivElement>(null)
  const { w, h: wrapH } = useElementSize(wrap)
  const waveH = Math.max(40, wrapH) // contentRect already excludes the p-3 padding
  const warped = isWarped(clip)
  const dur = buf?.duration ?? asset?.duration ?? 1
  const used = clip.length * srcSecPerBeat(clip, project.bpm)
  const [detecting, setDetecting] = useState(false)
  const set = (fn: (c: AudioClip) => void, co?: string) =>
    edit((p) => { const r = resolveClip(p, refc); if (r && r.clip.kind === 'audio') fn(r.clip) }, { coalesce: co ? `${co}:${clip.id}` : undefined })

  const slip = (e: React.PointerEvent) => {
    const o0 = clip.offset
    const key = gestureKey()
    startDrag(e, (dx) => {
      const off = Math.max(0, Math.min(dur - used, o0 + (dx / w) * dur))
      edit((p) => { const r = resolveClip(p, refc); if (r && r.clip.kind === 'audio') r.clip.offset = off }, { coalesce: key })
      setUI({ hint: `Slip · source offset ${off.toFixed(3)} s` })
    })
  }

  // warp: the source's beat grid over the whole file (a downbeat every 4 beats from the clip start)
  const beatSec = warped ? 60 / clip.warp!.bpm : 0
  const gridLines: { x: number; down: boolean }[] = []
  if (warped && beatSec > 0.15) {
    for (let k = Math.ceil(-clip.offset / beatSec); gridLines.length < 2000; k++) {
      const t = clip.offset + k * beatSec
      if (t >= dur) break
      gridLines.push({ x: (t / dur) * 100, down: ((k % 4) + 4) % 4 === 0 })
    }
  }
  const nudge = (beats: number) => set((c) => { c.offset = Math.max(0, c.offset + beats * beatSec) })
  const setBpm = (bpm: number) => set((c) => {
    if (!c.warp) return
    const secs = c.length * (60 / c.warp.bpm) // keep the same stretch of audio in the clip
    c.warp.bpm = Math.round(bpm * 100) / 100
    c.length = Math.max(0.25, secs / (60 / c.warp.bpm))
  }, 'wbpm')
  const toggleWarp = () => {
    if (warped) set((c) => { c.length = (c.length * (60 / c.warp!.bpm)) / (60 / project.bpm); c.warp!.on = false })
    else if (clip.warp) set((c) => { c.warp!.on = true; c.length = (c.length * (60 / project.bpm)) / (60 / c.warp!.bpm) })
    else void syncToTempo(clip.assetId, refc)
  }
  const abToggle = () => set((c) => {
    if (c.assetId !== c.origAssetId) { c.tunedAssetId = c.assetId; c.assetId = c.origAssetId! }
    else if (c.tunedAssetId) c.assetId = c.tunedAssetId
  })

  return (
    <div className="flex h-full min-h-0 flex-col" data-editor>
      <div className="flex h-[36px] shrink-0 items-center gap-2 overflow-x-auto border-b border-line bg-ink-1 px-2 [&>*]:shrink-0">
        <span className="h-3 w-[3px] rounded-full" style={{ background: track.color }} />
        <input id="clip-name" className="field h-[24px] w-[130px]" value={clip.name} onChange={(e) => set((c) => { c.name = e.target.value }, 'name')} onKeyDown={(e) => e.stopPropagation()} aria-label="Clip name" />
        <div className="w-[140px]">
          <Bar value={clip.gain} min={-24} max={24} def={0} bipolar height={22} label="Gain" format={(v) => `${fmtDb(v)} dB`} onChange={(v) => set((c) => { c.gain = Math.round(v * 10) / 10 }, 'gain')} help="Clip gain (before the track's effects)" />
        </div>
        <div className="mx-1 h-4 w-px bg-line" />
        <Toggle on={warped} tone="cv" className="h-[22px] px-2" title="Warp: lock this clip to the project tempo. It follows tempo changes, and transpose keeps the tempo." onClick={toggleWarp}>
          Warp
        </Toggle>
        {warped && (
          <>
            <NumberField value={clip.warp!.bpm} min={40} max={260} step={0.01} width={78} format={(v) => `${v.toFixed(2)} bpm`} help="The file's own tempo. Correct it here if detection was off; ×2 / ÷2 fix double- or half-time reads." onChange={setBpm} />
            <button className="btn btn-ghost h-[22px] px-[6px] text-[10px]" onClick={() => setBpm(clip.warp!.bpm * 2)} data-help="Double the source tempo">×2</button>
            <button className="btn btn-ghost h-[22px] px-[6px] text-[10px]" onClick={() => setBpm(clip.warp!.bpm / 2)} data-help="Halve the source tempo">÷2</button>
            <div className="flex items-center gap-[2px]" data-help="Move the clip start by one beat of the source, to put the downbeat on the bar line">
              <button className="btn btn-ghost h-[22px] px-[6px] text-[10px]" onClick={() => nudge(-1)}>◀ beat</button>
              <button className="btn btn-ghost h-[22px] px-[6px] text-[10px]" onClick={() => nudge(1)}>beat ▶</button>
            </div>
          </>
        )}
        <button
          className="btn btn-ghost h-[24px] px-2 text-[11px]"
          disabled={detecting}
          onClick={async () => { setDetecting(true); try { await syncToTempo(clip.assetId, refc) } finally { setDetecting(false) } }}
          data-help="Detect the tempo and first downbeat again, then warp this clip to the project"
        >
          {detecting ? 'Detecting…' : warped ? 'Re-detect' : 'Detect & sync'}
        </button>
        <div className="mx-1 h-4 w-px bg-line" />
        <span className="label">{warped ? 'Pitch' : 'Varispeed'}</span>
        <NumberField
          value={clip.transpose}
          min={-24}
          max={24}
          step={1}
          width={52}
          def={0}
          format={(v) => `${v > 0 ? '+' : ''}${v} st`}
          help={warped ? 'Transpose in semitones; the tempo stays locked' : 'Tape-style transpose: pitch and speed change together. Turn Warp on to transpose without changing tempo.'}
          onChange={(v) => set((c) => {
            if (!isWarped(c)) { const r0 = Math.pow(2, c.transpose / 12); const r1 = Math.pow(2, v / 12); c.length = c.length * (r0 / r1) }
            c.transpose = v
          }, 'tr')}
        />
        <span className="label">Fades</span>
        <NumberField value={clip.fadeIn} min={0} max={clip.length} step={0.125} width={52} def={0} format={(v) => `${v} bt`} help="Fade-in length in beats" onChange={(v) => set((c) => { c.fadeIn = v }, 'fi')} />
        <NumberField value={clip.fadeOut} min={0} max={clip.length} step={0.125} width={52} def={0} format={(v) => `${v} bt`} help="Fade-out length in beats" onChange={(v) => set((c) => { c.fadeOut = v }, 'fo')} />
        <div className="mx-1 h-4 w-px bg-line" />
        <button className="btn btn-ghost h-[24px] px-2 text-[11px]" onClick={() => normalizeClip(refc, -1)} data-help="Set clip gain so the source peaks at −1 dBFS">Normalize</button>
        <button className="btn btn-ghost h-[24px] px-2 text-[11px]" onClick={() => reverseClipAudio(refc)} data-help="Reverse the audio (creates a new reversed copy; the original is kept)"><Icon name="reverse" size={13} /> Reverse</button>
        <button className="btn h-[24px] px-2 text-[11px]" onClick={() => setUI({ tuning: refc })} data-help="Pitch correction for vocals and solo instruments, run on the CPU"><Icon name="chord" size={13} /> Tune…</button>
        {clip.origAssetId && (
          <Toggle on={clip.assetId !== clip.origAssetId} tone="ok" className="h-[22px] px-2" title="A/B: switch between the tuned take and the original" onClick={abToggle}>
            {clip.assetId !== clip.origAssetId ? 'Tuned' : 'Original'}
          </Toggle>
        )}
        <div className="flex-1" />
        <button className="btn h-[24px] px-2 text-[11px]" onClick={() => setUI({ dock: 'analysis', analysisAsset: clip.assetId })} data-help="Tempo, key (Camelot), loudness and stem separation">
          <Icon name="spark" size={13} /> Analyze &amp; stems
        </button>
      </div>
      <div className="flex shrink-0 items-center gap-4 border-b border-line-soft bg-ink-1 px-3 py-[6px] text-[11px] text-fg-3">
        <span>Source <span className="text-fg-2">{asset?.name ?? 'missing audio'}</span></span>
        <span className="num">{dur.toFixed(2)} s · {asset?.sampleRate ?? '—'} Hz · {asset?.channels === 1 ? 'mono' : 'stereo'}</span>
        {warped ? (
          <span className="num text-cv">warped {clip.warp!.bpm} → {project.bpm} BPM ({((project.bpm / clip.warp!.bpm - 1) * 100).toFixed(1)}%)</span>
        ) : asset?.bpm ? <span className="num">≈ {asset.bpm} BPM, not warped</span> : null}
        {asset?.key && <span className="num">key {asset.key}</span>}
        <span className="ml-auto">{warped ? 'Cyan lines are the file’s beats; bright ones are downbeats. Drag the region to slip.' : 'Drag the highlighted region to slip the audio inside the clip'}</span>
      </div>
      <div ref={wrap} className="relative min-h-0 flex-1 overflow-hidden bg-ink-0 p-3">
        {!buf ? (
          <div className="flex h-full items-center justify-center text-fg-3">This clip's audio isn't loaded in this session. Re-import the file to hear it.</div>
        ) : (
          <div className="relative h-full">
            <div className="absolute inset-0 opacity-35">
              <Waveform assetId={clip.assetId} offset={0} duration={dur} width={w} height={waveH} color="#8a909c" />
            </div>
            <div
              className="absolute inset-y-0 cursor-grab overflow-hidden rounded-[4px] ring-1 ring-tape/80"
              style={{ left: `${(clip.offset / dur) * 100}%`, width: `${(Math.min(used, dur - clip.offset) / dur) * 100}%`, background: `color-mix(in srgb, ${track.color} 16%, transparent)` }}
              onPointerDown={slip}
              data-help="Clip region · drag to slip"
            >
              <div className="absolute inset-0" style={{ left: `${-(clip.offset / Math.max(used, 1e-6)) * 100}%`, width: `${(dur / Math.max(used, 1e-6)) * 100}%` }}>
                <Waveform assetId={clip.assetId} offset={0} duration={dur} width={w} height={waveH} color={`color-mix(in srgb, ${track.color} 85%, white)`} gain={Math.pow(10, clip.gain / 20)} />
              </div>
            </div>
            {gridLines.map((g, i) => (
              <div key={i} className="pointer-events-none absolute inset-y-0" style={{ left: `${g.x}%`, width: 1, background: g.down ? 'var(--color-cv)' : 'color-mix(in srgb, var(--color-cv) 35%, transparent)' }} />
            ))}
            <div className="num pointer-events-none absolute bottom-1 left-1 text-[10px] text-fg-3">0.00 s</div>
            <div className="num pointer-events-none absolute bottom-1 right-1 text-[10px] text-fg-3">{dur.toFixed(2)} s</div>
          </div>
        )}
      </div>
    </div>
  )
}
