"""Offline pitch correction that runs on the CPU.

The chain mirrors how hardware/plugin tuners work (Auto-Tune, Graillon, the zita-at1 core of
x42-autotune), but offline so it can use better, slower analysis:

1. **Detect** the vocal's pitch every 5 ms.
   * `pyin`  — probabilistic YIN from librosa. Always available, CPU only.
   * `crepe` — torchcrepe's *tiny* model on the CPU (`pip install torchcrepe`). Better on breathy or noisy takes.
   * `pesto` — PESTO, a very small self-supervised pitch model (`pip install pesto-pitch`). Fast on CPU.
2. **Decide the target note.** A median-filtered “note centre” is snapped to the nearest note of the
   key, with hysteresis so it doesn't flicker between two notes.
3. **Correct**, moving each frame by `amount × (target − centre)`, smoothed by the retune speed.
   Because the correction is computed from the note centre, vibrato and scoops survive unless
   humanize is 0 and retune speed is 0 (the hard, robotic effect).
4. **Resynthesise.**
   * `world` — WORLD vocoder (`pip install pyworld`): keeps the spectral envelope, so formants
     don't move. Best quality for solo vocals.
   * `psola` — Praat's overlap-add PSOLA via parselmouth (`pip install praat-parselmouth`). Very natural
     for small corrections.
   * `shift` — librosa pitch-shifting per note segment with crossfades. Always available, the most artefacts.

Input should be a solo, dry-ish vocal or monophonic instrument. Stereo input is folded to mono and
the result is returned in stereo (same signal on both sides).
"""
from __future__ import annotations

import importlib.util
from math import gcd

import numpy as np
from scipy.ndimage import median_filter
from scipy.signal import resample_poly

HOP = 0.005  # seconds

DETECTORS = [
    {"id": "pyin", "label": "pYIN (librosa)", "module": "librosa", "note": "Reliable default, CPU only."},
    {"id": "crepe", "label": "CREPE tiny (torchcrepe)", "module": "torchcrepe", "note": "Neural; better on breathy or noisy takes. Needs torch."},
    {"id": "pesto", "label": "PESTO", "module": "pesto", "note": "Tiny self-supervised model, fast on CPU. Needs torch."},
]
SYNTHS = [
    {"id": "world", "label": "WORLD vocoder", "module": "pyworld", "note": "Keeps formants; best for solo vocals."},
    {"id": "psola", "label": "PSOLA (Praat)", "module": "parselmouth", "note": "Most natural for small corrections."},
    {"id": "shift", "label": "Segment pitch-shift (librosa)", "module": "librosa", "note": "Always available; more artefacts."},
]


def _has(mod: str) -> bool:
    try:
        return importlib.util.find_spec(mod) is not None
    except Exception:
        return False


def capabilities() -> dict:
    return {
        "detectors": [{k: d[k] for k in ("id", "label", "note")} | {"available": _has(d["module"])} for d in DETECTORS],
        "synths": [{k: s[k] for k in ("id", "label", "note")} | {"available": _has(s["module"])} for s in SYNTHS],
    }


