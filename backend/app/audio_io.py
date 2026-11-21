"""Audio file I/O. Everything inside the backend is float32, shape (channels, samples).

Decoding order: libsndfile (WAV, AIFF, FLAC, OGG/Vorbis, Opus, MP3 with libsndfile ≥ 1.1),
then FFmpeg for everything else — M4A/AAC, ALAC, WMA, AC-3, AMR, WebM/Opus, and the audio
track of video files (MP4, MOV, MKV, WebM, AVI …). FFmpeg comes from the system PATH or,
if that's missing, from the `imageio-ffmpeg` wheel (which ships a static binary, including
for Apple Silicon), so no Homebrew install is required.
"""
from __future__ import annotations

import re
import shutil
import subprocess
from functools import lru_cache
from math import gcd
from pathlib import Path

import numpy as np
import soundfile as sf

AUDIO_EXTS = {".wav", ".wave", ".aif", ".aiff", ".aifc", ".flac", ".mp3", ".ogg", ".oga", ".opus", ".m4a", ".m4b", ".aac",
              ".alac", ".caf", ".wma", ".ac3", ".eac3", ".amr", ".au", ".snd", ".wv", ".ape", ".mka", ".spx", ".dts", ".mp2", ".w64"}
VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi", ".wmv", ".flv", ".mpg", ".mpeg", ".ts", ".mts", ".m2ts", ".3gp", ".ogv"}


@lru_cache(maxsize=1)
def ffmpeg_exe() -> str | None:
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def probe(path: str | Path) -> dict:
    """Stream info via `ffmpeg -i` (no ffprobe needed). Returns codec, rate, channels, has_video."""
    exe = ffmpeg_exe()
    if not exe:
        return {}
    r = subprocess.run([exe, "-hide_banner", "-i", str(path)], capture_output=True, text=True, errors="replace")
    info: dict = {"has_video": bool(re.search(r"Stream #\S+.*Video:", r.stderr)) and not re.search(r"Video: (mjpeg|png)", r.stderr)}
    m = re.search(r"Stream #\S+.*Audio: ([\w-]+)[^,]*, (\d+) Hz, ([^,]+)", r.stderr)
    if m:
        layout = m.group(3).strip()
        info.update(codec=m.group(1), sample_rate=int(m.group(2)), channels=1 if layout.startswith("mono") else 2)
    d = re.search(r"Duration: (\d+):(\d+):([\d.]+)", r.stderr)
    if d:
        info["duration"] = int(d.group(1)) * 3600 + int(d.group(2)) * 60 + float(d.group(3))
    info["has_audio"] = m is not None
    return info


def _decode_ffmpeg(path: str, sr: int | None, max_seconds: float | None) -> tuple[np.ndarray, int]:
    exe = ffmpeg_exe()
    if not exe:
        raise RuntimeError("FFmpeg is not available; install it or `pip install imageio-ffmpeg`")
    info = probe(path)
    if not info.get("has_audio"):
        raise RuntimeError("The file has no audio track")
    rate = int(sr or info.get("sample_rate") or 48000)
    ch = int(info.get("channels") or 2)
    cmd = [exe, "-v", "error", "-i", path, "-vn", "-map", "0:a:0", "-ac", str(ch), "-ar", str(rate)]
    if max_seconds:
        cmd += ["-t", str(max_seconds)]
    cmd += ["-f", "f32le", "-acodec", "pcm_f32le", "pipe:1"]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0 or not r.stdout:
        raise RuntimeError(r.stderr.decode(errors="replace").strip()[-400:] or "FFmpeg could not decode the file")
    y = np.frombuffer(r.stdout, dtype=np.float32).reshape(-1, ch).T.copy()
    return y, rate


def load(path: str | Path, mono: bool = False, sr: int | None = None, max_seconds: float | None = None) -> tuple[np.ndarray, int]:
    path = str(path)
    y = None
    rate = 0
    if Path(path).suffix.lower() not in VIDEO_EXTS:
        try:
            frames = int(sf.info(path).samplerate * max_seconds) if max_seconds else -1
            data, rate = sf.read(path, frames=frames, dtype="float32", always_2d=True)
            y = data.T
        except Exception:
            y = None
    if y is None:
        y, rate = _decode_ffmpeg(path, None, max_seconds)
    if mono and y.shape[0] > 1:
        y = y.mean(axis=0, keepdims=True)
    if sr and sr != rate:
        from scipy.signal import resample_poly

        g = gcd(int(sr), int(rate))
        y = resample_poly(y, sr // g, rate // g, axis=1).astype(np.float32)
        rate = sr
    return y.astype(np.float32, copy=False), int(rate)


def convert_to_wav(src: str | Path, dst: str | Path) -> dict:
    """Decode any audio or video file to a 24-bit WAV at its native rate. Returns probe info."""
    info = probe(src) if ffmpeg_exe() else {}
    y, rate = load(src)
    save_wav(dst, y, rate)
    info.update(sample_rate=rate, channels=int(y.shape[0]), duration=float(y.shape[1] / rate))
    return info


def save_wav(path: str | Path, y: np.ndarray, sr: int, subtype: str = "PCM_24") -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    y = np.atleast_2d(y)
    sf.write(str(path), np.clip(y.T, -1.0, 1.0), sr, subtype=subtype)
    return path
