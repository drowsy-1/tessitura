"""Background jobs (stem separation, pitch correction).

Each job lives in its own folder, `data/work/jobs/<id>/`, with a `job.json` describing it and the
result files next to it. Jobs survive backend restarts, so finished stems can always be listed and
downloaded again from the Analysis panel's “Recent separations”. One worker thread: the models are
memory-hungry and a Mac mini shouldn't run two of them at once.
"""
from __future__ import annotations

import json
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable

_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="tessitura-job")
_lock = threading.Lock()
ROOT: Path | None = None


@dataclass
class Job:
    id: str
    kind: str = "stems"
    status: str = "queued"  # queued | running | done | error
    progress: float = 0.0
    message: str = "Waiting for a free worker…"
    created: float = field(default_factory=time.time)
    meta: dict[str, Any] = field(default_factory=dict)
    result: dict[str, Any] | None = None

    @property
    def dir(self) -> Path:
        assert ROOT is not None
        return ROOT / self.id

    def public(self) -> dict:
        return {"id": self.id, "kind": self.kind, "status": self.status, "progress": round(self.progress, 3), "message": self.message,
                "created": self.created, "meta": self.meta, "result": self.result}

    def save(self) -> None:
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
            (self.dir / "job.json").write_text(json.dumps(asdict(self), indent=1))
        except Exception:
            pass

    def update(self, progress: float | None = None, message: str | None = None) -> None:
        if progress is not None:
            self.progress = max(self.progress, min(1.0, progress))
        if message is not None:
            self.message = message


JOBS: dict[str, Job] = {}


def init(root: Path) -> None:
    """Point the queue at its folder and reload jobs from earlier runs."""
    global ROOT
    ROOT = root
    root.mkdir(parents=True, exist_ok=True)
    for f in root.glob("*/job.json"):
        try:
            d = json.loads(f.read_text())
            j = Job(**d)
            if j.status in ("queued", "running"):
                j.status, j.message = "error", "Interrupted: the backend restarted while this job was running"
                j.save()
            JOBS[j.id] = j
        except Exception:
            continue


def submit(fn: Callable[[Job], dict], kind: str = "stems", meta: dict | None = None) -> Job:
    job = Job(id=uuid.uuid4().hex[:12], kind=kind, meta=meta or {})
    with _lock:
        JOBS[job.id] = job
    job.save()

    def run():
        job.status = "running"
        job.message = "Starting…"
        job.save()
        try:
            job.result = fn(job)
            job.status = "done"
            job.progress = 1.0
            job.message = "Done"
        except Exception as e:  # surfaced to the UI
            traceback.print_exc()
            job.status = "error"
            job.message = f"{type(e).__name__}: {e}"
        job.save()

    _pool.submit(run)
    return job


def get(job_id: str) -> Job | None:
    return JOBS.get(job_id)


def recent(kind: str | None = None, limit: int = 30) -> list[dict]:
    items = [j for j in JOBS.values() if kind is None or j.kind == kind]
    items.sort(key=lambda j: -j.created)
    return [j.public() for j in items[:limit]]
