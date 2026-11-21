import { useEffect, useRef, useState, type ReactNode } from 'react'
import { audioCtx } from '../engine'
import { buffers } from '../engine/assets'
import { MEDIA_ACCEPT, addDevice, addTrack, importAudio, openFromBackend } from '../state/actions'
import { DEVICE_SPECS, DRUM_PRESETS, SYNTH_PRESETS } from '../state/defaults'
import { setUI, toast, useProject, useUI } from '../state/store'
import type { DeviceType } from '../state/types'
import { Icon, type IconName } from '../ui/icons'
import * as api from '../lib/api'

let previewSrc: AudioBufferSourceNode | null = null
function previewAsset(id: string, onEnd: () => void) {
  previewSrc?.stop()
  previewSrc = null
  const buf = buffers.get(id)
  if (!buf) return
  void audioCtx.resume()
  const s = audioCtx.createBufferSource()
  const g = audioCtx.createGain()
  g.gain.value = 0.8
  s.buffer = buf
  s.connect(g).connect(audioCtx.destination)
  s.start()
  s.onended = onEnd
  previewSrc = s
}

function Group({ title, icon, children, count }: { title: string; icon: IconName; children: ReactNode; count?: number }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="border-b border-line-soft">
      <button className="flex h-[30px] w-full items-center gap-2 px-3 text-left hover:bg-ink-2" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} className="text-fg-3" />
        <Icon name={icon} size={13} className="text-fg-3" />
        <span className="panel-title flex-1">{title}</span>
        {count !== undefined && <span className="num text-[10px] text-fg-3">{count}</span>}
      </button>
      {open && <div className="pb-2">{children}</div>}
    </div>
  )
}

function Item({ label, sub, onClick, drag, help, right }: { label: string; sub?: string; onClick?: () => void; drag?: object; help: string; right?: ReactNode }) {
  return (
    <div
      role="button"
      tabIndex={0}
      draggable={!!drag}
      onDragStart={(e) => { if (drag) { e.dataTransfer.setData('application/x-tessitura', JSON.stringify(drag)); e.dataTransfer.effectAllowed = 'copy' } }}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter') onClick?.() }}
      className="group flex cursor-pointer items-center gap-2 py-[4px] pl-[34px] pr-3 hover:bg-ink-2"
      data-help={help}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] text-fg-2 group-hover:text-fg">{label}</div>
        {sub && <div className="truncate text-[10px] text-fg-3">{sub}</div>}
      </div>
      {right}
    </div>
  )
}

