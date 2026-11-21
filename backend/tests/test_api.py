"""End-to-end tests for the backend using synthetic audio with known answers."""
import io
import json
import os
import tempfile
import time

import numpy as np
import pytest
import soundfile as sf

os.environ["TESSITURA_DATA"] = tempfile.mkdtemp(prefix="tessitura-test-")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

client = TestClient(app)
SR = 44100


def wav_bytes(y: np.ndarray, sr: int = SR) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, np.atleast_2d(y).T, sr, format="WAV", subtype="PCM_24")
    return buf.getvalue()


def upload(path: str, y: np.ndarray, **data):
    return client.post(path, files={"file": ("test.wav", wav_bytes(y), "audio/wav")}, data=data)


def click_track(bpm: float, seconds: float = 20.0) -> np.ndarray:
    n = int(SR * seconds)
    y = np.zeros(n, dtype=np.float32)
    period = 60.0 / bpm
    t = np.arange(int(0.03 * SR)) / SR
    click = (np.sin(2 * np.pi * 1000 * t) * np.exp(-t * 120)).astype(np.float32)
    for k in range(int(seconds / period)):
        i = int(k * period * SR)
        y[i : i + len(click)] += click[: n - i] * (1.0 if k % 4 == 0 else 0.6)
    return np.vstack([y, y]) * 0.5


def a_minor_progression(seconds: float = 16.0) -> np.ndarray:
    """i–iv–v–i in A minor with an A drone: an unambiguous A-minor tonal centre."""
    f = lambda m: 440 * 2 ** ((m - 69) / 12)  # noqa: E731
    chords = [[57, 60, 64], [62, 65, 69], [64, 67, 71], [57, 60, 64]]
    n_per = int(SR * seconds / len(chords))
    t = np.arange(n_per) / SR
    out = []
    for ch in chords:
        seg = sum(np.sin(2 * np.pi * f(m) * t) for m in ch) / 3
        seg += 0.6 * np.sin(2 * np.pi * f(45) * t)  # A2 drone
        out.append(seg * np.minimum(1, t * 20))
    y = np.concatenate(out).astype(np.float32) * 0.3
    return np.vstack([y, y])


def test_health_reports_capabilities():
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    ids = {m["id"] for m in body["stems"]["models"]}
    assert {"demucs", "demucs_ft", "ensemble", "hpss"} <= ids
    assert any(m["id"] == "hpss" and m["available"] for m in body["stems"]["models"])


@pytest.mark.parametrize("bpm", [96, 120, 140])
def test_tempo_detection(bpm):
    r = upload("/api/analyze", click_track(bpm))
    assert r.status_code == 200, r.text
    got = r.json()["bpm"]
    # accept the classic octave ambiguity, but the value itself must be within 2 %
    assert any(abs(got * m - bpm) / bpm < 0.02 for m in (1, 2, 0.5)), got


def test_key_detection_a_minor():
    r = upload("/api/analyze", a_minor_progression())
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["camelot"] in {"8A", "8B"}, body["key_label"]  # A minor, or its relative C major


def test_loudness_matches_bs1770_reference():
    # A full-scale stereo 997 Hz sine reads ≈ 0 LUFS (−3.01 LUFS per channel, two channels);
    # at −20 dBFS peak it should read ≈ −20 LUFS.
    t = np.arange(SR * 10) / SR
    y = (10 ** (-20 / 20)) * np.sin(2 * np.pi * 997 * t)
    r = upload("/api/loudness", np.vstack([y, y]).astype(np.float32))
    assert r.status_code == 200, r.text
    body = r.json()
    assert abs(body["integrated"] - (-20.0)) < 0.3, body
    assert abs(body["sample_peak"] - (-20.0)) < 0.1
    assert body["true_peak"] >= body["sample_peak"] - 1e-6
    assert body["lra"] < 0.5  # steady tone: no loudness range


