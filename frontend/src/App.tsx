import { useEffect } from 'react'
import { useUI } from './state/store'
import { autosave, ensureDemoAudio, restoreSession } from './state/actions'
import { resumeJobs } from './state/jobs'
import { TuneDialog } from './views/Tune'
import { useProject } from './state/store'
import { installInput } from './lib/input'
import { TopBar } from './views/TopBar'
import { Arrangement } from './views/arrange/Arrangement'
import { Launcher } from './views/Launcher'
import { Browser } from './views/Browser'
import { Inspector } from './views/inspector/Inspector'
import { Dock } from './views/Dock'
import { Palette } from './views/Palette'
import { Help, StatusBar, Toast } from './views/Chrome'
import { ContextMenuHost } from './ui/ContextMenu'

let booted = false

export default function App() {
  const { view, showBrowser, showInspector } = useUI()

  useEffect(() => {
    if (booted) return
    booted = true
    installInput()
    // smaller screens start with the side panels tucked away (⌘B / ⌘I bring them back)
    if (window.innerWidth < 1180) useUI.getState().set({ showBrowser: false })
    if (window.innerWidth < 900) useUI.getState().set({ showInspector: false })
    // reopen the last session (project + audio from IndexedDB); otherwise start on the demo
    void restoreSession()
      .catch(() => false)
      .then((restored) => {
        if (!restored) {
          void ensureDemoAudio()
          // open in a working state: the pad's chords in the piano roll
          const pad = useProject.getState().project.tracks[2]
          if (pad?.clips[0]) useUI.getState().set({ selectedTrack: pad.id, editing: { trackId: pad.id, clipId: pad.clips[0].id }, selectedClips: [{ trackId: pad.id, clipId: pad.clips[0].id }] })
        } else {
          void ensureDemoAudio()
          useUI.getState().set({ selectedTrack: useProject.getState().project.tracks[0]?.id ?? null })
        }
        resumeJobs()
      })
    // autosave of the project JSON (audio is kept in IndexedDB as it is imported)
    let t: ReturnType<typeof setTimeout> | undefined
    useProject.subscribe(() => { clearTimeout(t); t = setTimeout(autosave, 1500) })
  }, [])

  return (
    <div className="flex h-full flex-col bg-ink-0 text-fg">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        {showBrowser && (
          <aside className="w-[232px] shrink-0 border-r border-line bg-ink-1" aria-label="Browser">
            <Browser />
          </aside>
        )}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">{view === 'arrange' ? <Arrangement /> : <Launcher />}</div>
          <Dock />
        </main>
        {showInspector && (
          <aside className="w-[292px] shrink-0 border-l border-line bg-ink-1" aria-label="Inspector">
            <Inspector />
          </aside>
        )}
      </div>
      <StatusBar />
      <Palette />
      <Help />
      <TuneDialog />
      <Toast />
      <ContextMenuHost />
    </div>
  )
}