export function Browser() {
  const assets = useProject((s) => s.project.assets)
  const selectedTrack = useUI((s) => s.selectedTrack)
  const [q, setQ] = useState('')
  const [playing, setPlaying] = useState<string | null>(null)
  const [projects, setProjects] = useState<{ name: string; updated: number; versions: number }[] | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLInputElement>(null)
  const syncOnImport = useUI((s) => s.syncOnImport)
  const match = (s: string) => s.toLowerCase().includes(q.toLowerCase())

  const refresh = async () => {
    const caps = await api.capabilities(true)
    setProjects(caps ? await api.listProjects() : null)
  }
  useEffect(() => { void refresh() }, [])

  const assetList = Object.values(assets).filter((a) => match(a.name))
  const badge: Record<string, string> = { import: 'imported', record: 'recorded', stem: 'stem', render: 'render', demo: 'demo', warp: 'warped', video: 'from video', tuned: 'tuned' }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-[40px] shrink-0 items-center gap-2 border-b border-line px-3">
        <Icon name="search" size={13} className="text-fg-3" />
        <input id="browser-search" className="h-full min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-fg-3" placeholder="Search sounds, devices…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Group title="Audio" icon="wave" count={assetList.length}>
          <div className="px-3 pb-1 pt-[2px]">
            <div className="flex gap-1">
              <button className="btn min-w-0 flex-1" onClick={() => fileRef.current?.click()} data-help="Import audio: WAV, AIFF, FLAC, MP3, AAC/M4A, Ogg, Opus, WMA and more. You can also drag files onto the timeline.">
                <Icon name="upload" size={13} /> Import audio…
              </button>
              <button className="btn px-2" onClick={() => videoRef.current?.click()} data-help="Import a video (MP4, MOV, MKV, WebM, AVI…) and keep only its audio">
                Video…
              </button>
            </div>
            <input ref={fileRef} type="file" accept={MEDIA_ACCEPT} multiple hidden onChange={(e) => { [...(e.target.files ?? [])].forEach((f) => void importAudio(f)); e.target.value = '' }} />
            <input ref={videoRef} type="file" accept="video/*,.mp4,.m4v,.mov,.mkv,.webm,.avi,.wmv,.flv,.mpg,.mpeg,.ts,.mts,.3gp,.ogv" multiple hidden onChange={(e) => { [...(e.target.files ?? [])].forEach((f) => void importAudio(f)); e.target.value = '' }} />
            <label className="mt-[6px] flex cursor-pointer items-center gap-2 text-[11px] text-fg-2" data-help="Detect the tempo and first downbeat of imported music and warp it to the project tempo">
              <input type="checkbox" className="accent-[var(--color-cv)]" checked={syncOnImport} onChange={(e) => { const v = e.target.checked; setUI({ syncOnImport: v }); try { localStorage.setItem('tessitura.sync', v ? '1' : '0') } catch { /* private mode */ } }} />
              Sync to tempo on import
            </label>
          </div>
          {assetList.length === 0 && <p className="px-[34px] py-1 text-[11px] text-fg-3">Nothing imported yet.</p>}
          {assetList.map((a) => (
            <Item
              key={a.id}
              label={a.name.replace(/\.[a-z0-9]+$/i, '')}
              sub={`${a.duration.toFixed(1)} s · ${badge[a.source ?? 'import']}${a.bpm ? ` · ${a.bpm} BPM` : ''}${a.key ? ` · ${a.key}` : ''}`}
              drag={{ kind: 'asset', id: a.id }}
              help="Drag onto the timeline or a launcher slot · click ▶ to preview"
              onClick={() => setUI({ analysisAsset: a.id })}
              right={
                <div className="flex items-center gap-1 opacity-60 group-hover:opacity-100">
                  <button
                    className={`flex size-[20px] items-center justify-center rounded-[3px] ${playing === a.id ? 'bg-tape text-[#1a1204]' : 'bg-ink-3 text-fg-2'}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (playing === a.id) { previewSrc?.stop(); setPlaying(null) }
                      else { previewAsset(a.id, () => setPlaying((p) => (p === a.id ? null : p))); setPlaying(a.id) }
                    }}
                    aria-label="Preview"
                  >
                    <Icon name={playing === a.id ? 'stop' : 'play'} size={10} />
                  </button>
                  <button className="flex size-[20px] items-center justify-center rounded-[3px] bg-ink-3 text-fg-2" onClick={(e) => { e.stopPropagation(); setUI({ analysisAsset: a.id, dock: 'analysis', dockOpen: true }) }} aria-label="Open in analysis" data-help="Analyze tempo, key and loudness; separate stems">
                    <Icon name="spark" size={11} />
                  </button>
                </div>
              }
            />
          ))}
        </Group>

        <Group title="Instruments" icon="piano">
          {Object.keys(SYNTH_PRESETS).filter(match).map((n) => (
            <Item key={n} label={n} sub="Synth" drag={{ kind: 'synth', id: n }} onClick={() => addTrack('synth', n)} help="Click to add a track with this synth · drag onto a synth track to swap its preset" />
          ))}
          {Object.keys(DRUM_PRESETS).filter(match).map((n) => (
            <Item key={n} label={n} sub="Drum kit · step sequencer" drag={{ kind: 'drums', id: n }} onClick={() => addTrack('drums', n)} help="Click to add a drum track with this kit · drag onto a drum track to swap its kit" />
          ))}
        </Group>

        <Group title="Effects" icon="sliders">
          {(Object.keys(DEVICE_SPECS) as DeviceType[]).filter((t) => match(DEVICE_SPECS[t].label)).map((t) => (
            <Item
              key={t}
              label={DEVICE_SPECS[t].label}
              sub={DEVICE_SPECS[t].blurb}
              onClick={() => {
                if (!selectedTrack) { toast('Select a track first, then click an effect to add it', 'info'); return }
                addDevice(selectedTrack, t)
                setUI({ showInspector: true })
              }}
              help="Click to add to the selected track's device chain"
            />
          ))}
        </Group>

        <Group title="Saved projects" icon="folder" count={projects?.length}>
          {projects === null ? (
            <p className="px-[34px] py-1 text-[11px] leading-[16px] text-fg-3">The Python backend isn't running, so projects are saved as JSON downloads. Start it with <span className="num text-fg-2">uvicorn app.main:app</span>.</p>
          ) : projects.length === 0 ? (
            <p className="px-[34px] py-1 text-[11px] text-fg-3">No saved projects yet. File → Save version.</p>
          ) : (
            projects.map((p) => (
              <Item key={p.name} label={p.name} sub={`${p.versions} version${p.versions === 1 ? '' : 's'} · ${new Date(p.updated * 1000).toLocaleString()}`} onClick={() => void openFromBackend(p.name)} help="Open this project (latest version)" />
            ))
          )}
          <div className="px-3 pt-1"><button className="btn btn-ghost h-[22px] w-full text-[10px]" onClick={() => void refresh()}>Refresh</button></div>
        </Group>
      </div>
    </div>
  )
}
