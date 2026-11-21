"""Key-locked time-stretch and tempo-locked pitch-shift (for mashups and remixes).

Rubber Band (via pyrubberband) is preferred: it keeps transients and formants better. librosa's
phase vocoder is the fallback; it works everywhere but smears transients at large ratios.
"""
from __future__ import annotations

import shutil

import numpy as np


def engine() -> str:
    try:
        import pyrubberband  # noqa: F401

        return "rubberband" if shutil.which("rubberband") else "librosa"
    except Exception:
        return "librosa"


def warp(y: np.ndarray, sr: int, stretch: float, semitones: float) -> tuple[np.ndarray, str]:
    """`stretch` > 1 speeds up (shorter); `semitones` shifts pitch without changing length."""
    if not (0.25 <= stretch <= 4):
        raise ValueError("Stretch ratio must be between 0.25 and 4")
    if abs(semitones) > 24:
        raise ValueError("Pitch shift must be within ±24 semitones")
    eng = engine()
    chans = []
    for ch in np.atleast_2d(y):
        x = ch.astype(np.float32)
        if eng == "rubberband":
            import pyrubberband as rb

            if abs(stretch - 1) > 1e-4:
                x = rb.time_stretch(x, sr, stretch, rbargs={"--fine": ""})
            if abs(semitones) > 1e-4:
                x = rb.pitch_shift(x, sr, semitones, rbargs={"--formant": ""})
        else:
            import librosa

            if abs(stretch - 1) > 1e-4:
                x = librosa.effects.time_stretch(x, rate=stretch)
            if abs(semitones) > 1e-4:
                x = librosa.effects.pitch_shift(x, sr=sr, n_steps=semitones)
        chans.append(x)
    n = min(len(c) for c in chans)
    return np.vstack([c[:n] for c in chans]), eng
