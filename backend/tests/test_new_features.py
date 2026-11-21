"""Format conversion, video extraction, Demucs integration, job persistence and pitch correction."""
import io
import os
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from tests.test_api import SR, client, upload, wav_bytes, a_minor_progression  # noqa: F401  (sets TESSITURA_DATA first)
from app import audio_io, jobs, stems, tune


def wait(job_id, timeout=120):
    t0 = time.time()
    while time.time() - t0 < timeout:
        j = client.get(f"/api/jobs/{job_id}").json()
        if j["status"] in ("done", "error"):
            return j
        time.sleep(0.1)
    raise AssertionError("job timed out")


def ffmpeg_make(tmp_path, name, args):
    exe = audio_io.ffmpeg_exe()
    if not exe:
        pytest.skip("ffmpeg unavailable")
    out = tmp_path / name
    r = subprocess.run([exe, "-y", "-v", "error", *args, str(out)], capture_output=True)
    if r.returncode != 0:
        pytest.skip(f"this ffmpeg build can't write {name}: {r.stderr[-200:]!r}")
    return out


# ───────────────────────── formats ─────────────────────────
SINE = ["-f", "lavfi", "-i", "sine=frequency=440:duration=3:sample_rate=44100", "-ac", "2"]


@pytest.mark.parametrize("name,codec", [
    ("tone.mp3", ["-c:a", "libmp3lame", "-b:a", "192k"]),
    ("tone.opus", ["-c:a", "libopus", "-b:a", "96k"]),
    ("tone.m4a", ["-c:a", "aac", "-b:a", "160k"]),
    ("tone.flac", ["-c:a", "flac"]),
    ("tone.aiff", ["-c:a", "pcm_s16be"]),
    ("tone.ogg", ["-c:a", "libvorbis"]),
    ("tone.wma", ["-c:a", "wmav2"]),
])
def test_convert_many_audio_formats(tmp_path, name, codec):
    f = ffmpeg_make(tmp_path, name, SINE + codec)
    r = client.post("/api/convert", files={"file": (name, f.read_bytes(), "application/octet-stream")})
    assert r.status_code == 200, r.text
    body = r.json()
    wav = client.get(body["url"])
    y, sr = sf.read(io.BytesIO(wav.content), always_2d=True)
    assert abs(len(y) / sr - 3.0) < 0.1, (name, len(y) / sr)
    # the pitch survives the round trip
    spec = np.abs(np.fft.rfft(y[: sr, 0]))
    assert abs(np.argmax(spec) * sr / sr - 440) < 3


def test_video_audio_extraction(tmp_path):
    f = ffmpeg_make(tmp_path, "clip.mp4", ["-f", "lavfi", "-i", "testsrc=size=160x120:rate=15:duration=2", *SINE[:4], "-shortest",
                                           "-c:v", "mpeg4", "-c:a", "aac", "-ac", "2"])
    r = client.post("/api/convert", files={"file": ("clip.mp4", f.read_bytes(), "video/mp4")})
    assert r.status_code == 200, r.text
    assert r.json()["has_video"] is True
    y, sr = sf.read(io.BytesIO(client.get(r.json()["url"]).content), always_2d=True)
    assert 1.8 < len(y) / sr < 2.2


def test_video_without_audio_is_a_clear_error(tmp_path):
    f = ffmpeg_make(tmp_path, "silent.mp4", ["-f", "lavfi", "-i", "testsrc=size=64x64:rate=10:duration=1", "-c:v", "mpeg4"])
    r = client.post("/api/convert", files={"file": ("silent.mp4", f.read_bytes(), "video/mp4")})
    assert r.status_code == 415
    assert "no audio" in r.json()["detail"].lower()


def test_analyze_accepts_mp3(tmp_path):
    f = ffmpeg_make(tmp_path, "tone.mp3", SINE + ["-c:a", "libmp3lame"])
    r = client.post("/api/analyze", files={"file": ("tone.mp3", f.read_bytes(), "audio/mpeg")})
    assert r.status_code == 200, r.text


# ───────────────────────── Demucs integration (with a stand-in CLI) ─────────────────────────
FAKE_DEMUCS = textwrap.dedent('''
    import os, sys, argparse, numpy as np, soundfile as sf
    p = argparse.ArgumentParser(); p.add_argument("tracks", nargs="*"); p.add_argument("-n"); p.add_argument("-o")
    p.add_argument("--filename"); p.add_argument("--int24", action="store_true"); p.add_argument("--two-stems"); p.add_argument("-d")
    a = p.parse_args()
    if os.environ.get("FAKE_FAIL_GPU") and a.d != "cpu":
        print("RuntimeError: MPS backend out of memory", flush=True); sys.exit(1)
    y, sr = sf.read(a.tracks[0], always_2d=True)
    names = ["vocals", "no_vocals"] if a.two_stems else ["drums", "bass", "other", "vocals"]
    for i in range(0, 101, 25):
        print(f"{i:3d}%|####| {i}/100 [00:01<00:00]", end="\\r", flush=True)
    out = os.path.join(a.o, a.n); os.makedirs(out, exist_ok=True)
    for k, n in enumerate(names):
        sf.write(os.path.join(out, a.filename.format(stem=n, ext="wav")), y * (0.25 if len(names) == 4 else 0.5), sr, subtype="PCM_24")
''')


