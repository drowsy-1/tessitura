"""Tessitura backend: analysis, stem separation, warping and project storage.

Real-time audio never touches Python: the browser's Web Audio engine does playback, synthesis,
mixing and metering with sample-accurate scheduling. Python does the heavy offline work where
its ecosystem is strongest (librosa, BS.1770 loudness, ML source separation) and stores projects.

Run:  uvicorn app.main:app --reload --port 8000
"""
from __future__ import annotations

import json
import math
import os
import tempfile
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import analysis, audio_io, jobs, projects, stems, tune, warp

VERSION = "0.2.0"
DATA = projects.ROOT
WORK = DATA / "work"
MAX_UPLOAD = int(os.environ.get("TESSITURA_MAX_UPLOAD_MB", "2048")) * 1024 * 1024  # videos can be big
jobs.init(WORK / "jobs")

app = FastAPI(title="Tessitura", version=VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("TESSITURA_CORS", "http://localhost:5173,http://127.0.0.1:5173").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


async def _spool(upload: UploadFile) -> Path:
    """Stream an upload to a temp file (bounded size) and return its path."""
    suffix = Path(upload.filename or "audio.wav").suffix or ".wav"
    WORK.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(suffix=suffix, dir=WORK)
    size = 0
    with os.fdopen(fd, "wb") as f:
        while chunk := await upload.read(1 << 20):
            size += len(chunk)
            if size > MAX_UPLOAD:
                f.close()
                os.unlink(name)
                raise HTTPException(413, "File is too large")
            f.write(chunk)
    return Path(name)


def _json_safe(o):
    """JSON has no ±inf/NaN: send them as null (the UI shows “—”)."""
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    if isinstance(o, dict):
        return {k: _json_safe(v) for k, v in o.items()}
    if isinstance(o, list):
        return [_json_safe(v) for v in o]
    return o


def _load_or_400(path: Path, **kw):
    try:
        return audio_io.load(path, **kw)
    except Exception as e:
        raise HTTPException(400, f"Could not decode audio: {e}") from e


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "version": VERSION,
        "analysis": "librosa",
        "loudness": "pyloudnorm" if _has("pyloudnorm") else "builtin",
        "stems": stems.capabilities(),
        "warp": warp.engine(),
        "tune": tune.capabilities(),
        "formats": {"ffmpeg": bool(audio_io.ffmpeg_exe())},
    }


def _has(mod: str) -> bool:
    try:
        __import__(mod)
        return True
    except Exception:
        return False


@app.post("/api/analyze")
async def analyze(file: UploadFile = File(...)):
    path = await _spool(file)
    try:
        y, sr = _load_or_400(path)
        return _json_safe(analysis.analyze(y, sr))
    finally:
        path.unlink(missing_ok=True)


@app.post("/api/loudness")
async def loudness(file: UploadFile = File(...)):
    path = await _spool(file)
    try:
        y, sr = _load_or_400(path)
        return _json_safe(analysis.loudness_dict(y, sr))
    finally:
        path.unlink(missing_ok=True)


@app.post("/api/stems")
async def start_stems(file: UploadFile = File(...), model: str = Form("demucs"), source: str = Form("")):
    if model not in {m["id"] for m in stems.MODELS}:
        raise HTTPException(400, f"Unknown model “{model}”")
    src = await _spool(file)

    def run(job: jobs.Job) -> dict:
        try:
            result = stems.separate(src, job.dir, model, job)
        finally:
            src.unlink(missing_ok=True)
        eng = next(m["engine"] for m in stems.MODELS if m["id"] == model)
        return {
            "model": model,
            "engine": eng,
            "stems": [{"name": n, "url": f"/api/files/{job.id}/{p.name}"} for n, p in result],
        }

    job = jobs.submit(run, kind="stems", meta={"source": source or file.filename or "audio", "model": model})
    return job.public()


@app.get("/api/jobs")
def list_jobs(kind: str | None = None):
    """Recent jobs, newest first. Finished stem jobs keep their files, so nothing is lost."""
    return jobs.recent(kind)