def test_stems_fallback_reconstructs_the_mix():
    mix = a_minor_progression(6.0) + click_track(120, 6.0)
    r = upload("/api/stems", mix, model="hpss")
    assert r.status_code == 200, r.text
    job = r.json()
    for _ in range(200):
        job = client.get(f"/api/jobs/{job['id']}").json()
        if job["status"] in ("done", "error"):
            break
        time.sleep(0.1)
    assert job["status"] == "done", job["message"]
    names = [s["name"] for s in job["result"]["stems"]]
    assert sorted(names) == ["bass", "drums", "other", "vocals"]
    total = None
    for s in job["result"]["stems"]:
        f = client.get(s["url"])
        assert f.status_code == 200
        y, _ = sf.read(io.BytesIO(f.content), always_2d=True)
        total = y if total is None else total + y
    ref = mix.T[: len(total)]
    err = np.sqrt(np.mean((total - ref) ** 2)) / np.sqrt(np.mean(ref**2))
    assert err < 0.02, f"stems should sum back to the mix (relative error {err:.4f})"


def test_unknown_stem_model_is_rejected():
    r = upload("/api/stems", click_track(120, 2.0), model="nope")
    assert r.status_code == 400


def test_warp_changes_length_and_keeps_rate():
    y = a_minor_progression(4.0)
    r = upload("/api/warp", y, stretch="1.25", semitones="2")
    assert r.status_code == 200, r.text
    f = client.get(r.json()["url"])
    out, sr = sf.read(io.BytesIO(f.content), always_2d=True)
    assert sr == SR
    assert abs(len(out) - y.shape[1] / 1.25) / (y.shape[1] / 1.25) < 0.02


def test_warp_rejects_absurd_ratios():
    r = upload("/api/warp", click_track(120, 1.0), stretch="10", semitones="0")
    assert r.status_code == 400


def test_bad_audio_is_a_clear_400():
    r = client.post("/api/analyze", files={"file": ("x.wav", b"not audio at all", "audio/wav")})
    assert r.status_code == 400
    assert "decode" in r.json()["detail"].lower()


def test_project_save_load_and_versions():
    project = {"version": 1, "name": "Test Song", "bpm": 120, "tracks": [], "assets": {"abc123": {"id": "abc123"}}}
    files = [("assets", ("abc123.wav", wav_bytes(click_track(120, 1.0)), "audio/wav"))]
    r = client.put("/api/projects/Test Song", data={"project": json.dumps(project)}, files=files)
    assert r.status_code == 200, r.text
    assert r.json()["version"] == 1 and r.json()["missing_assets"] == []
    r2 = client.put("/api/projects/Test Song", data={"project": json.dumps({**project, "bpm": 128})})
    assert r2.json()["version"] == 2
    listed = client.get("/api/projects").json()
    assert listed[0]["name"] == "Test Song" and listed[0]["versions"] == 2
    loaded = client.get("/api/projects/Test Song").json()
    assert loaded["project"]["bpm"] == 128
    assert "abc123" in loaded["assets"]
    a = client.get(loaded["assets"]["abc123"])
    assert a.status_code == 200 and len(a.content) > 1000
    assert client.get("/api/projects/Test Song/assets").json() == ["abc123"]


def test_asset_ids_cannot_escape_the_project_folder():
    project = {"version": 1, "name": "Evil", "assets": {}}
    files = [("assets", ("../../etc.wav", b"x", "audio/wav"))]
    r = client.put("/api/projects/Evil", data={"project": json.dumps(project)}, files=files)
    # the filename is reduced to its stem by the server; a traversal stem is refused
    assert r.status_code in (200, 400)
    assert client.get("/api/projects/Evil/assets/..%2F..%2Fetc.wav").status_code == 404


def test_rejects_non_project_json():
    r = client.put("/api/projects/X", data={"project": json.dumps({"hello": 1})})
    assert r.status_code == 400
