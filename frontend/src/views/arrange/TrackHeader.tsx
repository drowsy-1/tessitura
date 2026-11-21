import { useState } from 'react'
import { deleteTrack, duplicateTrack, updateTrack } from '../../state/actions'
import { AUTO_LABELS, setUI, useUI } from '../../state/store'
import { TRACK_COLORS } from '../../state/defaults'
import type { AutoParam, Track } from '../../state/types'
import { Bar, Toggle, fmtDb } from '../../ui/controls'
import { Icon } from '../../ui/icons'
import { openContextMenu } from '../../ui/ContextMenu'

export function TrackHeader({ track, height, onReorderStart }: { track: Track; height: number; onReorderStart: (e: React.PointerEvent) => void }) {
  const selected = useUI((s) => s.selectedTrack === track.id)
  const [renaming, setRenaming] = useState(false)
  const menu = (e: React.MouseEvent) =>
    openContextMenu(e, [
      { label: 'Rename', onClick: () => setRenaming(true) },
      { label: 'Duplicate track', onClick: () => duplicateTrack(track.id), hint: '' },
      { label: 'Colour', divider: true },
      { label: '', swatches: TRACK_COLORS.map((c) => ({ color: c, onPick: () => updateTrack(track.id, (t) => { t.color = c }) })) },
      { label: '', divider: true },
      { label: 'Delete track', danger: true, onClick: () => deleteTrack(track.id) },
    ])
  const autoParams: AutoParam[] = track.instrument?.type === 'synth' ? ['volume', 'pan', 'sendA', 'sendB', 'cutoff'] : ['volume', 'pan', 'sendA', 'sendB']
  return (
    <div
      data-header={track.id}
      className={`relative flex border-b border-line-soft ${selected ? 'bg-ink-2' : 'bg-ink-1'} hover:bg-ink-2`}
      style={{ height }}
      onPointerDown={() => setUI({ selectedTrack: track.id })}
      onContextMenu={menu}
    >
      <div
        className="w-[5px] shrink-0 cursor-grab"
        style={{ background: track.color }}
        onPointerDown={onReorderStart}
        data-help="Drag to reorder tracks · right-click the header for colour, rename, delete"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-[5px] px-2 pt-[6px]">
        <div className="flex items-center gap-[6px]">
          <Icon name={track.kind === 'audio' ? 'wave' : track.instrument?.type === 'drums' ? 'drums' : 'piano'} size={13} className="shrink-0 text-fg-3" />
          {renaming ? (
            <input
              autoFocus
              defaultValue={track.name}
              className="field h-[20px] min-w-0 flex-1 px-1 text-[12px]"
              onBlur={(e) => { updateTrack(track.id, (t) => { t.name = e.target.value || t.name }); setRenaming(false) }}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium" onDoubleClick={() => setRenaming(true)} data-help="Double-click to rename">
              {track.name}
            </span>
          )}
          <Toggle on={track.mute} onClick={() => updateTrack(track.id, (t) => { t.mute = !t.mute })} title="Mute (M on selected track)" tone="warn">M</Toggle>
          <Toggle on={track.solo} onClick={(e) => updateTrack(track.id, (t) => { t.solo = !t.solo; void e })} title="Solo" tone="cv">S</Toggle>
          <Toggle on={track.arm} onClick={() => updateTrack(track.id, (t) => { t.arm = !t.arm })} title={track.kind === 'audio' ? 'Arm for audio recording (microphone / interface input)' : 'Arm for MIDI recording'} tone="rec">●</Toggle>
        </div>
        <div className="flex items-center gap-[6px]">
          <Bar
            value={track.volume}
            min={-60}
            max={6}
            def={0}
            height={16}
            className="flex-1"
            label="Vol"
            help={`${track.name} volume`}
            color={track.color}
            format={(v) => `${fmtDb(v)} dB`}
            onChange={(v) => updateTrack(track.id, (t) => { t.volume = Math.round(v * 10) / 10 }, 'vol')}
          />
          <button
            className={`flex h-[16px] items-center gap-[3px] rounded-[3px] px-[5px] text-[9px] font-semibold uppercase tracking-wider ${track.showAutomation ? 'bg-cv/20 text-cv' : 'bg-ink-3 text-fg-3 hover:text-fg-2'}`}
            onClick={(e) => {
              e.stopPropagation()
              openContextMenu(e, [
                { label: 'Hide automation', onClick: () => updateTrack(track.id, (t) => { t.showAutomation = null }) },
                { label: '', divider: true },
                ...autoParams.map((ap) => ({
                  label: `${AUTO_LABELS[ap]}${track.automation.find((l) => l.param === ap && l.points.length) ? '  ·  has points' : ''}`,
                  onClick: () => updateTrack(track.id, (t) => { t.showAutomation = ap }),
                })),
              ])
            }}
            data-help="Show an automation lane for this track"
          >
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 8 L3 3 L6 6 L10 1" stroke="currentColor" fill="none" strokeWidth="1.4" /></svg>
            Auto
          </button>
        </div>
      </div>
    </div>
  )
}
