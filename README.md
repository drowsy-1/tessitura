# Tessitura

A browser DAW built for flow: a linear arranger and a clip launcher over the same tracks, a piano roll with chord stamps and scale lock, a drum step sequencer, a console-style mixer with BS.1770 loudness metering, and a Python backend for tempo/key analysis, Demucs stem separation, CPU pitch correction and FFmpeg format conversion. Imported music locks to the project tempo automatically.

No control in the app is a knob. Everything is a fader, a bar slider, a drag-number field, an XY pad, a draggable curve (EQ, envelope, automation) or a segmented switch, and every one of them supports drag, Shift-for-fine, double-click to reset or type, wheel, and arrow keys.

```
frontend/   Vite + React 19 + TypeScript + Tailwind v4 + zustand
backend/    FastAPI + librosa + pyloudnorm + FFmpeg (+ optional Demucs, WORLD/Praat tuning, audio-separator)
```

## Run it

Requirements: Node 20+, Python 3.10+.

```bash
# backend (terminal 1)
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt   # macOS: run `xcode-select --install` once (pyworld compiles)
uvicorn app.main:app --reload --port 8000

# frontend (terminal 2)
cd frontend
npm install
npm run dev            # http://localhost:5173  (proxies /api to :8000)
```

One-process mode: `cd frontend && npm run build`, then start uvicorn. The backend serves the built UI at http://localhost:8000.

The frontend also runs with no backend at all ("Offline mode" in the status bar): tempo, key and loudness analysis fall back to in-browser estimators and tempo sync still works (it stretches in the browser); stems, pitch correction, formats the browser can't decode and server-side project versions are unavailable.

### Stem separation with Demucs (works on M1/M2/M3 Macs)

```bash
cd backend && source .venv/bin/activate      # Python 3.10+
pip install -r requirements-ml.txt            # = pip install demucs (pulls PyTorch with MPS support)
brew install ffmpeg                           # optional; imageio-ffmpeg is the fallback
uvicorn app.main:app --port 8000              # restart so the new engine is detected
```

The Analysis panel's stem card should then read **Engine demucs · Apple Silicon (MPS)**.

| Model | Stems | Notes |
|---|---|---|
| Demucs · htdemucs | vocals, drums, bass, other | Default. Roughly a minute per song on an M1 GPU (model ≈80 MB, downloaded on first use) |
| Demucs · htdemucs_ft | 4 stems | Fine-tuned bag of 4 models: cleaner, ~4× slower (≈320 MB) |
| Demucs · 6 stems | + guitar, piano | Piano is the weakest stem |
| Demucs · vocals / instrumental | 2 stems | `--two-stems vocals`; `no_vocals` is renamed `instrumental` |
| Ensemble, BS-RoFormer, MDX Kim 2 | 4 / 2 stems | Only with `pip install audio-separator` |
| Quick split (built-in) | 4 stems | HPSS + mid/side masks; instant, lower quality, always available |

How it runs: the backend calls the Demucs CLI in a subprocess (`python -m demucs -n <model> -o <job> --filename {stem}.{ext} --int24`) so a crash can't take the server down, parses its progress bar into the job's progress, and never imports torch itself (the health check stays instant). Demucs 4.1 picks CUDA, then MPS, then CPU on its own; `PYTORCH_ENABLE_MPS_FALLBACK=1` is set so ops the Apple GPU lacks fall back to the CPU, and a failed GPU run (e.g. out of memory on a long song) is retried with `-d cpu`. Force a device with `TESSITURA_DEMUCS_DEVICE=cpu|mps|cuda`.

**Results persist.** Each job lives in `data/jobs/<id>/` with a `job.json`; the job list is reloaded when the backend restarts (jobs that were running are marked interrupted) and served at `GET /api/jobs`. In the browser, jobs live in an app-level store (persisted to localStorage), not in the panel, so switching tabs, closing the dock or reloading the page doesn't drop them, and polling resumes after a reload. **Recent separations** reloads any earlier job's stems.

### Pitch correction on the CPU

```bash
pip install -r backend/requirements-tune.txt   # pyworld + praat-parselmouth
```

Select an audio clip → **Tune…** (or ⌘K → *Pitch-correct selected audio clip*). Pick key/scale, a style (Natural / Tight / Hard tune), retune speed, amount and humanize. The backend:

