"""Stem separation.

Engines, in order of preference:

* **Demucs** (`pip install demucs`) — Meta's Hybrid Transformer Demucs, run through its own CLI in a
  subprocess. On Apple Silicon it uses the GPU through PyTorch's MPS backend automatically
  (the complex-number FFT steps fall back to the CPU inside Demucs); if MPS fails the job retries
  on the CPU. Works on M1/M2/M3 without CUDA.
* **audio-separator** (`pip install audio-separator`) — BS-RoFormer / MDX checkpoints (the UVR5 models),
  including the RoFormer → Demucs ensemble.
* **Quick split** — always available: harmonic–percussive separation plus mid/side and band masks.
  Lower quality, instant, and its masks sum to one so the stems always add back up to the mix.

Capabilities are detected without importing torch, so the health check stays fast.
"""
from __future__ import annotations

import importlib.util
import os
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np

from . import audio_io
from .jobs import Job

MODELS = [
    {"id": "demucs", "engine": "demucs", "model": "htdemucs", "label": "Demucs · htdemucs", "stems": ["vocals", "drums", "bass", "other"],
     "note": "Fast, good 4-stem split. About a minute per song on an M1 GPU."},
    {"id": "demucs_ft", "engine": "demucs", "model": "htdemucs_ft", "label": "Demucs · htdemucs_ft (best)", "stems": ["vocals", "drums", "bass", "other"],
     "note": "Fine-tuned version: cleaner, about 4× slower than htdemucs."},
    {"id": "demucs_6s", "engine": "demucs", "model": "htdemucs_6s", "label": "Demucs · 6 stems", "stems": ["vocals", "drums", "bass", "guitar", "piano", "other"],
     "note": "Adds guitar and piano stems. Piano is the weakest of the six."},
    {"id": "demucs_vocals", "engine": "demucs", "model": "htdemucs", "two_stems": "vocals", "label": "Demucs · vocals / instrumental",
     "stems": ["vocals", "instrumental"], "note": "Two stems: acapella and backing track."},
    {"id": "ensemble", "engine": "audio-separator", "label": "Ensemble · BS-RoFormer → HTDemucs FT", "stems": ["vocals", "drums", "bass", "other"],
     "files": ["model_bs_roformer_ep_317_sdr_12.9755.ckpt", "htdemucs_ft.yaml"],
     "note": "Best quality with audio-separator: RoFormer for vocals, Demucs FT for the rest."},
    {"id": "bs_roformer", "engine": "audio-separator", "label": "BS-RoFormer · vocals / instrumental", "stems": ["vocals", "instrumental"],
     "files": ["model_bs_roformer_ep_317_sdr_12.9755.ckpt"], "note": "Cleanest vocal isolation (audio-separator)."},
    {"id": "mdx_kim2", "engine": "audio-separator", "label": "MDX-Net · Kim Vocal 2", "stems": ["vocals", "instrumental"],
     "files": ["Kim_Vocal_2.onnx"], "note": "Fast acapellas (audio-separator)."},
    {"id": "hpss", "engine": "builtin", "label": "Quick split (built-in, no ML)", "stems": ["vocals", "drums", "bass", "other"],
     "note": "Harmonic/percussive + mid/side masks. Instant and always available, but audibly lower quality."},
]


def _has(mod: str) -> bool:
    try:
        return importlib.util.find_spec(mod) is not None
    except Exception:
        return False


def engines() -> dict[str, bool]:
    return {"demucs": _has("demucs"), "audio-separator": _has("audio_separator"), "builtin": True}


def accelerator() -> str | None:
    """Best guess at the GPU the ML engines will use, without importing torch."""
    if sys.platform == "darwin" and platform.machine() == "arm64":
        return "Apple Silicon (MPS)"
    if shutil.which("nvidia-smi"):
        return "NVIDIA (CUDA)"
    return None


def capabilities() -> dict:
    avail = engines()
    best = "demucs" if avail["demucs"] else "audio-separator" if avail["audio-separator"] else "hpss-fallback"
    return {
        "engine": best,
        "engines": avail,
        "gpu": accelerator() if best != "hpss-fallback" else None,
        "models": [
            {"id": m["id"], "label": m["label"], "stems": m["stems"], "note": m["note"], "engine": m["engine"], "available": avail[m["engine"]]}
            for m in MODELS
        ],
    }


