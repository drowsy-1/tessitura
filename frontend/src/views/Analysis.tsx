import { useEffect, useState } from 'react'
import { analysisCache, addStemsAsTracks, analyzeAsset, analyzeMix, syncToTempo, warpAsset, type Analysis as A } from '../state/actions'
import { importStems, startStems, useJobs } from '../state/jobs'
import { tidyBpm } from '../state/clip'
import { edit, setUI, toast, useProject, useUI } from '../state/store'
import type { AssetMeta } from '../state/types'
import { camelot, camelotNeighbours, camelotToKey, NOTE_NAMES, semitoneShift } from '../lib/music'
import type { LoudnessReport } from '../engine/dsp'
import { Icon } from '../ui/icons'
import * as api from '../lib/api'

function Card({ title, children, className = '' }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex min-h-0 min-w-0 flex-col gap-2 overflow-y-auto rounded-[7px] border border-line bg-ink-1 p-3 [&>*]:shrink-0 ${className}`}>
      <div className="panel-title">{title}</div>
      {children}
    </div>
  )
}

function Confidence({ v, label }: { v: number; label: string }) {
  return (
    <div className="flex items-center gap-2" data-help={`${label} confidence. Automatic key detection is wrong 14–59% of the time depending on the tool, so verify by ear.`}>
      <div className="h-[4px] flex-1 overflow-hidden rounded-full bg-ink-0"><div className="h-full bg-cv" style={{ width: `${Math.round(v * 100)}%` }} /></div>
      <span className="num text-[10px] text-fg-3">{Math.round(v * 100)}%</span>
    </div>
  )
}

export function CamelotWheel({ code, project, size = 168 }: { code?: string; project: string; size?: number }) {
  const r = size / 2
  const neighbours = code ? camelotNeighbours(code) : []
  const seg = (n: number, ring: 'A' | 'B') => {
    const a0 = ((n % 12) * 30 - 15 - 90) * (Math.PI / 180)
    const a1 = a0 + (30 * Math.PI) / 180
    const [ro, ri] = ring === 'B' ? [r - 2, r * 0.66] : [r * 0.64, r * 0.36]
    const p = (rad: number, a: number) => `${r + rad * Math.cos(a)} ${r + rad * Math.sin(a)}`
    const id = `${n}${ring}`
    const isKey = id === code
    const isProj = id === project
    const near = neighbours.includes(id) && !isKey
    const fill = isKey ? 'var(--color-tape)' : near ? 'color-mix(in srgb, var(--color-tape) 30%, var(--color-ink-2))' : 'var(--color-ink-2)'
    const mid = (a0 + a1) / 2
    const tr = (ro + ri) / 2
    const k = camelotToKey(id)!
    return (
      <g key={id}>
        <path d={`M${p(ro, a0)} A${ro} ${ro} 0 0 1 ${p(ro, a1)} L${p(ri, a1)} A${ri} ${ri} 0 0 0 ${p(ri, a0)} Z`} fill={fill} stroke={isProj ? 'var(--color-cv)' : 'var(--color-ink-0)'} strokeWidth={isProj ? 2 : 1.5}>
          <title>{`${id} · ${NOTE_NAMES[k.root]} ${k.minor ? 'minor' : 'major'}${isProj ? ' (project key)' : ''}`}</title>
        </path>
        <text x={r + tr * Math.cos(mid)} y={r + tr * Math.sin(mid) + 3} textAnchor="middle" fontSize={size / 17} fontFamily="var(--font-mono)" fill={isKey ? '#1a1204' : near ? 'var(--color-fg)' : 'var(--color-fg-3)'} className="pointer-events-none">
          {id}
        </text>
      </g>
    )
  }
  return (
    <svg width={size} height={size} className="shrink-0" data-help="Camelot wheel: amber = detected key, tinted = harmonically compatible (±1 step or relative major/minor), cyan outline = project key">
      {Array.from({ length: 12 }, (_, i) => i + 1).flatMap((n) => [seg(n, 'B'), seg(n, 'A')])}
      <text x={r} y={r + 4} textAnchor="middle" fontSize={10} fill="var(--color-fg-3)">{code ?? '—'}</text>
    </svg>
  )
}

function LoudnessBlock({ l }: { l: LoudnessReport }) {
  const targets = [
    { name: 'Spotify / YouTube', lufs: -14 },
    { name: 'Apple Music', lufs: -16 },
  ]
  const f = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '—')
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(74px,1fr))] gap-3">
        <div data-help="Integrated loudness over the whole file (gated, BS.1770)"><div className="label">Integrated</div><div className="num text-[18px] leading-tight">{f(l.integrated)}</div><div className="text-[10px] text-fg-3">LUFS</div></div>
        <div data-help="4× oversampled true peak"><div className="label">True peak</div><div className={`num text-[18px] leading-tight ${l.truePeak > -1 ? 'text-rec' : ''}`}>{f(l.truePeak)}</div><div className="text-[10px] text-fg-3">dBTP</div></div>
        <div data-help="Loudness range (EBU Tech 3342): how much the short-term loudness varies"><div className="label">Range</div><div className="num text-[18px] leading-tight">{f(l.lra)}</div><div className="text-[10px] text-fg-3">LU</div></div>
      </div>
      {targets.map((t) => {
        const d = l.integrated - t.lufs
        return (
          <div key={t.name} className="flex items-center justify-between rounded-[4px] bg-ink-0 px-2 py-[5px] text-[11px]">
            <span className="text-fg-2">{t.name} <span className="num text-fg-3">{t.lufs} LUFS</span></span>
            <span className={`num ${Math.abs(d) < 1 ? 'text-ok' : 'text-fg-2'}`}>
              {!Number.isFinite(d) ? '—' : Math.abs(d) < 1 ? 'on target' : d > 0 ? `turned down ${d.toFixed(1)} dB` : `${(-d).toFixed(1)} dB quieter`}
            </span>
          </div>
        )
      })}
      {l.truePeak > -1 && <p className="text-[11px] text-rec">True peak above −1 dBTP: lossy encoding may clip. Lower the limiter ceiling.</p>}
    </div>
  )
}

function StemsCard({ assetId, caps }: { assetId: string | null; caps: api.Capabilities | null | undefined }) {
  const project = useProject((st) => st.project)
  const jobs = useJobs((st) => st.jobs)
  const [model, setModel] = useState('')
  const [recent, setRecent] = useState<api.Job[]>([])
  const [starting, setStarting] = useState(false)
  const models = caps?.stems.models ?? []
  useEffect(() => { if (!model) setModel(models.find((m) => m.available)?.id ?? '') }, [models, model])
  const current = Object.values(jobs).filter((j) => j.kind === 'stems' && j.assetId === assetId).sort((a, b) => b.created - a.created)[0]
  const running = current && (current.status === 'queued' || current.status === 'running')
  const refresh = () => { if (caps) void api.listJobs('stems').then(setRecent) }
  useEffect(refresh, [caps, current?.status])
  const resultAssets = (current?.resultAssets ?? []).map((id) => project.assets[id]).filter(Boolean)

  const start = async () => {
    if (!assetId || !model) return
    setStarting(true)
    try { await startStems(assetId, model) } catch (e) { toast(`Separation failed to start: ${(e as Error).message}`, 'warn') } finally { setStarting(false) }
  }
  const load = async (j: api.Job) => {
    if (!useJobs.getState().jobs[j.id]) {
      useJobs.setState((st) => ({ jobs: { ...st.jobs, [j.id]: { id: j.id, kind: 'stems', assetId: '', source: j.meta?.source ?? 'Stems', model: j.meta?.model ?? '', status: 'done', progress: 1, message: 'Done', created: (j.created ?? 0) * 1000 } } }))
    }
    const got = await importStems(j.id, j.result)
    if (got.length) addStemsAsTracks(got, useJobs.getState().jobs[j.id]?.assetId ?? '')
  }

  if (!caps)
    return (
      <Card title="Stem separation" className="min-w-[280px] flex-1">
        <p className="text-[11px] leading-[16px] text-fg-3">
          Stem separation runs on the Python backend. Start it, then install an engine: <span className="num text-fg-2">pip install demucs</span> (uses the GPU on Apple Silicon and NVIDIA, CPU otherwise). Without one, the built-in quick split still works.
        </p>
      </Card>
    )
  const eng = caps.stems.engines
  return (
    <Card title="Stem separation" className="min-w-[300px] flex-1">
      <div className="text-[10px] text-fg-3">
        Engine <span className="text-fg-2">{caps.stems.engine}</span> · {caps.stems.gpu ? <span className="text-ok">{caps.stems.gpu}</span> : 'CPU'}
        {!eng.demucs && <> · <span className="text-warn">for Demucs run <span className="num">pip install demucs</span> and restart the backend</span></>}
      </div>
      <div className="flex max-h-[168px] flex-col gap-[2px] overflow-y-auto" role="radiogroup">
        {models.map((m) => (
          <label key={m.id} className={`flex cursor-pointer gap-2 rounded-[5px] px-2 py-[4px] ${model === m.id ? 'bg-ink-3' : 'hover:bg-ink-2'} ${m.available ? '' : 'opacity-45'}`} data-help={m.note}>
            <input type="radio" name="stem-model" className="mt-[3px] accent-[var(--color-tape)]" checked={model === m.id} disabled={!m.available} onChange={() => setModel(m.id)} />
            <span className="min-w-0">
              <span className="block text-[12px]">{m.label}</span>
              <span className="block text-[10px] leading-[13px] text-fg-3">{m.stems.join(' · ')}{m.available ? '' : ` · needs pip install ${m.engine}`}</span>
            </span>
          </label>
        ))}
      </div>
      <button className="btn btn-accent" disabled={!assetId || !model || running || starting} onClick={() => void start()}>
        <Icon name="layers" size={13} /> {running ? 'Separating…' : 'Separate stems'}
      </button>
      {current && (
        <div className="flex flex-col gap-1">
          <div className="h-[5px] overflow-hidden rounded-full bg-ink-0"><div className={`h-full ${current.status === 'error' ? 'bg-rec' : 'bg-tape'}`} style={{ width: `${Math.round(current.progress * 100)}%` }} /></div>
          <div className="text-[10px] text-fg-3">{current.message}</div>
        </div>
      )}
      {current?.status === 'done' && (
        resultAssets.length ? (
          <div className="flex flex-col gap-1">
            {resultAssets.map((a) => <div key={a.id} className="truncate text-[11px] text-fg-2">{a.name}</div>)}
            <button className="btn mt-1" onClick={() => addStemsAsTracks(resultAssets, assetId!)} data-help="One audio track per stem, aligned (and warped) exactly like the source clip">
              <Icon name="plus" size={13} /> Add stems as tracks
            </button>
          </div>
        ) : (
          <button className="btn" onClick={() => void importStems(current.id)}><Icon name="download" size={13} /> Load stems into the project</button>
        )
      )}
      {recent.filter((j) => j.status === 'done').length > 0 && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-fg-2" data-help="Every finished separation stays on the backend; load any of them again">Recent separations ({recent.filter((j) => j.status === 'done').length})</summary>
          <div className="mt-1 flex flex-col gap-1">
            {recent.filter((j) => j.status === 'done').slice(0, 12).map((j) => (
              <div key={j.id} className="flex items-center gap-2 rounded-[4px] bg-ink-0 px-2 py-1">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-fg-2">{j.meta?.source}</div>
                  <div className="num text-[9px] text-fg-3">{j.meta?.model} · {j.result?.stems.length} stems · {new Date((j.created ?? 0) * 1000).toLocaleString()}</div>
                </div>
                <button className="btn h-[20px] px-2 text-[10px]" onClick={() => void load(j)} data-help="Download these stems and add them as tracks">Load</button>
              </div>
            ))}
          </div>
        </details>
      )}
    </Card>
  )
}

export function Analysis() {
  const project = useProject((s) => s.project)
  const assetId = useUI((s) => s.analysisAsset)
  const assets = Object.values(project.assets)
  const asset: AssetMeta | undefined = assetId ? project.assets[assetId] : undefined
  const [res, setRes] = useState<A | null>(assetId ? analysisCache.get(assetId) ?? null : null)
  const [busy, setBusy] = useState(false)
  const [caps, setCaps] = useState<api.Capabilities | null | undefined>(undefined)
  const [mix, setMix] = useState<LoudnessReport | null>(null)
  const [mixBusy, setMixBusy] = useState(false)

  useEffect(() => { setRes(assetId ? analysisCache.get(assetId) ?? null : null) }, [assetId])
  useEffect(() => { void api.capabilities(true).then(setCaps) }, [])

  const run = async () => {
    if (!assetId) return
    setBusy(true)
    try { setRes(await analyzeAsset(assetId)) } finally { setBusy(false) }
  }

  const projCode = camelot(project.key.root, project.key.scale !== 'major' && project.key.scale !== 'mixolydian' && project.key.scale !== 'majorPent')
  const projMinor = projCode.endsWith('A')
  // key match: compare relative-major roots so minor↔major pairs aren't penalised
  const shift = res ? semitoneShift(res.minor ? (res.keyRoot + 3) % 12 : res.keyRoot, projMinor ? (project.key.root + 3) % 12 : project.key.root) : 0
  const ratio = res && res.bpm ? project.bpm / res.bpm : 1
  const clipsUsing = project.tracks.flatMap((t) => t.clips).filter((c) => c.kind === 'audio' && c.assetId === assetId)

  const doSync = async () => {
    if (!assetId) return
    setBusy(true)
    try {
      await syncToTempo(assetId)
      // key: key-locked transpose on the synced clips
      if (shift && res) edit((p) => { for (const t of p.tracks) for (const c of t.clips) if (c.kind === 'audio' && c.assetId === assetId) c.transpose = shift })
    } finally { setBusy(false) }
  }
  const doWarpCopy = async () => {
    if (!assetId || !res) return
    setBusy(true)
    try {
      const a = await warpAsset(assetId, ratio, shift)
      toast(`Rendered ${a.name}. It's in the browser; drag it onto a track.`, 'ok')
    } catch (e) {
      toast(`Render failed: ${(e as Error).message}`, 'warn')
    } finally { setBusy(false) }
  }

  return (
    <div className="flex h-full min-h-0 gap-3 overflow-x-auto bg-ink-0 p-3">
      {/* source */}
      <Card title="Source" className="w-[210px] shrink-0">
        <select id="analysis-source" className="field w-full" value={assetId ?? ''} onChange={(e) => setUI({ analysisAsset: e.target.value || null })}>
          <option value="">Choose audio…</option>
          {assets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        {asset && <div className="num text-[10px] text-fg-3">{asset.duration.toFixed(2)} s · {asset.sampleRate} Hz · {asset.channels} ch{asset.bpm ? ` · ${asset.bpm} BPM` : ''}</div>}
        <button className="btn btn-accent" disabled={!assetId || busy} onClick={() => void run()}>
          <Icon name="spark" size={13} /> {busy ? 'Working…' : 'Analyze'}
        </button>
        <div className="mt-auto rounded-[5px] bg-ink-0 p-2 text-[10px] leading-[15px] text-fg-3">
          {caps === undefined ? 'Checking for the Python backend…' : caps ? (
            <>Backend online · analysis <span className="text-fg-2">{caps.analysis}</span> · warp <span className="text-fg-2">{caps.warp}</span> · FFmpeg <span className="text-fg-2">{caps.formats?.ffmpeg ? 'yes' : 'no'}</span></>
          ) : (
            <>Backend offline: tempo, key and loudness run in the browser. Stems, pitch correction and exotic formats need the backend.</>
          )}
        </div>
      </Card>

      {/* tempo + key */}
      <Card title="Tempo & key" className="min-w-[360px] flex-[1.3]">
        {!res ? (
          <p className="text-[12px] text-fg-3">{assetId ? 'Run Analyze to detect tempo, key and loudness.' : 'Pick an audio file, a recording, or a stem.'}</p>
        ) : (
          <div className="flex gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div>
                <div className="label">Tempo</div>
                <div className="num text-[26px] leading-tight">{res.bpm.toFixed(1)}<span className="ml-1 text-[11px] text-fg-3">BPM</span></div>
                <Confidence v={res.bpmConfidence} label="Tempo" />
                <div className="mt-1 flex gap-1">
                  <button className="btn h-[22px] px-2 text-[10px]" onClick={() => edit((p) => { p.bpm = tidyBpm(res.bpm) })} data-help="Set the project tempo to this file's tempo">Use as project tempo</button>
                  <button className="btn btn-ghost h-[22px] px-2 text-[10px]" onClick={() => setRes({ ...res, bpm: res.bpm * 2 })} data-help="Octave errors are common: double">×2</button>
                  <button className="btn btn-ghost h-[22px] px-2 text-[10px]" onClick={() => setRes({ ...res, bpm: res.bpm / 2 })} data-help="Octave errors are common: halve">÷2</button>
                </div>
              </div>
              <div>
                <div className="label">Key</div>
                <div className="text-[18px] leading-tight">{res.keyLabel} <span className="num text-[14px] text-tape">{res.camelot}</span></div>
                <Confidence v={res.keyConfidence} label="Key" />
                <button className="btn mt-1 h-[22px] px-2 text-[10px]" onClick={() => edit((p) => { p.key = { root: res.keyRoot, scale: res.minor ? 'minor' : 'major' } })} data-help="Set the project key (drives scale lock and chord stamps)">Use as project key</button>
              </div>
              <div className="text-[10px] text-fg-3">via {res.engine === 'librosa' ? 'librosa (backend)' : 'in-browser estimate'}</div>
            </div>
            <CamelotWheel code={res.camelot} project={projCode} size={160} />
          </div>
        )}
        {res && (
          <div className="flex flex-col gap-2 rounded-[5px] bg-ink-0 p-2">
            <div className="text-[11px] leading-[16px] text-fg-2">
              Match to project: <span className="num text-fg">{((ratio - 1) * 100).toFixed(1)}%</span> tempo, <span className="num text-fg">{shift > 0 ? '+' : ''}{shift} st</span>
              <span className="text-[10px] text-fg-3"> · {camelotNeighbours(projCode).includes(res.camelot) ? 'already harmonically compatible' : `${res.camelot} → ${projCode}`}</span>
            </div>
            <div className="flex flex-wrap gap-1">
              <button className="btn btn-accent h-[24px] px-2 text-[11px]" disabled={busy || !clipsUsing.length} onClick={() => void doSync()} data-help={clipsUsing.length ? 'Warp every clip of this file to the project tempo, start them on the first downbeat, and transpose to the project key (key-locked). Follows later tempo changes.' : 'Put this file on a track first'}>
                Sync clips to project
              </button>
              <button className="btn h-[24px] px-2 text-[11px]" disabled={!caps || busy} onClick={() => void doWarpCopy()} data-help={caps ? 'Render a separate time-stretched, pitch-shifted copy on the backend (Rubber Band when installed)' : 'Needs the Python backend'}>
                Render warped copy
              </button>
            </div>
          </div>
        )}
      </Card>

      {/* loudness */}
      <Card title="Loudness" className="min-w-[270px] flex-1">
        {res ? <LoudnessBlock l={res.loudness} /> : <p className="text-[12px] text-fg-3">Measured per ITU-R BS.1770 / EBU R128 when you analyze.</p>}
        <div className="mt-auto border-t border-line-soft pt-2">
          <button className="btn w-full" disabled={mixBusy} onClick={async () => { setMixBusy(true); try { setMix((await analyzeMix()).report) } finally { setMixBusy(false) } }} data-help="Render the whole arrangement offline and measure it">
            <Icon name="layers" size={13} /> {mixBusy ? 'Rendering mix…' : 'Measure the full mix'}
          </button>
          {mix && <div className="mt-2"><LoudnessBlock l={mix} /></div>}
        </div>
      </Card>

      <StemsCard assetId={assetId} caps={caps} />
    </div>
  )
}