def _resample(x: np.ndarray, sr: int, target: int) -> np.ndarray:
    if sr == target:
        return x
    g = gcd(sr, target)
    return resample_poly(x, target // g, sr // g).astype(np.float32)


def _to_grid(t_src: np.ndarray, f0: np.ndarray, voiced: np.ndarray, n: int) -> tuple[np.ndarray, np.ndarray]:
    """Resample a pitch track onto the 5 ms grid (nearest for voicing, linear for Hz)."""
    t = np.arange(n) * HOP
    v = np.interp(t, t_src, voiced.astype(float)) > 0.5
    f = np.interp(t, t_src, np.where(voiced, f0, np.nan))
    # fill unvoiced gaps in the source before interpolation so edges don't blend to NaN
    good = np.isfinite(f)
    if good.any():
        f[~good] = np.interp(np.flatnonzero(~good), np.flatnonzero(good), f[good])
    return np.where(v, f, 0.0), v


def detect(mono: np.ndarray, sr: int, method: str, job=None) -> tuple[np.ndarray, np.ndarray]:
    n = int(len(mono) / sr / HOP) + 1
    if method == "pyin":
        import librosa

        x = _resample(mono, sr, 22050)
        hop = 220  # 10 ms, then interpolated to 5 ms
        f0, vflag, _ = librosa.pyin(x, fmin=65.0, fmax=1100.0, sr=22050, frame_length=2048, hop_length=hop)
        t = np.arange(len(f0)) * hop / 22050
        return _to_grid(t, np.nan_to_num(f0), vflag & np.isfinite(f0), n)
    if method == "crepe":
        import torch
        import torchcrepe

        x = torch.tensor(_resample(mono, sr, 16000))[None]
        pitch, per = torchcrepe.predict(x, 16000, hop_length=160, fmin=50, fmax=1100, model="tiny", batch_size=512,
                                        device="cpu", return_periodicity=True)
        per = torchcrepe.filter.median(per, 3)
        pitch, per = pitch[0].numpy(), per[0].numpy()
        t = np.arange(len(pitch)) * 0.01
        return _to_grid(t, pitch, per > 0.45, n)
    if method == "pesto":
        import pesto
        import torch

        x = torch.tensor(_resample(mono, sr, 16000))
        out = pesto.predict(x, 16000, step_size=10.0)
        ts, pitch, conf = (np.asarray(o.detach().cpu() if hasattr(o, "detach") else o).squeeze() for o in out[:3])
        if ts.max() > len(mono) / sr * 10:  # milliseconds
            ts = ts / 1000.0
        return _to_grid(ts, pitch, conf > 0.6, n)
    raise ValueError(f"Unknown pitch detector “{method}”")


def plan(f0: np.ndarray, voiced: np.ndarray, root: int, steps: list[int], speed_ms: float, amount: float, humanize: float) -> dict:
    """Work out target notes and the corrected pitch curve (all in MIDI note numbers)."""
    midi = np.where(voiced, 69 + 12 * np.log2(np.maximum(f0, 1e-6) / 440.0), np.nan)
    allowed = np.array(sorted({(root + s) % 12 for s in steps})) if steps else np.arange(12)
    w = max(1, int((0.02 + 0.22 * humanize) / HOP)) | 1
    filled = midi.copy()
    good = np.isfinite(filled)
    if good.any():
        filled[~good] = np.interp(np.flatnonzero(~good), np.flatnonzero(good), filled[good])
    else:
        filled[:] = 60
    centre = median_filter(filled, size=w, mode="nearest")

    def snap(m: float) -> float:
        base = np.floor(m / 12) * 12
        cands = np.concatenate([allowed + base - 12, allowed + base, allowed + base + 12])
        return float(cands[np.argmin(np.abs(cands - m))])

    target = np.full_like(centre, np.nan)
    prev = None
    for i in range(len(centre)):
        if not voiced[i]:
            prev = None
            continue
        s = snap(centre[i])
        if prev is not None and s != prev and abs(centre[i] - prev) < 0.62:
            s = prev  # hysteresis: stay on the current note until clearly past the midpoint
        target[i] = prev = s

    corr = np.where(voiced, target - centre, 0.0)
    smooth = np.zeros_like(corr)
    a = np.exp(-HOP / (speed_ms / 1000.0)) if speed_ms > 0 else 0.0
    state = 0.0
    for i in range(len(corr)):
        if not voiced[i]:
            state = 0.0
            continue
        if i == 0 or not voiced[i - 1]:
            state = corr[i] * (1.0 if a == 0 else 0.0)  # notes start uncorrected and glide in at the retune speed
        state = a * state + (1 - a) * corr[i]
        smooth[i] = state
    out = np.where(voiced, midi + amount * smooth, np.nan)
    return {"midi": midi, "target": target, "out": out, "shift": np.where(voiced, amount * smooth, 0.0)}


def _synth_world(x: np.ndarray, sr: int, ratio: np.ndarray) -> np.ndarray:
    import pyworld as pw

    xd = x.astype(np.float64)
    f0, t = pw.dio(xd, sr, f0_floor=60.0, f0_ceil=1100.0, frame_period=HOP * 1000)
    f0 = pw.stonemask(xd, f0, t, sr)
    sp = pw.cheaptrick(xd, f0, t, sr)
    ap = pw.d4c(xd, f0, t, sr)
    r = np.interp(t, np.arange(len(ratio)) * HOP, ratio)
    y = pw.synthesize(f0 * r, sp, ap, sr, HOP * 1000)
    return y[: len(x)].astype(np.float32) if len(y) >= len(x) else np.pad(y, (0, len(x) - len(y))).astype(np.float32)


def _synth_psola(x: np.ndarray, sr: int, f0: np.ndarray, voiced: np.ndarray, ratio: np.ndarray) -> np.ndarray:
    import parselmouth
    from parselmouth.praat import call

    snd = parselmouth.Sound(x.astype(np.float64), sampling_frequency=sr)
    manip = call(snd, "To Manipulation", 0.01, 60, 1100)
    tier = call("Create PitchTier", "tuned", 0.0, snd.duration)
    for i in range(0, len(f0), 2):  # 10 ms points are plenty for PSOLA
        if voiced[i] and f0[i] > 0:
            call(tier, "Add point", i * HOP, float(f0[i] * ratio[i]))
    call([tier, manip], "Replace pitch tier")
    out = call(manip, "Get resynthesis (overlap-add)")
    y = np.asarray(out.values[0], dtype=np.float32)
    return y[: len(x)] if len(y) >= len(x) else np.pad(y, (0, len(x) - len(y)))


def _synth_shift(x: np.ndarray, sr: int, shift: np.ndarray, voiced: np.ndarray) -> np.ndarray:
    import librosa

    y = x.copy()
    fade = int(0.012 * sr)
    i = 0
    n = len(shift)
    while i < n:
        if not voiced[i]:
            i += 1
            continue
        j = i
        while j < n and voiced[j] and abs(shift[j] - shift[i]) < 0.08:
            j += 1
        st = float(np.median(shift[i:j]))
        a, b = int(i * HOP * sr), min(len(x), int(j * HOP * sr))
        if abs(st) > 0.03 and b - a > fade * 2:
            pad = fade
            seg = x[max(0, a - pad): min(len(x), b + pad)]
            moved = librosa.effects.pitch_shift(seg, sr=sr, n_steps=st)
            off = a - max(0, a - pad)
            moved = moved[off: off + (b - a)]
            ramp = np.ones(b - a, dtype=np.float32)
            ramp[:fade] = np.linspace(0, 1, fade)
            ramp[-fade:] = np.linspace(1, 0, fade)
            y[a:b] = y[a:b] * (1 - ramp) + moved[: b - a] * ramp
        i = j
    return y


def tune(y: np.ndarray, sr: int, root: int, steps: list[int], speed_ms: float = 40.0, amount: float = 1.0, humanize: float = 0.3,
         detector: str = "pyin", synth: str = "world", job=None) -> tuple[np.ndarray, dict]:
    if sr > 48000:
        y = np.vstack([_resample(c, sr, 48000) for c in np.atleast_2d(y)])
        sr = 48000
    mono = np.atleast_2d(y).mean(axis=0).astype(np.float32)
    if job:
        job.update(0.05, f"Detecting pitch with {detector}…")
    f0, voiced = detect(mono, sr, detector, job)
    if not voiced.any():
        raise RuntimeError("No pitched sound was found. Pitch correction needs a solo vocal or instrument.")
    if job:
        job.update(0.45, "Planning notes…")
    p = plan(f0, voiced, root, steps, speed_ms, amount, humanize)
    ratio = np.power(2.0, p["shift"] / 12.0)
    if job:
        job.update(0.55, f"Resynthesising with {synth}…")
    if synth == "world":
        out = _synth_world(mono, sr, ratio)
    elif synth == "psola":
        out = _synth_psola(mono, sr, f0, voiced, ratio)
    elif synth == "shift":
        out = _synth_shift(mono, sr, p["shift"], voiced)
    else:
        raise ValueError(f"Unknown resynthesis method “{synth}”")
    peak = float(np.abs(out).max() or 1)
    if peak > 0.99:
        out = out * (0.99 / peak)
    # curves for the UI, thinned to ≤ 3000 points
    step = max(1, len(f0) // 3000)
    sl = slice(None, None, step)
    cents = np.abs(p["shift"][voiced]) * 100
    curves = {
        "hop": HOP * step,
        "detected": [None if not np.isfinite(v) else round(float(v), 3) for v in p["midi"][sl]],
        "corrected": [None if not np.isfinite(v) else round(float(v), 3) for v in p["out"][sl]],
        "target": [None if not np.isfinite(v) else float(v) for v in p["target"][sl]],
    }
    stats = {"voiced": round(float(voiced.mean()), 3), "mean_cents": round(float(cents.mean()), 1), "max_cents": round(float(cents.max()), 1)}
    return np.vstack([out, out]), {"curves": curves, "stats": stats, "sample_rate": sr}
