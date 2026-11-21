// Pitch correction dialog: CPU-based tuning on the backend (pYIN / CREPE / PESTO → WORLD / PSOLA).
import { useEffect, useMemo, useRef, useState } from 'react'
import * as api from '../lib/api'
import { NOTE_NAMES, SCALES, inScale, noteName } from '../lib/music'
import { startTune, useJobs, type JobView } from '../state/jobs'
import { resolveClip, setUI, toast, useProject, useUI } from '../state/store'
import type { ScaleName } from '../state/types'
import { Bar, Segmented } from '../ui/controls'
import { Icon } from '../ui/icons'
import { useElementWidth } from '../ui/hooks'

const PRESETS = {
  Natural: { speed: 70, amount: 0.85, humanize: 0.55 },
  Tight: { speed: 25, amount: 1, humanize: 0.25 },
  'Hard tune': { speed: 0, amount: 1, humanize: 0 },
}

function Curve({ res, root, scale }: { res: api.TuneResult; root: number; scale: ScaleName }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const W = useElementWidth(wrap)
  const H = 190
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width = W * dpr
    c.height = H * dpr
    const g = c.getContext('2d')!
    g.scale(dpr, dpr)
    g.clearRect(0, 0, W, H)
    const vals = [...res.curves.detected, ...res.curves.corrected].filter((v): v is number => v !== null)
    if (!vals.length) return
    const lo = Math.floor(Math.min(...vals)) - 1
    const hi = Math.ceil(Math.max(...vals)) + 1
    const n = res.curves.detected.length
    const L = 34
    const x = (i: number) => L + (i / Math.max(1, n - 1)) * (W - L - 6)
    const y = (m: number) => 6 + (1 - (m - lo) / Math.max(1, hi - lo)) * (H - 12)
    const css = getComputedStyle(document.documentElement)
    g.font = '9px JetBrains Mono, monospace'
    for (let m = lo; m <= hi; m++) {
      const inKey = inScale(m, root, scale)
      g.fillStyle = inKey ? 'rgba(88,196,208,0.07)' : 'transparent'
      g.fillRect(L, y(m + 0.5), W - L, y(m - 0.5) - y(m + 0.5))
      g.strokeStyle = inKey ? 'rgba(88,196,208,0.28)' : 'rgba(255,255,255,0.05)'
      g.beginPath(); g.moveTo(L, y(m)); g.lineTo(W, y(m)); g.stroke()
      if (inKey && hi - lo < 30) { g.fillStyle = css.getPropertyValue('--color-fg-3') || '#6b717d'; g.fillText(noteName(m), 2, y(m) + 3) }
    }
    const line = (arr: (number | null)[], color: string, width: number) => {
      g.strokeStyle = color
      g.lineWidth = width
      g.beginPath()
      let pen = false
      arr.forEach((v, i) => {
        if (v === null) { pen = false; return }
        if (!pen) g.moveTo(x(i), y(v)); else g.lineTo(x(i), y(v))
        pen = true
      })
      g.stroke()
    }
    line(res.curves.detected, 'rgba(200,205,215,0.55)', 1.2)
    line(res.curves.corrected, '#e9a23b', 1.8)
  }, [res, root, scale, W])
  return (
    <div ref={wrap} className="rounded-[6px] bg-ink-0 ring-1 ring-line ring-inset" data-help="Grey: the pitch as sung. Amber: after correction. Cyan bands are notes in the key.">
      <canvas ref={ref} style={{ width: W, height: H }} className="block" />
    </div>
  )
}

