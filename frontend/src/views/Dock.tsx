import { resolveClip, setUI, useProject, useUI } from '../state/store'
import { Icon } from '../ui/icons'
import { startDrag } from '../ui/controls'
import { PianoRoll } from './editor/PianoRoll'
import { AudioEditor } from './editor/AudioEditor'
import { Mixer } from './Mixer'
import { Analysis } from './Analysis'
import { createMidiClipAt } from '../state/actions'
import type { DockTab } from '../state/types'

function Editor() {
  const project = useProject((s) => s.project)
  const editing = useUI((s) => s.editing)
  const selectedTrack = useUI((s) => s.selectedTrack)
  const r = resolveClip(project, editing)
  if (!r) {
    const t = project.tracks.find((x) => x.id === selectedTrack)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-ink-0 text-center text-[12px] text-fg-3">
        <p className="max-w-[420px] leading-[18px]">Double-click a clip to edit it here. MIDI clips open in the piano roll (drum tracks become a step sequencer); audio clips open the waveform editor.</p>
        {t?.kind === 'midi' && (
          <button className="btn" onClick={() => createMidiClipAt(t.id, 0)}>
            <Icon name="plus" size={13} /> New clip on {t.name}
          </button>
        )}
      </div>
    )
  }
  return r.clip.kind === 'midi' ? <PianoRoll key={r.clip.id} refc={editing!} clip={r.clip} track={r.track} /> : <AudioEditor refc={editing!} clip={r.clip} track={r.track} />
}

const TABS: { id: DockTab; label: string; icon: 'piano' | 'mixer' | 'spark'; key: string }[] = [
  { id: 'editor', label: 'Editor', icon: 'piano', key: 'E' },
  { id: 'mixer', label: 'Mixer', icon: 'mixer', key: 'X' },
  { id: 'analysis', label: 'Analysis & stems', icon: 'spark', key: 'A' },
]

export function Dock() {
  const { dock, dockOpen, dockHeight } = useUI()
  return (
    <div className="flex shrink-0 flex-col border-t border-line bg-ink-1" style={{ height: dockOpen ? dockHeight : 32 }}>
      <div
        className="h-[4px] shrink-0 cursor-ns-resize bg-ink-1 hover:bg-tape/40"
        onPointerDown={(e) => {
          const h0 = useUI.getState().dockHeight
          startDrag(e, (_dx, dy) => setUI({ dockHeight: Math.max(160, Math.min(window.innerHeight - 220, h0 - dy)), dockOpen: true }))
        }}
        data-help="Drag to resize the lower panel"
      />
      <div className="flex h-[28px] shrink-0 items-center gap-1 px-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setUI(dock === t.id && dockOpen ? { dockOpen: false } : { dock: t.id, dockOpen: true })}
            className={`flex h-[22px] items-center gap-[6px] rounded-[4px] px-2 text-[11px] font-medium ${dock === t.id && dockOpen ? 'bg-ink-3 text-fg' : 'text-fg-3 hover:text-fg-2'}`}
            data-help={`${t.label} (${t.key}) · click again to collapse`}
          >
            <Icon name={t.icon} size={13} /> {t.label}
            <span className="num text-[9px] text-fg-3">{t.key}</span>
          </button>
        ))}
        <div className="flex-1" />
        <button className="btn btn-ghost size-[22px] p-0" onClick={() => setUI({ dockOpen: !dockOpen })} aria-label={dockOpen ? 'Collapse panel' : 'Expand panel'}>
          <Icon name={dockOpen ? 'chevronDown' : 'chevronUp'} size={13} />
        </button>
      </div>
      {dockOpen && (
        <div className="min-h-0 flex-1 overflow-auto border-t border-line">
          {dock === 'editor' ? <Editor /> : dock === 'mixer' ? <Mixer /> : <Analysis />}
        </div>
      )}
    </div>
  )
}