def separate(src: Path, out: Path, model_id: str, job: Job) -> list[tuple[str, Path]]:
    out.mkdir(parents=True, exist_ok=True)
    model = next((m for m in MODELS if m["id"] == model_id), None)
    if model is None:
        raise ValueError(f"Unknown model “{model_id}”")
    if not engines()[model["engine"]]:
        raise RuntimeError(f"{model['label']} needs `{'pip install demucs' if model['engine'] == 'demucs' else 'pip install audio-separator'}` on the backend")
    # every engine gets a clean 44.1 kHz stereo WAV, whatever the upload was (MP3, Opus, video…)
    job.update(0.01, "Decoding the upload…")
    wav = out / "_input.wav"
    y, sr = audio_io.load(src, sr=44100)
    if y.shape[0] == 1:
        y = np.vstack([y, y])
    audio_io.save_wav(wav, y[:2], sr)
    try:
        if model["engine"] == "demucs":
            stems = _separate_demucs(wav, out, model, job)
        elif model["engine"] == "audio-separator":
            stems = _separate_audio_separator(wav, out, model, job)
        else:
            stems = _separate_hpss(wav, out, job)
    finally:
        wav.unlink(missing_ok=True)
    missing = [n for n, p in stems if not p.exists() or p.stat().st_size < 1000]
    if missing or not stems:
        raise RuntimeError(f"The separator finished but these stems are missing: {', '.join(missing) or 'all'}")
    return stems


# ───────────────────────── Demucs ─────────────────────────
_PCT = re.compile(r"(\d{1,3})%\|")


def _run_demucs(cmd: list[str], job: Job, p0: float, p1: float) -> tuple[int, list[str]]:
    env = {**os.environ, "PYTORCH_ENABLE_MPS_FALLBACK": "1"}
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, env=env)
    tail: list[str] = []
    assert proc.stdout is not None
    for line in proc.stdout:  # text mode turns tqdm's \r updates into lines
        line = line.strip()
        if not line:
            continue
        tail = (tail + [line])[-20:]
        m = _PCT.search(line)
        if m:
            job.update(p0 + (p1 - p0) * int(m.group(1)) / 100, f"Separating… {m.group(1)}%")
        elif "download" in line.lower():
            job.update(None, "Downloading the model (first run only)…")
        elif line.startswith("Selected model"):
            job.update(None, line)
    return proc.wait(), tail


def _separate_demucs(wav: Path, out: Path, model: dict, job: Job) -> list[tuple[str, Path]]:
    dest = out / "demucs"
    base = [sys.executable, "-m", "demucs", "-n", model["model"], "-o", str(dest), "--filename", "{stem}.{ext}", "--int24"]
    if model.get("two_stems"):
        base += ["--two-stems", model["two_stems"]]
    forced = os.environ.get("TESSITURA_DEMUCS_DEVICE")  # e.g. "cpu" to skip the GPU entirely
    attempts = [["-d", forced]] if forced else [[], ["-d", "cpu"]]
    tail: list[str] = []
    for i, dev in enumerate(attempts):
        job.update(0.03, "Loading Demucs…" if i == 0 else "GPU run failed; retrying on the CPU…")
        code, tail = _run_demucs(base + dev + [str(wav)], job, 0.05, 0.95)
        folder = dest / model["model"]
        files = sorted(folder.glob("*.wav")) if folder.exists() else []
        if code == 0 and files:
            result = []
            for f in files:
                name = {"no_vocals": "instrumental"}.get(f.stem, f.stem)
                target = out / f"{name}.wav"
                shutil.move(str(f), target)
                result.append((name, target))
            shutil.rmtree(dest, ignore_errors=True)
            order = {s: k for k, s in enumerate(model["stems"])}
            return sorted(result, key=lambda r: order.get(r[0], 99))
    raise RuntimeError("Demucs failed: " + " | ".join(tail[-4:]))


