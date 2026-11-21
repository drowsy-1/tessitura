import { memo } from 'react'
import type { Clip } from '../../state/types'
import { Waveform } from '../../ui/Waveform'
import { isWarped, srcSecPerBeat } from '../../state/clip'

export interface ClipGeom {
  start: number
  length: number
  offset?: number
  fadeIn?: number
  fadeOut?: number
}

export type ClipHandle = 'body' | 'start' | 'end' | 'fadeIn' | 'fadeOut'

/** Visual block for a clip in the arrangement or launcher. Interaction is delegated to the parent. */
export const ClipBlock = memo(function ClipBlock({
  clip, color, ppb, height, selected, geom, bpm, onPointerDown, onDoubleClick, onContextMenu, ghost,
}: {
  clip: Clip; color: string; ppb: number; height: number; selected: boolean; geom?: ClipGeom; bpm: number
  onPointerDown?: (e: React.PointerEvent, handle: ClipHandle) => void
  onDoubleClick?: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  ghost?: boolean
}) {
  const start = geom?.start ?? clip.start
  const length = geom?.length ?? clip.length
  const w = Math.max(3, length * ppb)
  const bodyH = height - 14
  const fadeIn = geom?.fadeIn ?? (clip.kind === 'audio' ? clip.fadeIn : 0)
  const fadeOut = geom?.fadeOut ?? (clip.kind === 'audio' ? clip.fadeOut : 0)
  return (
    <div
      className={`group absolute top-[2px] overflow-hidden rounded-[4px] ${ghost ? 'opacity-50' : ''} ${selected ? 'z-10 ring-[1.5px] ring-tape' : 'ring-1 ring-black/40'}`}
      style={{ left: start * ppb, width: w, height, background: `color-mix(in srgb, ${color} 20%, #101318)` }}
      onPointerDown={(e) => onPointerDown?.(e, 'body')}
      onDoubleClick={(e) => { e.stopPropagation(); onDoubleClick?.() }}
      onContextMenu={onContextMenu}
      data-help={clip.kind === 'midi' ? 'MIDI clip · drag to move (Alt = copy) · edges resize · double-click to edit notes' : 'Audio clip · drag to move (Alt = copy) · edges trim · top corners set fades · double-click to edit'}
    >
      <div className="flex h-[14px] items-center gap-1 px-[5px] text-[10px] font-semibold leading-none text-[#15120c]" style={{ background: color }}>
        <span className="truncate">{clip.name}</span>
        {clip.kind === 'audio' && clip.transpose !== 0 && <span className="num shrink-0 opacity-70">{clip.transpose > 0 ? '+' : ''}{clip.transpose}st</span>}
        {clip.kind === 'audio' && isWarped(clip) && <span className="num ml-auto shrink-0 rounded-[2px] bg-black/20 px-[3px] text-[8px] opacity-80" title={`Warped from ${clip.warp!.bpm} BPM`}>{clip.warp!.bpm} ⇢</span>}
      </div>
      <div className="relative" style={{ height: bodyH }}>
        {clip.kind === 'midi' ? (
          <MidiPreview clip={clip} ppb={ppb} height={bodyH} color={color} />
        ) : (
          <Waveform
            assetId={clip.assetId}
            offset={geom?.offset ?? clip.offset}
            duration={length * srcSecPerBeat(clip, bpm)}
            width={w}
            height={bodyH}
            color={`color-mix(in srgb, ${color} 80%, white)`}
            gain={Math.pow(10, clip.gain / 20)}
          />
        )}
        {clip.kind === 'audio' && (
          <svg className="pointer-events-none absolute inset-0" width={w} height={bodyH}>
            {fadeIn > 0 && <path d={`M0 ${bodyH} Q ${fadeIn * ppb * 0.5} ${bodyH * 0.1} ${fadeIn * ppb} 0 L0 0 Z`} fill="rgba(0,0,0,0.45)" />}
            {fadeOut > 0 && <path d={`M${w} ${bodyH} Q ${w - fadeOut * ppb * 0.5} ${bodyH * 0.1} ${w - fadeOut * ppb} 0 L${w} 0 Z`} fill="rgba(0,0,0,0.45)" />}
          </svg>
        )}
      </div>
      {onPointerDown && (
        <>
          <div className="absolute inset-y-0 left-0 w-[6px] cursor-w-resize" onPointerDown={(e) => { e.stopPropagation(); onPointerDown(e, 'start') }} />
          <div className="absolute inset-y-0 right-0 w-[6px] cursor-e-resize" onPointerDown={(e) => { e.stopPropagation(); onPointerDown(e, 'end') }} />
          {clip.kind === 'audio' && (
            <>
              <div
                className="absolute top-[14px] size-[8px] -translate-x-1/2 cursor-ew-resize rounded-full border border-black/50 bg-fg opacity-0 group-hover:opacity-100"
                style={{ left: Math.max(5, fadeIn * ppb) }}
                onPointerDown={(e) => { e.stopPropagation(); onPointerDown(e, 'fadeIn') }}
                data-help="Fade in · drag"
              />
              <div
                className="absolute top-[14px] size-[8px] translate-x-1/2 cursor-ew-resize rounded-full border border-black/50 bg-fg opacity-0 group-hover:opacity-100"
                style={{ right: Math.max(5, fadeOut * ppb) }}
                onPointerDown={(e) => { e.stopPropagation(); onPointerDown(e, 'fadeOut') }}
                data-help="Fade out · drag"
              />
            </>
          )}
        </>
      )}
    </div>
  )
})

function MidiPreview({ clip, ppb, height, color }: { clip: Extract<Clip, { kind: 'midi' }>; ppb: number; height: number; color: string }) {
  if (!clip.notes.length) return <div className="px-[5px] pt-1 text-[9px] text-fg-3">empty</div>
  let lo = 127, hi = 0
  for (const n of clip.notes) { lo = Math.min(lo, n.pitch); hi = Math.max(hi, n.pitch) }
  lo -= 1; hi += 1
  const range = Math.max(8, hi - lo)
  const rowH = Math.max(1.5, Math.min(4, (height - 6) / range))
  const top = (height - rowH * range) / 2
  return (
    <svg className="pointer-events-none absolute inset-0" width={Math.max(3, clip.length * ppb)} height={height}>
      {clip.notes.map((n) =>
        n.start < clip.length ? (
          <rect key={n.id} x={n.start * ppb} y={top + (hi - n.pitch) * rowH} width={Math.max(1.5, Math.min(n.dur, clip.length - n.start) * ppb - 1)} height={Math.max(1.5, rowH - 0.5)} rx={0.5} fill={`color-mix(in srgb, ${color} 75%, white)`} opacity={0.4 + 0.6 * n.vel} />
        ) : null,
      )}
    </svg>
  )
}