@pytest.fixture
def fake_demucs(tmp_path, monkeypatch):
    pkg = tmp_path / "fakepkgs" / "demucs"
    pkg.mkdir(parents=True)
    (pkg / "__init__.py").write_text("")
    (pkg / "__main__.py").write_text(FAKE_DEMUCS)
    monkeypatch.syspath_prepend(str(tmp_path / "fakepkgs"))
    monkeypatch.setenv("PYTHONPATH", str(tmp_path / "fakepkgs") + os.pathsep + os.environ.get("PYTHONPATH", ""))
    import importlib
    importlib.invalidate_caches()
    yield


def test_demucs_shows_as_available_and_first(fake_demucs):
    caps = client.get("/api/health").json()["stems"]
    assert caps["engine"] == "demucs"
    assert caps["models"][0]["id"] == "demucs" and caps["models"][0]["available"]


def test_demucs_job_returns_named_stems_that_persist(fake_demucs):
    r = upload("/api/stems", a_minor_progression(3.0), model="demucs", source="My Song.mp3")
    j = wait(r.json()["id"])
    assert j["status"] == "done", j["message"]
    names = [s["name"] for s in j["result"]["stems"]]
    assert names == ["vocals", "drums", "bass", "other"]
    for s in j["result"]["stems"]:
        assert client.get(s["url"]).status_code == 200
    # listed under recent separations, with the source name
    recent = client.get("/api/jobs", params={"kind": "stems"}).json()
    assert recent[0]["id"] == j["id"] and recent[0]["meta"]["source"] == "My Song.mp3"
    # survives a backend restart: reload the registry from disk
    jobs.JOBS.clear()
    jobs.init(jobs.ROOT)
    again = client.get(f"/api/jobs/{j['id']}").json()
    assert again["status"] == "done" and len(again["result"]["stems"]) == 4


def test_demucs_two_stems_renames_instrumental(fake_demucs):
    j = wait(upload("/api/stems", a_minor_progression(2.0), model="demucs_vocals").json()["id"])
    assert j["status"] == "done", j["message"]
    assert [s["name"] for s in j["result"]["stems"]] == ["vocals", "instrumental"]


def test_demucs_falls_back_to_cpu_when_the_gpu_run_fails(fake_demucs, monkeypatch):
    monkeypatch.setenv("FAKE_FAIL_GPU", "1")
    j = wait(upload("/api/stems", a_minor_progression(2.0), model="demucs").json()["id"])
    assert j["status"] == "done", j["message"]


def test_missing_engine_gives_install_hint(monkeypatch):
    monkeypatch.setattr(stems, "engines", lambda: {"demucs": False, "audio-separator": False, "builtin": True})
    j = wait(upload("/api/stems", a_minor_progression(1.0), model="demucs").json()["id"])
    assert j["status"] == "error" and "pip install demucs" in j["message"]


# ───────────────────────── pitch correction ─────────────────────────
def detuned_melody(sr=SR):
    """A–C–E–A sung 30–40 cents flat, with light vibrato: a clear job for a tuner."""
    notes = [57, 60, 64, 69]
    out = []
    for i, m in enumerate(notes):
        t = np.arange(int(sr * 0.6)) / sr
        cents = -35 + 8 * np.sin(2 * np.pi * 5.5 * t)
        f = 440 * 2 ** ((m - 69 + cents / 100) / 12)
        ph = 2 * np.pi * np.cumsum(f) / sr
        tone = sum(np.sin(k * ph) / k for k in range(1, 8)) * np.minimum(1, t * 30) * np.minimum(1, (0.6 - t) * 30)
        out.append(tone * 0.25)
    y = np.concatenate(out).astype(np.float32)
    return np.vstack([y, y])


def median_cents_error(y, sr, notes=(57, 60, 64, 69)):
    import librosa
    f0, v, _ = librosa.pyin(y[0], fmin=100, fmax=600, sr=sr, frame_length=2048, hop_length=256)
    midi = 69 + 12 * np.log2(f0[v] / 440)
    return float(np.median(np.abs(midi - np.round(midi)) * 100))


@pytest.mark.parametrize("synth", ["world", "psola", "shift"])
def test_tuning_pulls_notes_onto_the_key(synth):
    caps = tune.capabilities()
    if not next(s for s in caps["synths"] if s["id"] == synth)["available"]:
        pytest.skip(f"{synth} not installed")
    y = detuned_melody()
    before = median_cents_error(y, SR)
    r = upload("/api/tune", y, root="9", scale="0,2,3,5,7,8,10", speed="0", amount="1", humanize="0.2", detector="pyin", synth=synth)
    assert r.status_code == 200, r.text
    j = wait(r.json()["id"], timeout=240)
    assert j["status"] == "done", j["message"]
    out, sr = sf.read(io.BytesIO(client.get(j["result"]["url"]).content), always_2d=True)
    after = median_cents_error(out.T.astype(np.float32), sr)
    assert before > 25 and after < 12, (synth, before, after)
    c = j["result"]["curves"]
    assert len(c["detected"]) == len(c["corrected"]) > 50
    assert j["result"]["stats"]["mean_cents"] > 20


def test_tune_rejects_uninstalled_detector():
    r = upload("/api/tune", detuned_melody(), detector="nope")
    assert r.status_code == 400