1. **detects** f0 on a 5 ms grid with pYIN (librosa, default), CREPE-tiny (`torchcrepe`) or PESTO (`pesto-pitch`) — the last two need PyTorch but still run on the CPU;
2. **plans** the target: median-filtered note centres snapped to the scale with hysteresis, a one-pole glide for retune speed, `amount` of the error removed, and `humanize` keeping vibrato/scoops around the corrected centre;
3. **resynthesizes** with the WORLD vocoder (`pyworld`, formant-preserving), Praat PSOLA (`parselmouth`), or librosa per-segment pitch-shift (always available, more artefacts).

The corrected take becomes a new asset; the clip keeps `origAssetId`, so the audio editor's **Tuned / Original** switch A/Bs them and re-tuning always starts from the original. Measured here (2 vCPU cloud box, pYIN): a 32 s vocal took 19 s with PSOLA and 29 s with WORLD.

### Formats and video

Import accepts WAV, AIFF, FLAC, MP3, AAC/M4A, Ogg, Opus, WMA, ALAC, AC-3, AMR, WavPack, APE, CAF, W64, MKA, and video (MP4, MOV, MKV, WebM, AVI, WMV, FLV, MPEG, TS, 3GP, OGV — audio only is kept, named "… (audio)"). The browser's decoder is tried first; anything it can't read, and anything over 250 MB, goes to `POST /api/convert`, which runs FFmpeg (system `ffmpeg`, else the `imageio-ffmpeg` static binary) to a WAV. A video without an audio track returns a clear 415. Upload limit: `TESSITURA_MAX_UPLOAD_MB` (default 2048).

### Tempo sync (warp)

Every audio clip can be **warped**: `clip.warp = { on, bpm }` makes it play at the project tempo with pitch preserved, and follow later tempo changes. With **Sync to tempo on import** (browser panel, on by default) new music is detected and placed on its first downbeat, already warped. Details:

- Tempo from librosa when the backend is up, otherwise an onset-autocorrelation estimate; both rounded to a whole BPM when within 0.25.
- Beat phase is chosen on broadband **plus low-band** (kick/bass) onset energy, so off-beat hi-hats don't put the grid half a beat late; the downbeat is the beat phase with the most low-band attack. A downbeat within 35 ms of the file start is treated as 0.
- Stretching is WSOLA in a Web Worker, cached per (file, ratio). Until the stretch is ready (a fraction of a second) the clip plays varispeed; offline export always waits for it.
- In the audio editor: Warp on/off, the source BPM (×2 / ÷2), beat nudges, Re-detect, and a beat grid over the waveform.

## What's in it

**Arrange** — draw clips with the pencil (drag across a MIDI lane), drag to move (Alt copies, Alt also bypasses snap), trim either edge, drag fade handles on audio clips, split at the playhead (S), duplicate (⌘D), marquee-select, reorder tracks by their colour strip, markers, a loop strip on the ruler, per-track automation lanes (volume, pan, sends, synth cutoff) edited by clicking and dragging points. Drop audio or video files anywhere; music arrives tempo-synced.

**Launch** — Ableton/Bitwig-style session grid on the same tracks. Clips loop until stopped, launch on a beat/bar quantize, scenes launch rows, "Back to arrangement" returns control, and **Commit performance** writes what you just played into the arrangement at the exact beats, trimming whatever was underneath.

**Piano roll** — draw/select/erase tools, chord stamps built from the project key (triad, 7th, sus2, power), scale lock, fold-to-scale, velocity lane, quantize, legato, humanize, fit-to-key, transpose, arrow-key nudging. Drum tracks turn into a step sequencer with named rows.

**Instruments** — two-oscillator subtractive synth (XY filter pad, drag-the-corners ADSR, glide) with presets, and a synthesized 8-voice drum kit with per-voice levels.

**Devices** — EQ (draggable curve), compressor (transfer curve + gain-reduction meter), filter (XY pad), saturator, tempo-synced echo, convolution reverb, and a look-ahead **true-peak limiter** (AudioWorklet, 5 ms look-ahead, 4× oversampled peak detection). Two return buses (Space, Echo) with post-fader sends.

**Mixer** — faders with a console-style taper, stereo peak meters with hold, sends, pan, M/S/arm, and a master strip with momentary/short-term/integrated LUFS and peak, plus streaming targets.