@app.post("/api/convert")
async def convert(file: UploadFile = File(...)):
    """Decode any audio or video file to WAV (FFmpeg), e.g. Opus, M4A, WMA, or the audio of an MP4."""
    src = await _spool(file)
    try:
        job_id = uuid.uuid4().hex[:12]
        dest = WORK / "jobs" / job_id / "converted.wav"
        try:
            info = audio_io.convert_to_wav(src, dest)
        except Exception as e:
            raise HTTPException(415, f"Could not read audio from this file: {e}") from e
        return {"url": f"/api/files/{job_id}/converted.wav", **_json_safe(info)}
    finally:
        src.unlink(missing_ok=True)


@app.post("/api/tune")
async def start_tune(
    file: UploadFile = File(...),
    root: int = Form(0),
    scale: str = Form("0,2,4,5,7,9,11"),
    speed: float = Form(40.0),
    amount: float = Form(1.0),
    humanize: float = Form(0.3),
    detector: str = Form("pyin"),
    synth: str = Form("world"),
    source: str = Form(""),
):
    caps = tune.capabilities()
    if not any(d["id"] == detector and d["available"] for d in caps["detectors"]):
        raise HTTPException(400, f"Pitch detector “{detector}” is not installed on the backend")
    if not any(s_["id"] == synth and s_["available"] for s_ in caps["synths"]):
        raise HTTPException(400, f"Resynthesis “{synth}” is not installed on the backend")
    steps = [int(x) for x in scale.split(",") if x.strip() != ""]
    src = await _spool(file)

    def run(job: jobs.Job) -> dict:
        try:
            y, sr = audio_io.load(src)
        finally:
            src.unlink(missing_ok=True)
        out, info = tune.tune(y, sr, root % 12, steps, max(0.0, speed), min(1.0, max(0.0, amount)), min(1.0, max(0.0, humanize)), detector, synth, job)
        audio_io.save_wav(job.dir / "tuned.wav", out, info["sample_rate"])
        return {"url": f"/api/files/{job.id}/tuned.wav", "curves": info["curves"], "stats": info["stats"]}

    job = jobs.submit(run, kind="tune", meta={"source": source or file.filename or "audio", "detector": detector, "synth": synth})
    return job.public()


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return job.public()


@app.get("/api/files/{job_id}/{name}")
def job_file(job_id: str, name: str):
    base = (WORK / "jobs" / job_id).resolve()
    p = (base / name).resolve()
    if base not in p.parents or not p.exists():
        raise HTTPException(404, "File not found")
    return FileResponse(p, media_type="audio/wav")


@app.post("/api/warp")
async def warp_audio(file: UploadFile = File(...), stretch: float = Form(1.0), semitones: float = Form(0.0)):
    src = await _spool(file)
    try:
        y, sr = _load_or_400(src)
        try:
            out, eng = warp.warp(y, sr, stretch, semitones)
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        job_id = uuid.uuid4().hex[:12]
        dest = audio_io.save_wav(WORK / "jobs" / job_id / "warped.wav", out, sr)
        return {"url": f"/api/files/{job_id}/{dest.name}", "engine": eng}
    finally:
        src.unlink(missing_ok=True)


# ───────────────────────── Projects ─────────────────────────
@app.get("/api/projects")
def list_projects():
    return projects.list_projects()


@app.put("/api/projects/{name}")
async def save_project(name: str, project: str = Form(...), assets: list[UploadFile] = File(default=[])):
    try:
        data = json.loads(project)
    except json.JSONDecodeError as e:
        raise HTTPException(400, f"Project is not valid JSON: {e}") from e
    if not isinstance(data, dict) or data.get("version") != 1:
        raise HTTPException(400, "Not a Tessitura project")
    blobs = {}
    for a in assets:
        blobs[Path(a.filename or "").stem] = await a.read()
    try:
        return projects.save(data, blobs)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.get("/api/projects/{name}")
def load_project(name: str):
    try:
        return projects.load(name)
    except FileNotFoundError as e:
        raise HTTPException(404, "Project not found") from e


@app.get("/api/projects/{name}/assets")
def project_assets(name: str):
    return projects.existing_assets(name)


@app.get("/api/projects/{name}/assets/{asset}")
def project_asset(name: str, asset: str):
    try:
        return FileResponse(projects.asset_path(name, asset), media_type="audio/wav")
    except FileNotFoundError as e:
        raise HTTPException(404, "Asset not found") from e


# Serve the built frontend (npm run build → ../frontend/dist) so one process runs everything.
_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if _dist.exists():
    app.mount("/", StaticFiles(directory=_dist, html=True), name="ui")