# ───────────────────────── audio-separator ─────────────────────────
def _stem_name(path: str) -> str:
    m = re.findall(r"\(([^)]+)\)", Path(path).stem)
    return (m[-1] if m else Path(path).stem).lower()


def _audio_sep_pass(src: Path, out: Path, model_file: str, job: Job, p0: float, p1: float) -> dict[str, Path]:
    from audio_separator.separator import Separator

    job.update(p0, f"Loading {model_file} (first use downloads the checkpoint)…")
    sep = Separator(output_dir=str(out), output_format="WAV", model_file_dir=str(Path.home() / ".cache" / "tessitura-models"))
    sep.load_model(model_filename=model_file)
    job.update(p0 + (p1 - p0) * 0.15, f"Separating with {model_file}…")
    files = sep.separate(str(src))
    job.update(p1)
    return {_stem_name(f): out / Path(f).name for f in files}


def _separate_audio_separator(wav: Path, out: Path, model: dict, job: Job) -> list[tuple[str, Path]]:
    if model["id"] == "ensemble":
        first = _audio_sep_pass(wav, out / "pass1", model["files"][0], job, 0.02, 0.5)
        vocals = first.get("vocals")
        inst = first.get("instrumental") or next((p for k, p in first.items() if k != "vocals"), None)
        if not vocals or not inst:
            raise RuntimeError("Pass 1 did not return vocals and instrumental")
        second = _audio_sep_pass(inst, out / "pass2", model["files"][1], job, 0.5, 0.97)
        stems = {"vocals": vocals, **{k: v for k, v in second.items() if k != "vocals"}}
    else:
        stems = _audio_sep_pass(wav, out, model["files"][0], job, 0.02, 0.97)
    final: list[tuple[str, Path]] = []
    for name, path in stems.items():
        dest = out / f"{name}.wav"
        if path != dest:
            shutil.move(str(path), dest)
        final.append((name, dest))
    for d in ("pass1", "pass2"):
        shutil.rmtree(out / d, ignore_errors=True)
    return final


# ───────────────────────── Built-in quick split ─────────────────────────
def _separate_hpss(src: Path, out: Path, job: Job) -> list[tuple[str, Path]]:
    import librosa

    job.update(0.05, "Quick split: loading audio…")
    y, sr = audio_io.load(src)
    if y.shape[0] == 1:
        y = np.vstack([y, y])
    L, R = y[0], y[1]
    n_fft, hop = 4096, 1024
    SL = librosa.stft(L, n_fft=n_fft, hop_length=hop)
    SR = librosa.stft(R, n_fft=n_fft, hop_length=hop)
    M = (SL + SR) / 2
    S = (SL - SR) / 2
    job.update(0.3, "Quick split: harmonic / percussive separation…")
    H, P = librosa.decompose.hpss(np.abs(M), margin=(1.0, 2.0), power=2.0)
    eps = 1e-10
    m_perc = P**2 / (H**2 + P**2 + eps)
    m_harm = 1 - m_perc
    freqs = librosa.fft_frequencies(sr=sr, n_fft=n_fft)[:, None]
    low = 1 / (1 + (freqs / 160.0) ** 8)
    band = (1 / (1 + (180.0 / np.maximum(freqs, 1)) ** 8)) * (1 / (1 + (freqs / 7000.0) ** 6))
    center = np.abs(M) ** 2 / (np.abs(M) ** 2 + np.abs(S) ** 2 + eps)
    job.update(0.6, "Quick split: building masks…")
    masks = {"vocals": m_harm * (1 - low) * band * center**2, "drums": m_perc, "bass": m_harm * low}
    masks["other"] = np.clip(1 - masks["drums"] - masks["bass"] - masks["vocals"], 0, 1)
    results = []
    for i, (name, m) in enumerate(masks.items()):
        l = librosa.istft(SL * m, hop_length=hop, length=len(L))
        r = librosa.istft(SR * m, hop_length=hop, length=len(R))
        results.append((name, audio_io.save_wav(out / f"{name}.wav", np.vstack([l, r]), sr)))
        job.update(0.65 + 0.33 * (i + 1) / 4, f"Quick split: wrote {name}")
    return results
