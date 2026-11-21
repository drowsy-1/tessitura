import { useEffect, useRef, useState } from 'react'
import { engine, onFrame, useEngine } from '../engine'
import { addTrack, audioClipFor, commitLaunchesToArrangement, createMidiClipAt, importAudio, isMedia, updateTrack } from '../state/actions'
import { cloneClip, uid } from '../state/defaults'
import { edit, findTrack, getProject, setUI, useProject, useUI } from '../state/store'
import type { Clip, Track } from '../state/types'
import { Bar, Segmented, fmtDb } from '../ui/controls'
import { Icon } from '../ui/icons'
import { openContextMenu } from '../ui/ContextMenu'
import type { LaunchEntry } from '../engine/engine'

const COL_W = 150
const ROW_H = 46

function slotState(launches: LaunchEntry[], trackId: string, slot: number, pos: number) {
  const mine = launches.filter((l) => l.trackId === trackId && l.slot === slot)
  if (mine.some((l) => l.start > pos + 1e-6)) return 'queued'
  if (mine.some((l) => l.start <= pos && l.end > pos)) return 'playing'
  return 'idle'
}

function Slot({ track, index, clip }: { track: Track; index: number; clip: Clip | null }) {
  const q = useUI((s) => s.launchQuantize)
  const editing = useUI((s) => s.editing)
  const progress = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'idle' | 'queued' | 'playing'>('idle')
  const [over, setOver] = useState(false)

  useEffect(
    () =>
      onFrame((pos) => {
        const st = engine.playing ? slotState(engine.launches, track.id, index, pos) : 'idle'
        setState((s) => (s === st ? s : st))
        if (progress.current && clip) {
          const l = engine.launches.find((x) => x.trackId === track.id && x.slot === index && x.start <= pos && x.end > pos)
          progress.current.style.width = l ? `${(((pos - l.start) % clip.length) / clip.length) * 100}%` : '0%'
        }
      }),
    [track.id, index, clip],
  )

  const isEditing = editing?.slot === index && editing.trackId === track.id

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setOver(false)
    if (track.kind !== 'audio') return
    const file = [...e.dataTransfer.files][0]
    const raw = e.dataTransfer.getData('application/x-tessitura')
    let assetId: string | undefined
    if (file) {
      if (!isMedia(file)) return
      // same pipeline as the arrangement: any audio/video format, tempo detection + warp on import
      assetId = (await importAudio(file))?.id
    } else if (raw) {
      const it = JSON.parse(raw) as { kind: string; id: string }
      if (it.kind === 'asset') assetId = it.id
    }
    if (!assetId) return
    const asset = getProject().assets[assetId]
    edit((p) => { const t = findTrack(p, track.id); if (t) t.slots[index] = audioClipFor(asset, 0, p.bpm) }, { label: 'Fill slot' })
  }

  if (!clip)
    return (
      <div
        className={`group flex items-center justify-center border-b border-r border-line-soft ${over ? 'bg-cv/10' : ''}`}
        style={{ height: ROW_H }}
        onDoubleClick={() => track.kind === 'midi' && createMidiClipAt(track.id, 0, index)}
        onDragOver={(e) => { e.preventDefault(); setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        data-help={track.kind === 'midi' ? 'Empty slot · double-click to create a clip · the square stops this track' : 'Empty slot · drop an audio file or browser sample here · the square stops this track'}
      >
        <button
          className="flex size-[18px] items-center justify-center rounded-[3px] text-fg-3/60 hover:bg-ink-3 hover:text-fg-2"
          onClick={() => engine.stopTrack(track.id, q)}
          aria-label="Stop track"
        >
          <span className="size-[7px] bg-current" />
        </button>
      </div>
    )

  const color = clip.color ?? track.color
  return (
    <div className="border-b border-r border-line-soft p-[3px]" style={{ height: ROW_H }}>
      <div
        className={`relative flex h-full cursor-pointer items-center gap-2 overflow-hidden rounded-[4px] pl-1 pr-2 ${isEditing ? 'ring-[1.5px] ring-tape' : ''}`}
        style={{ background: state === 'playing' ? color : `color-mix(in srgb, ${color} 28%, #14171d)` }}
        onClick={() => setUI({ selectedTrack: track.id, selectedClips: [{ trackId: track.id, clipId: clip.id, slot: index }] })}
        onDoubleClick={() => setUI({ editing: { trackId: track.id, clipId: clip.id, slot: index }, dock: 'editor', dockOpen: true })}
        onContextMenu={(e) =>
          openContextMenu(e, [
            { label: 'Edit', onClick: () => setUI({ editing: { trackId: track.id, clipId: clip.id, slot: index }, dock: 'editor', dockOpen: true }) },
            { label: 'Duplicate to next empty slot', onClick: () => edit((p) => { const t = findTrack(p, track.id); if (!t) return; const i = t.slots.findIndex((s, k) => k > index && !s); const c = cloneClip(clip); if (i >= 0) t.slots[i] = c; else t.slots.push(c) }) },
            { label: 'Place in arrangement at playhead', onClick: () => edit((p) => { const t = findTrack(p, track.id); if (!t) return; const c = cloneClip(clip); c.start = Math.round(engine.position()); t.clips.push(c) }) },
            { label: '', divider: true },
            { label: 'Delete', danger: true, onClick: () => edit((p) => { const t = findTrack(p, track.id); if (t) t.slots[index] = null }) },
          ])
        }
        data-help="Session clip · ▶ launches on the next quantize boundary · double-click to edit · right-click for more"
      >
        <button
          className={`flex size-[22px] shrink-0 items-center justify-center rounded-[3px] ${state === 'playing' ? 'bg-black/25 text-[#15120c]' : 'bg-black/30 text-fg hover:bg-black/45'} ${state === 'queued' ? 'animate-blink' : ''}`}
          onClick={(e) => { e.stopPropagation(); void engine.launch(track.id, index, q) }}
          aria-label={`Launch ${clip.name}`}
        >
          <Icon name="play" size={12} />
        </button>
        <div className="min-w-0 flex-1">
          <div className={`truncate text-[11px] font-semibold ${state === 'playing' ? 'text-[#15120c]' : 'text-fg'}`}>{clip.name}</div>
          <div className={`num text-[9px] ${state === 'playing' ? 'text-[#15120c]/70' : 'text-fg-3'}`}>{+(clip.length / 4).toFixed(2)} bar{clip.length === 4 ? '' : 's'}</div>
        </div>
        <div className="absolute inset-x-0 bottom-0 h-[3px] bg-black/20">
          <div ref={progress} className="h-full bg-black/45" style={{ width: 0 }} />
        </div>
      </div>
    </div>
  )
}

export function Launcher() {
  const project = useProject((s) => s.project)
  const q = useUI((s) => s.launchQuantize)
  const snap = useEngine()
  const [renaming, setRenaming] = useState<string | null>(null)
  const rows = project.scenes

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-line bg-ink-1 px-2">
        <span className="label">Launch quantize</span>
        <Segmented
          value={q}
          onChange={(v) => setUI({ launchQuantize: v })}
          size="xs"
          help="When launched clips start: immediately, on the next beat, or on the next bar"
          options={[{ value: 0, label: 'None' }, { value: 1, label: 'Beat' }, { value: 4, label: 'Bar' }]}
        />
        <div className="mx-1 h-4 w-px bg-line" />
        <button className="btn btn-ghost h-[24px] px-2 text-[11px]" onClick={() => engine.stopAllClips(q)} data-help="Stop every session clip on the next boundary">
          <span className="size-[8px] bg-current" /> Stop all
        </button>
        <button
          className={`btn h-[24px] px-2 text-[11px] ${snap.detached.length || snap.launches.length ? 'bg-tape/15 text-tape hover:bg-tape/25' : 'btn-ghost'}`}
          onClick={() => engine.backToArrangement()}
          data-help="Return every track to the arrangement timeline"
        >
          <Icon name="back" size={13} /> Back to arrangement
        </button>
        <button
          className="btn btn-ghost h-[24px] px-2 text-[11px]"
          disabled={!snap.historyCount}
          onClick={commitLaunchesToArrangement}
          data-help="Write what you just performed in the launcher into the arrangement, exactly where it happened"
        >
          <Icon name="commit" size={13} /> Commit performance{snap.historyCount ? ` (${snap.historyCount})` : ''}
        </button>
        <div className="flex-1" />
        <span className="text-[11px] text-fg-3">Clips loop until stopped · scenes launch a whole row</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-ink-0">
        <div className="inline-flex min-w-full">
          {/* track columns */}
          {project.tracks.map((t) => (
            <div key={t.id} className="shrink-0" style={{ width: COL_W }}>
              <div
                className={`sticky top-0 z-10 flex h-[32px] items-center gap-2 border-b border-r border-line px-2 ${useUI.getState().selectedTrack === t.id ? 'bg-ink-2' : 'bg-ink-1'}`}
                onClick={() => setUI({ selectedTrack: t.id })}
              >
                <span className="h-3 w-[3px] rounded-full" style={{ background: t.color }} />
                <span className="truncate text-[12px] font-medium">{t.name}</span>
                {snap.detached.includes(t.id) && <span className="ml-auto rounded-[3px] bg-tape/15 px-1 text-[9px] font-semibold uppercase tracking-wider text-tape" data-help="This track is playing session clips, not the arrangement">session</span>}
              </div>
              {rows.map((_, i) => <Slot key={i} track={t} index={i} clip={t.slots[i] ?? null} />)}
              <div className="flex flex-col gap-[6px] border-r border-line-soft p-2">
                <button className="btn btn-ghost h-[22px] w-full text-[10px]" onClick={() => engine.stopTrack(t.id, q)} data-help="Stop this track's clip">
                  <span className="size-[7px] bg-current" /> Stop
                </button>
                <Bar value={t.volume} min={-60} max={6} def={0} height={16} label="Vol" color={t.color} format={(v) => fmtDb(v)} onChange={(v) => updateTrack(t.id, (x) => { x.volume = Math.round(v * 10) / 10 }, 'vol')} />
                <Bar value={t.pan} min={-1} max={1} def={0} bipolar height={16} label="Pan" color={t.color} format={(v) => (Math.abs(v) < 0.01 ? 'C' : v < 0 ? `${Math.round(-v * 100)}L` : `${Math.round(v * 100)}R`)} onChange={(v) => updateTrack(t.id, (x) => { x.pan = Math.round(v * 100) / 100 }, 'pan')} />
              </div>
            </div>
          ))}
          <div className="flex shrink-0 flex-col gap-1 p-2" style={{ width: 120 }}>
            <button className="btn btn-ghost h-[24px] text-[11px]" onClick={() => addTrack('synth')}><Icon name="plus" size={12} /> Synth</button>
            <button className="btn btn-ghost h-[24px] text-[11px]" onClick={() => addTrack('drums')}><Icon name="plus" size={12} /> Drums</button>
            <button className="btn btn-ghost h-[24px] text-[11px]" onClick={() => addTrack('audio')}><Icon name="plus" size={12} /> Audio</button>
          </div>
          <div className="flex-1" />
          {/* scenes column */}
          <div className="sticky right-0 shrink-0 border-l border-line bg-ink-1" style={{ width: 150 }}>
            <div className="sticky top-0 z-10 flex h-[32px] items-center border-b border-line bg-ink-1 px-2">
              <span className="label">Scenes</span>
            </div>
            {rows.map((s, i) => (
              <div key={s.id} className="flex items-center gap-2 border-b border-line-soft px-2" style={{ height: ROW_H }}>
                <button className="btn size-[24px] shrink-0 p-0 hover:text-tape" onClick={() => engine.launchScene(i, q)} data-help={`Launch scene “${s.name}”: every clip in this row starts together; tracks with empty slots stop`} aria-label={`Launch scene ${s.name}`}>
                  <Icon name="scene" size={12} />
                </button>
                {renaming === s.id ? (
                  <input
                    autoFocus
                    defaultValue={s.name}
                    className="field h-[22px] w-full px-1 text-[11px]"
                    onBlur={(e) => { edit((p) => { const sc = p.scenes.find((x) => x.id === s.id); if (sc) sc.name = e.target.value || sc.name }); setRenaming(null) }}
                    onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                  />
                ) : (
                  <span className="truncate text-[12px] text-fg-2" onDoubleClick={() => setRenaming(s.id)} data-help="Double-click to rename">{s.name}</span>
                )}
              </div>
            ))}
            <button
              className="btn btn-ghost m-2 h-[24px] w-[calc(100%-16px)] text-[11px]"
              onClick={() => edit((p) => { p.scenes.push({ id: uid(), name: `Scene ${p.scenes.length + 1}` }); p.tracks.forEach((t) => t.slots.push(null)) })}
            >
              <Icon name="plus" size={12} /> Scene
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
