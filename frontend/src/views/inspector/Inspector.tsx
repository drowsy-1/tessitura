import { useState, type ReactNode } from 'react'
import { addDevice, deleteTrack, duplicateTrack, updateTrack } from '../../state/actions'
import { DEVICE_SPECS, TRACK_COLORS } from '../../state/defaults'
import { edit, findTrack, setUI, useProject, useUI } from '../../state/store'
import type { Device, DeviceType, Project } from '../../state/types'
import { Bar, Menu, MenuItem, fmtDb } from '../../ui/controls'
import { Icon } from '../../ui/icons'
import { DeviceBody } from './DeviceViews'
import { DrumView, SynthView } from './InstrumentViews'
import { keyLabel } from '../../lib/music'

function Section({ title, children, right, defaultOpen = true }: { title: string; children: ReactNode; right?: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="border-b border-line">
      <div className="flex h-[32px] items-center justify-between px-3">
        <button className="flex items-center gap-1 panel-title hover:text-fg" onClick={() => setOpen(!open)} aria-expanded={open}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
          {title}
        </button>
        {right}
      </div>
      {open && <div className="px-3 pb-3">{children}</div>}
    </section>
  )
}

function devicesOf(p: Project, owner: string): Device[] {
  return owner === 'master' ? p.master.devices : findTrack(p, owner)?.devices ?? []
}

function DeviceChain({ owner, devices }: { owner: string; devices: Device[] }) {
  const mutate = (fn: (list: Device[]) => void, co?: string) => edit((p) => fn(devicesOf(p, owner)), { coalesce: co })
  const setParam = (d: Device) => (key: string, v: number) => {
    // a burst of changes to one parameter becomes one undo step
    mutate((list) => { const x = list.find((y) => y.id === d.id); if (x) x.params[key] = v }, `dev:${d.id}:${key}`)
  }
  const types = Object.keys(DEVICE_SPECS) as DeviceType[]
  return (
    <div className="flex flex-col gap-2">
      {devices.map((d, i) => (
        <div key={d.id} className={`rounded-[6px] border ${d.on ? 'border-line bg-ink-2' : 'border-line-soft bg-ink-1 opacity-70'}`}>
          <div className="flex h-[30px] items-center gap-1 border-b border-line-soft pl-2 pr-1">
            <button
              className={`flex size-[18px] items-center justify-center rounded-full ${d.on ? 'text-tape' : 'text-fg-3'}`}
              onClick={() => mutate((l) => { const x = l.find((y) => y.id === d.id); if (x) x.on = !x.on })}
              aria-label={d.on ? 'Bypass device' : 'Enable device'}
              data-help={d.on ? 'Bypass this device' : 'Enable this device'}
            >
              <Icon name="power" size={13} />
            </button>
            <span className="flex-1 text-[12px] font-semibold" title={DEVICE_SPECS[d.type].blurb}>{DEVICE_SPECS[d.type].label}</span>
            <button className="btn btn-ghost size-[20px] p-0" disabled={i === 0} onClick={() => mutate((l) => { const [x] = l.splice(i, 1); l.splice(i - 1, 0, x) })} aria-label="Move up" data-help="Move earlier in the chain"><Icon name="up" size={12} /></button>
            <button className="btn btn-ghost size-[20px] p-0" disabled={i === devices.length - 1} onClick={() => mutate((l) => { const [x] = l.splice(i, 1); l.splice(i + 1, 0, x) })} aria-label="Move down" data-help="Move later in the chain"><Icon name="down" size={12} /></button>
            <button className="btn btn-ghost size-[20px] p-0 hover:text-rec" onClick={() => mutate((l) => { l.splice(i, 1) })} aria-label="Remove device" data-help="Remove device"><Icon name="close" size={12} /></button>
          </div>
          {d.on && <div className="p-2"><DeviceBody device={d} set={setParam(d)} trackId={owner} /></div>}
        </div>
      ))}
      <Menu
        width={236}
        trigger={(open) => (
          <button className="btn btn-ghost w-full border border-dashed border-line" onClick={open} data-help="Add an effect to the end of the chain">
            <Icon name="plus" size={13} /> Add device
          </button>
        )}
      >
        {(close) =>
          types.map((t) => (
            <MenuItem key={t} onClick={() => { addDevice(owner, t); close() }}>
              <span className="flex flex-col">
                <span>{DEVICE_SPECS[t].label}</span>
                <span className="text-[10px] leading-[13px] text-fg-3">{DEVICE_SPECS[t].blurb}</span>
              </span>
            </MenuItem>
          ))
        }
      </Menu>
    </div>
  )
}