**Analysis & stems** — BPM (beat-tracked, refined by regression through beat times), key with confidence, Camelot code and wheel showing harmonic neighbours, loudness (integrated, true peak, LRA) against Spotify/YouTube −14 and Apple −16, "match to project" tempo/semitone suggestions, **Sync clips to project**, a rendered warp copy, Demucs stem separation with a persistent job history, and "add stems as tracks" aligned (and warped) exactly like the source clip. **Measure the full mix** renders the arrangement offline and meters it.

**Recording** — arm audio tracks to record from the microphone/interface (with output-latency compensation) or MIDI tracks to record from the computer keyboard (`` ` `` toggles it; A–K play), on-screen keys, or any Web MIDI controller.

**Export & projects** — offline WAV render (24-bit, or 16-bit with TPDF dither), per-track stem export, project JSON download/upload, and server-side versioned saves (`data/projects/<name>/versions/v0001.json …`, audio in `assets/`). Set `TESSITURA_GIT=1` to also commit every save into a git repo inside the project folder (use Git LFS for the WAVs).

**Flow aids** — ⌘K command palette for every action (it understands "key f# minor", "tempo 128", "add drums"), a status bar that explains whatever is under the pointer, `?` for the shortcut sheet, undo/redo for every edit (drags collapse into one step; audio is never dropped by undo), and **session restore**: the project JSON autosaves to localStorage and every audio asset is stored in IndexedDB, so a reload reopens the same session with its audio.

## Architecture notes

- **Real-time audio stays in the browser.** Playback, synthesis, mixing, sends and metering run on the Web Audio graph with a 120 ms look-ahead scheduler driven by a Worker clock (so it keeps time in background tabs). Python cannot deliver low-latency audio to a browser tab; it does the offline, compute-heavy work instead.
- **One engine, two contexts.** The same `Engine` class drives the live `AudioContext` and an `OfflineAudioContext` for export, stem export and mix measurement, so what you render is what you heard.
- **Projects are plain JSON** with audio referenced by asset id — easy to diff, script against, or generate from Python.
- **Loudness is implemented twice and cross-checked**: TypeScript (`engine/dsp.ts`) and NumPy (`backend/app/analysis.py`), both BS.1770-4 with K-weighting re-derived for any sample rate; pyloudnorm is used as a third reference when installed.

## Tests

```bash
cd backend && pytest -q
```

Covers every import format through FFmpeg (MP3, Opus, M4A, FLAC, AIFF, Ogg, WMA), audio extraction from MP4 and the silent-video error, the Demucs integration against a stand-in CLI (model list, named stems, two-stem rename, CPU retry, job persistence across restart), pitch correction with each resynthesis engine on a detuned melody (>25 ¢ error before, <12 ¢ after), tempo detection at several BPMs, key detection, loudness against the BS.1770 reference (−20 dBFS stereo sine → −20 LUFS), stems summing back to the mix, warp length, project save/load/versioning, path traversal and bad input handling.

## Honest limitations

- **No VST/AU/CLAP/LV2 plugins.** Browsers can't host native plugins. For third-party plugins, Melodyne/Auto-Tune, or ARA you still need REAPER, Bitwig or Ardour; Tessitura's JSON projects and stem export are the bridge.
- **Demucs wasn't run for real where this was built** (no PyTorch, model hosts blocked). The integration is tested end-to-end against a stand-in `demucs` CLI that mimics 4.1's arguments, output layout and progress output, and the flags were checked against the published 4.1.0 package. First real run on your Mac: expect the model download, then roughly a minute per song for htdemucs.
- **CREPE and PESTO paths are untested** here for the same reason (they need torch). pYIN + WORLD / PSOLA / pitch-shift are tested.
- **Pitch correction is offline and monophonic.** It isn't a live Auto-Tune insert, and it won't correct chords or full mixes.
- **One tempo per clip.** Warp assumes a steady tempo; live recordings that speed up and slow down need warping by ear (tempo maps aren't implemented). Detection can still read double/half time or pick the wrong bar start on sparse material; the editor has ×2/÷2 and beat nudges for that.
- **Browser storage isn't a backup.** Session restore lives in one browser profile; clearing site data erases it. Use Save version.
- **Latency depends on the browser and OS.** Typically 10–40 ms round trip, which is fine for MIDI and overdubs, not for monitoring through effects at 32-sample buffers.
- **Browser-side analysis is an estimate**; the backend's librosa pipeline is more robust. Key detection is wrong a meaningful fraction of the time, so check by ear.
- **The audio-separator path** is written against audio-separator 0.47's documented API and model names, but was not run end-to-end here. The built-in quick split is fully tested.
