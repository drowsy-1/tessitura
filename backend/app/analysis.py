"""Tempo, key and loudness analysis.

* Tempo: librosa onset envelope + dynamic-programming beat tracker, refined by a linear fit
  through the beat times; confidence is the share of local tempo estimates within 4 %.
* Key: Krumhansl–Kessler profile correlation against a CQT chromagram of the harmonic component.
* Loudness: ITU-R BS.1770-4 / EBU R128 (integrated, short-term max, loudness range) plus a
  4× oversampled true-peak estimate. pyloudnorm's integrated value is used when installed,
  as a cross-check on our own implementation.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from math import gcd

import numpy as np
from scipy.signal import lfilter, resample_poly

NOTE_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"]
KK_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KK_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
CAMELOT_MAJOR = {11: 1, 6: 2, 1: 3, 8: 4, 3: 5, 10: 6, 5: 7, 0: 8, 7: 9, 2: 10, 9: 11, 4: 12}
CAMELOT_MINOR = {8: 1, 3: 2, 10: 3, 5: 4, 0: 5, 7: 6, 2: 7, 9: 8, 4: 9, 11: 10, 6: 11, 1: 12}


def camelot(root: int, minor: bool) -> str:
    return f"{(CAMELOT_MINOR if minor else CAMELOT_MAJOR)[root]}{'A' if minor else 'B'}"


# ───────────────────────── Loudness ─────────────────────────
def k_weighting(fs: int):
    """BS.1770 pre-filter (high shelf) and RLB high-pass, re-derived for any sample rate."""
    f0, G, Q = 1681.974450955533, 3.999843853973347, 0.7071752369554196
    K = np.tan(np.pi * f0 / fs)
    Vh = 10 ** (G / 20)
    Vb = Vh ** 0.4996667741545416
    a0 = 1 + K / Q + K * K
    b1 = np.array([(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0])
    a1 = np.array([1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0])
    f0, Q = 38.13547087602444, 0.5003270373238773
    K = np.tan(np.pi * f0 / fs)
    a0 = 1 + K / Q + K * K
    b2 = np.array([1.0, -2.0, 1.0])
    a2 = np.array([1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0])
    return (b1, a1), (b2, a2)


def _lufs(e):
    return -0.691 + 10 * np.log10(np.maximum(e, 1e-12))


@dataclass
class Loudness:
    integrated: float
    short_term_max: float
    lra: float
    sample_peak: float
    true_peak: float


def loudness(y: np.ndarray, sr: int) -> Loudness:
    y = np.atleast_2d(y)[:2].astype(np.float64)
    (b1, a1), (b2, a2) = k_weighting(sr)
    w = lfilter(b2, a2, lfilter(b1, a1, y, axis=1), axis=1)
    step = int(round(sr * 0.1))
    n = w.shape[1] // step
    if n < 4:
        integrated = st_max = -np.inf
        lra = 0.0
    else:
        sub = (w[:, : n * step] ** 2).reshape(w.shape[0], n, step).mean(axis=2).sum(axis=0)  # per 100 ms, summed over channels
        mom = np.convolve(sub, np.ones(4) / 4, mode="valid")  # 400 ms blocks, 75 % overlap
        st = np.convolve(sub, np.ones(30) / 30, mode="valid") if n >= 30 else np.array([])
        absg = mom[_lufs(mom) > -70]
        integrated = -np.inf
        if absg.size:
            rel = _lufs(absg.mean()) - 10
            gated = absg[_lufs(absg) > rel]
            if gated.size:
                integrated = float(_lufs(gated.mean()))
        st_max = float(_lufs(st).max()) if st.size else float(_lufs(mom).max())
        lra = 0.0
        st_abs = st[_lufs(st) > -70] if st.size else np.array([])
        if st_abs.size > 2:
            rel = _lufs(st_abs.mean()) - 20
            vals = np.sort(_lufs(st_abs[_lufs(st_abs) > rel]))
            if vals.size > 2:
                lra = float(np.percentile(vals, 95) - np.percentile(vals, 10))
    peak = float(np.abs(y).max()) if y.size else 0.0
    tp = float(np.abs(resample_poly(y, 4, 1, axis=1)).max()) if y.size else 0.0
    try:  # cross-check with pyloudnorm when available
        import pyloudnorm as pyln

        if np.isfinite(integrated):
            integrated = float(pyln.Meter(sr).integrated_loudness(y.T))
    except Exception:
        pass
    db = lambda g: float(20 * np.log10(g)) if g > 0 else float("-inf")  # noqa: E731
    return Loudness(integrated=float(integrated), short_term_max=float(st_max), lra=float(lra), sample_peak=db(peak), true_peak=db(max(tp, peak)))


# ───────────────────────── Tempo & key ─────────────────────────
def tempo(y_mono: np.ndarray, sr: int) -> tuple[float, float, list[float]]:
    """Beat-track, then refine the BPM by a least-squares fit through the beat times.

    librosa's global estimate is quantised to whole autocorrelation lags (e.g. 120 BPM reads as
    117.5 at a 512-sample hop); the slope of beat index vs. beat time is not.
    """
    import librosa

    hop = 256
    onset = librosa.onset.onset_strength(y=y_mono, sr=sr, hop_length=hop)
    bpm0, beats = librosa.beat.beat_track(onset_envelope=onset, sr=sr, hop_length=hop, units="time")
    bpm0 = float(np.atleast_1d(bpm0)[0])
    bpm = bpm0
    if len(beats) >= 8:
        slope = float(np.polyfit(np.arange(len(beats)), beats, 1)[0])
        refined = 60.0 / slope if slope > 0 else bpm0
        if abs(refined / bpm0 - 1) < 0.08:
            bpm = refined
    local = librosa.feature.rhythm.tempo(onset_envelope=onset, sr=sr, hop_length=hop, aggregate=None)
    agree = float(np.mean(np.abs(local / max(bpm, 1e-6) - 1) < 0.04)) if local.size else 0.0
    return round(bpm, 1), agree, [round(float(b), 3) for b in beats[:512]]


def key(y_mono: np.ndarray, sr: int) -> tuple[int, bool, float]:
    import librosa

    harm = librosa.effects.harmonic(y_mono, margin=4)
    chroma = librosa.feature.chroma_cqt(y=harm, sr=sr, bins_per_octave=36).mean(axis=1)
    scores = []
    for root in range(12):
        for minor, prof in ((False, KK_MAJOR), (True, KK_MINOR)):
            r = np.corrcoef(chroma, np.roll(prof, root))[0, 1]
            scores.append((float(np.nan_to_num(r, nan=-1.0)), root, minor))
    scores.sort(reverse=True)
    best, second = scores[0], scores[1]
    conf = float(np.clip((best[0] - second[0]) * 8, 0, 1))
    return best[1], best[2], conf


def analyze(y: np.ndarray, sr: int) -> dict:
    """Full analysis. `y` is (channels, samples) at the file's native rate."""
    mono = np.atleast_2d(y).mean(axis=0)
    # tempo/key on a 22.05 kHz mono copy of (up to) the first 4 minutes
    target = 22050
    g = gcd(target, sr)
    y22 = resample_poly(mono[: sr * 240], target // g, sr // g).astype(np.float32)
    bpm, bpm_conf, beats = tempo(y22, target)
    root, minor, key_conf = key(y22, target)
    loud = loudness(y, sr)
    return {
        "bpm": bpm,
        "bpm_confidence": bpm_conf,
        "beats": beats,
        "key_root": root,
        "minor": minor,
        "key_label": f"{NOTE_NAMES[root]} {'minor' if minor else 'major'}",
        "camelot": camelot(root, minor),
        "key_confidence": key_conf,
        "lufs_integrated": loud.integrated,
        "lufs_short_max": loud.short_term_max,
        "lra": loud.lra,
        "sample_peak": loud.sample_peak,
        "true_peak": loud.true_peak,
        "duration": float(np.atleast_2d(y).shape[1] / sr),
    }


def loudness_dict(y: np.ndarray, sr: int) -> dict:
    return asdict(loudness(y, sr))
