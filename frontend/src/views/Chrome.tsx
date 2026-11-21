// App chrome: status bar (contextual help), toasts, shortcut sheet.
import { useEffect } from 'react'
import { setUI, useProject, useUI } from '../state/store'
import { Icon } from '../ui/icons'
import { capabilities } from '../lib/api'
import { useState } from 'react'

export function StatusBar() {
  const hint = useUI((s) => s.hint)
  const qwerty = useUI((s) => s.qwerty)
  const lastLabel = useProject((s) => s.lastLabel)
  const [backend, setBackend] = useState<boolean | null>(null)
  const [midi, setMidi] = useState(0)
  useEffect(() => {
    const check = () => void capabilities().then((c) => setBackend(!!c))
    check()
    const id = setInterval(check, 20000)
    const onMidi = (e: Event) => setMidi((e as CustomEvent<number>).detail)
    window.addEventListener('tessitura:midi', onMidi)
    return () => { clearInterval(id); window.removeEventListener('tessitura:midi', onMidi) }
  }, [])
  // contextual help: any element with data-help describes itself here on hover
  useEffect(() => {
    let last = ''
    const h = (e: PointerEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.('[data-help]') as HTMLElement | null
      const t = el?.dataset.help ?? ''
      if (t !== last) { last = t; setUI({ hint: t }) }
    }
    window.addEventListener('pointerover', h)
    return () => window.removeEventListener('pointerover', h)
  }, [])
  return (
    <footer className="flex h-[24px] shrink-0 items-center gap-3 border-t border-line bg-ink-1 px-3 text-[11px] text-fg-3">
      <Icon name="help" size={12} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate text-fg-2">{hint || 'Hover anything to see what it does · ⌘K runs any command · ? lists shortcuts'}</span>
      {lastLabel && <span className="hidden md:inline">Last: {lastLabel}</span>}
      {qwerty && <span className="text-tape">Keyboard piano on: A–K play, Z/X octave</span>}
      {midi > 0 && <span className="text-cv">{midi} MIDI input{midi > 1 ? 's' : ''}</span>}
      <span className="flex items-center gap-[5px]" data-help={backend ? 'Python backend connected: librosa analysis, stem separation, warping and project versions are available' : 'Python backend not reachable: the DAW works fully; analysis runs in the browser and stems/warp are unavailable'}>
        <span className={`size-[6px] rounded-full ${backend ? 'bg-ok' : backend === false ? 'bg-fg-3' : 'bg-warn'}`} />
        {backend ? 'Backend' : backend === false ? 'Offline mode' : 'Checking…'}
      </span>
    </footer>
  )
}

export function Toast() {
  const t = useUI((s) => s.toast)
  if (!t) return null
  const tone = t.tone === 'ok' ? 'border-ok/40' : t.tone === 'warn' ? 'border-warn/50' : 'border-line'
  return (
    <div className="pointer-events-none fixed bottom-[40px] left-1/2 z-[95] -translate-x-1/2" role="status" aria-live="polite">
      <div className={`flex items-center gap-2 rounded-[8px] border ${tone} bg-ink-2 px-4 py-[9px] text-[12px] shadow-[0_12px_32px_rgba(0,0,0,0.5)]`}>
        <span className={`size-[7px] rounded-full ${t.tone === 'ok' ? 'bg-ok' : t.tone === 'warn' ? 'bg-warn' : 'bg-cv'}`} />
        {t.text}
      </div>
    </div>
  )
}

const SHORTCUTS: [string, [string, string][]][] = [
  ['Transport', [['Space', 'Play / stop'], ['R', 'Record on armed tracks'], ['L', 'Loop on / off'], ['K', 'Metronome'], ['Home', 'Go to start'], ['Stop twice', 'Return to start']]],
  ['Views', [['Tab', 'Arrange ⟷ Launch'], ['E', 'Editor'], ['X', 'Mixer'], ['A', 'Analysis & stems'], ['⌘B / ⌘I', 'Browser / inspector'], ['⌘K', 'Command palette']]],
  ['Editing', [['⌘Z / ⇧⌘Z', 'Undo / redo'], ['⌘D', 'Duplicate'], ['S', 'Split at playhead'], ['⌫', 'Delete'], ['V / B / E', 'Select / draw / erase tool'], ['Q', 'Quantize (editor)'], ['Alt-drag', 'Copy, or ignore snap'], ['⌘ + wheel', 'Zoom']]],
  ['Playing', [['`', 'Computer keyboard piano'], ['A W S E D F T G Y H U J K', 'Notes C to C'], ['Z / X', 'Octave down / up'], ['C / V', 'Velocity down / up (piano mode)']]],
  ['Controls', [['Drag', 'Adjust any slider or number'], ['Shift + drag', 'Fine adjustment'], ['Double-click', 'Reset slider / type a number'], ['Wheel', 'Nudge']]],
]

export function Help() {
  const open = useUI((s) => s.helpOpen)
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/55" onPointerDown={() => setUI({ helpOpen: false })}>
      <div className="max-h-[84vh] w-[820px] max-w-[94vw] overflow-y-auto rounded-[12px] border border-line bg-ink-2 p-6 shadow-[0_24px_64px_rgba(0,0,0,0.6)]" onPointerDown={(e) => e.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts">
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="font-display text-[22px] font-semibold">Working quickly in Tessitura</h2>
          <button className="btn btn-ghost size-[28px] p-0" onClick={() => setUI({ helpOpen: false })} aria-label="Close"><Icon name="close" size={15} /></button>
        </div>
        <div className="grid grid-cols-1 gap-x-8 gap-y-5 md:grid-cols-2">
          {SHORTCUTS.map(([group, rows]) => (
            <div key={group}>
              <div className="panel-title mb-2">{group}</div>
              {rows.map(([k, d]) => (
                <div key={k} className="flex items-baseline justify-between gap-4 border-b border-line-soft py-[5px] text-[12px]">
                  <span className="text-fg-2">{d}</span>
                  <span className="num shrink-0 rounded-[3px] bg-ink-0 px-[6px] py-[1px] text-[11px] text-fg">{k}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