export function TuneDialog() {
  const ref = useUI((s) => s.tuning)
  const project = useProject((s) => s.project)
  const jobs = useJobs((s) => s.jobs)
  const [caps, setCaps] = useState<api.Capabilities | null | undefined>(undefined)
  const [root, setRoot] = useState(project.key.root)
  const [scale, setScale] = useState<ScaleName>(project.key.scale)
  const [speed, setSpeed] = useState(PRESETS.Natural.speed)
  const [amount, setAmount] = useState(PRESETS.Natural.amount)
  const [humanize, setHumanize] = useState(PRESETS.Natural.humanize)
  const [detector, setDetector] = useState('pyin')
  const [synth, setSynth] = useState('world')
  const [jobId, setJobId] = useState<string | null>(null)
  const [tuneRes, setTuneRes] = useState<api.TuneResult | null>(null)

  useEffect(() => {
    if (!ref) return
    setRoot(project.key.root)
    setScale(project.key.scale)
    setJobId(null)
    setTuneRes(null)
    void api.capabilities(true).then((c) => {
      setCaps(c)
      const s = c?.tune?.synths.find((x) => x.available)
      if (s && !c?.tune?.synths.find((x) => x.id === 'world')?.available) setSynth(s.id)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref?.clipId])

  const job: JobView | undefined = jobId ? jobs[jobId] : undefined
  useEffect(() => { if (job?.tune) setTuneRes(job.tune) }, [job?.tune])
  const running = job && (job.status === 'queued' || job.status === 'running')
  const r = ref ? resolveClip(project, ref) : null
  const clipName = r?.clip.name ?? ''
  const steps = useMemo(() => SCALES[scale].steps, [scale])
  if (!ref) return null
  const close = () => setUI({ tuning: null })

  const apply = async () => {
    try {
      setTuneRes(null)
      setJobId(await startTune(ref, { root, scale: steps, speed, amount, humanize, detector, synth }))
    } catch (e) {
      toast(`Couldn't start pitch correction: ${(e as Error).message}`, 'warn')
    }
  }
  const opts = (list: api.TuneOption[] | undefined, value: string, setv: (v: string) => void, name: string) => (
    <div className="flex flex-col gap-1" role="radiogroup" aria-label={name}>
      {(list ?? []).map((o) => (
        <label key={o.id} className={`flex cursor-pointer gap-2 rounded-[5px] px-2 py-[4px] ${value === o.id ? 'bg-ink-3' : 'hover:bg-ink-2'} ${o.available ? '' : 'opacity-45'}`} data-help={o.note}>
          <input type="radio" name={name} className="mt-[3px] accent-[var(--color-tape)]" checked={value === o.id} disabled={!o.available} onChange={() => setv(o.id)} />
          <span className="min-w-0">
            <span className="block text-[12px]">{o.label}</span>
            <span className="block text-[10px] leading-[13px] text-fg-3">{o.available ? o.note : 'Not installed on the backend'}</span>
          </span>
        </label>
      ))}
    </div>
  )

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/55" onPointerDown={close}>
      <div className="flex max-h-[90vh] w-[760px] max-w-[95vw] flex-col gap-4 overflow-y-auto rounded-[12px] border border-line bg-ink-2 p-5 shadow-[0_24px_64px_rgba(0,0,0,0.6)]" onPointerDown={(e) => e.stopPropagation()} role="dialog" aria-label="Pitch correction">
        <div className="flex items-baseline justify-between">
          <div>
            <h2 className="font-display text-[20px] font-semibold">Pitch correction</h2>
            <div className="text-[12px] text-fg-3">{clipName} · runs on the CPU, no GPU needed · works best on a solo vocal or instrument</div>
          </div>
          <button className="btn btn-ghost size-[28px] p-0" onClick={close} aria-label="Close"><Icon name="close" size={15} /></button>
        </div>

        {caps === null ? (
          <p className="text-[13px] text-fg-2">Pitch correction runs on the Python backend. Start it with <span className="num">uvicorn app.main:app --port 8000</span>. For the best results also install <span className="num">pip install pyworld praat-parselmouth</span>.</p>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="flex flex-col gap-3">
                <div>
                  <div className="label mb-1">Key</div>
                  <div className="mb-2 grid grid-cols-6 gap-1">
                    {NOTE_NAMES.map((n, i) => (
                      <button key={n} onClick={() => setRoot(i)} className={`h-6 rounded-[4px] text-[11px] ${root === i ? 'bg-tape text-[#1a1204]' : 'bg-ink-3 hover:bg-ink-4'}`}>{n}</button>
                    ))}
                  </div>
                  <select id="tune-scale" className="field w-full" value={scale} onChange={(e) => setScale(e.target.value as ScaleName)}>
                    {(Object.keys(SCALES) as ScaleName[]).map((s) => <option key={s} value={s}>{SCALES[s].label}</option>)}
                  </select>
                </div>
                <div>
                  <div className="label mb-1">Style</div>
                  <Segmented
                    value={Object.entries(PRESETS).find(([, p]) => p.speed === speed && p.amount === amount && p.humanize === humanize)?.[0] ?? ''}
                    onChange={(k) => { const p = PRESETS[k as keyof typeof PRESETS]; setSpeed(p.speed); setAmount(p.amount); setHumanize(p.humanize) }}
                    size="xs"
                    options={Object.keys(PRESETS).map((k) => ({ value: k, label: k }))}
                  />
                </div>
                <Bar value={speed} min={0} max={400} def={70} height={22} label="Retune speed" format={(v) => (v < 1 ? 'instant' : `${Math.round(v)} ms`)} onChange={setSpeed} help="How fast a note is pulled onto pitch. 0 ms is the hard, robotic effect; 50–100 ms sounds natural." />
                <Bar value={amount * 100} min={0} max={100} def={85} height={22} label="Amount" format={(v) => `${Math.round(v)}%`} onChange={(v) => setAmount(v / 100)} help="How much of the error to correct" />
                <Bar value={humanize * 100} min={0} max={100} def={55} height={22} label="Humanize" format={(v) => `${Math.round(v)}%`} onChange={(v) => setHumanize(v / 100)} help="Higher keeps more vibrato and scoops: only each note's centre is corrected" />
              </div>
              <div className="flex flex-col gap-3">
                <div><div className="label mb-1">Pitch detection</div>{opts(caps?.tune?.detectors, detector, setDetector, 'detector')}</div>
                <div><div className="label mb-1">Resynthesis</div>{opts(caps?.tune?.synths, synth, setSynth, 'synth')}</div>
              </div>
            </div>

            {tuneRes && (
              <div className="flex flex-col gap-2">
                <Curve res={tuneRes} root={root} scale={scale} />
                <div className="num text-[11px] text-fg-3">Average correction {tuneRes.stats.mean_cents} ¢ · largest {tuneRes.stats.max_cents} ¢ · {Math.round(tuneRes.stats.voiced * 100)}% of the clip is pitched</div>
              </div>
            )}
            {job && !tuneRes && (
              <div className="flex flex-col gap-1">
                <div className="h-[5px] overflow-hidden rounded-full bg-ink-0"><div className={`h-full ${job.status === 'error' ? 'bg-rec' : 'bg-tape'}`} style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>
                <div className="text-[11px] text-fg-3">{job.message}</div>
              </div>
            )}
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-fg-3">The corrected take replaces the clip's audio; the original stays available through the A/B switch in the audio editor.</span>
              <div className="flex gap-2">
                <button className="btn" onClick={close}>{tuneRes ? 'Done' : 'Cancel'}</button>
                <button className="btn btn-accent" disabled={!!running || caps === undefined} onClick={() => void apply()}>
                  <Icon name="chord" size={13} /> {running ? 'Correcting…' : tuneRes ? 'Apply again' : 'Correct pitch'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