export function Inspector() {
  const project = useProject((s) => s.project)
  const sel = useUI((s) => s.selectedTrack)
  const track = findTrack(project, sel)

  if (sel === 'master')
    return (
      <div className="h-full overflow-y-auto">
        <div className="flex h-[40px] items-center gap-2 border-b border-line px-3">
          <span className="text-[13px] font-semibold">Master bus</span>
        </div>
        <Section title="Master chain">
          <p className="mb-2 text-[11px] leading-[16px] text-fg-3">Everything you hear passes through here. A gentle compressor, then EQ, is a sensible start; keep the true peak below −1 dBTP for streaming.</p>
          <DeviceChain owner="master" devices={project.master.devices} />
        </Section>
      </div>
    )

  if (!track)
    return (
      <div className="h-full overflow-y-auto p-4 text-[12px] leading-[18px] text-fg-3">
        <div className="panel-title mb-2">Project</div>
        <div className="mb-4 grid grid-cols-2 gap-y-1">
          <span>Tempo</span><span className="num text-fg-2">{project.bpm} BPM</span>
          <span>Key</span><span className="text-fg-2">{keyLabel(project.key.root, project.key.scale)}</span>
          <span>Tracks</span><span className="num text-fg-2">{project.tracks.length}</span>
        </div>
        <p>Select a track to see its instrument, device chain, sends and colour. Everything here is edited with sliders, pads and curves — no knobs.</p>
        <button className="btn mt-3" onClick={() => setUI({ selectedTrack: 'master' })}>Open master chain</button>
      </div>
    )

  const isReturn = track.kind === 'return'
  return (
    <div className="h-full overflow-y-auto">
      <div className="flex h-[40px] items-center gap-2 border-b border-line px-3">
        <span className="h-4 w-[4px] rounded-full" style={{ background: track.color }} />
        <input
          id="track-name"
          className="min-w-0 flex-1 bg-transparent text-[13px] font-semibold outline-none focus:text-tape"
          value={track.name}
          onChange={(e) => updateTrack(track.id, (t) => { t.name = e.target.value }, 'name')}
          onKeyDown={(e) => e.stopPropagation()}
          aria-label="Track name"
        />
        {!isReturn && (
          <Menu
            align="right"
            width={180}
            trigger={(open) => <button className="btn btn-ghost size-[24px] p-0" onClick={open} aria-label="Track options"><Icon name="sliders" size={14} /></button>}
          >
            {(close) => (
              <>
                <div className="flex flex-wrap gap-[6px] p-2">
                  {TRACK_COLORS.map((c) => <button key={c} className="size-[16px] rounded-full ring-1 ring-black/40" style={{ background: c }} onClick={() => updateTrack(track.id, (t) => { t.color = c })} aria-label={`Colour ${c}`} />)}
                </div>
                <MenuItem onClick={() => { duplicateTrack(track.id); close() }}>Duplicate track</MenuItem>
                <MenuItem danger onClick={() => { deleteTrack(track.id); close() }}>Delete track</MenuItem>
              </>
            )}
          </Menu>
        )}
      </div>

      <Section title="Channel">
        <div className="flex flex-col gap-[5px]">
          <Bar value={track.volume} min={-60} max={6} def={0} height={20} label="Volume" color={track.color} format={(v) => `${fmtDb(v)} dB`} onChange={(v) => updateTrack(track.id, (t) => { t.volume = Math.round(v * 10) / 10 }, 'vol')} />
          <Bar value={track.pan} min={-1} max={1} def={0} bipolar height={20} label="Pan" color={track.color} format={(v) => (Math.abs(v) < 0.01 ? 'Centre' : v < 0 ? `${Math.round(-v * 100)} L` : `${Math.round(v * 100)} R`)} onChange={(v) => updateTrack(track.id, (t) => { t.pan = Math.round(v * 100) / 100 }, 'pan')} />
          {!isReturn &&
            project.returns.map((r, i) => (
              <Bar key={r.id} value={track.sends[i] ?? -60} min={-60} max={6} def={-60} height={20} label={`Send → ${r.name}`} color="var(--color-cv)" format={(v) => `${fmtDb(v)} dB`} onChange={(v) => updateTrack(track.id, (t) => { t.sends[i] = Math.round(v * 10) / 10 }, `send${i}`)} />
            ))}
        </div>
      </Section>

      {track.instrument && (
        <Section title={track.instrument.type === 'synth' ? 'Synth' : 'Drum kit'}>
          {track.instrument.type === 'synth' ? <SynthView track={track} /> : <DrumView track={track} />}
        </Section>
      )}

      <Section title={`Devices · ${track.devices.length}`}>
        <DeviceChain owner={track.id} devices={track.devices} />
      </Section>
    </div>
  )
}
