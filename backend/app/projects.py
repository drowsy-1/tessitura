"""Project storage: plain JSON + WAV assets on disk, versioned, git-friendly.

    data/projects/<slug>/
        project.json          latest version (pretty-printed, stable key order → clean diffs)
        versions/v0001.json   every save, never overwritten
        assets/<asset-id>.wav audio referenced by clips (content never changes once written)

Set TESSITURA_GIT=1 to commit every save into a git repository inside the project folder.
Large audio is better tracked with Git LFS (`git lfs track "assets/*.wav"`).
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

ROOT = Path(os.environ.get("TESSITURA_DATA", Path(__file__).resolve().parent.parent / "data"))
PROJECTS = ROOT / "projects"
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def slug(name: str) -> str:
    s = re.sub(r"[^A-Za-z0-9 _-]+", "", name).strip().replace(" ", "-")
    return (s or "untitled")[:80]


def project_dir(name: str) -> Path:
    return PROJECTS / slug(name)


def list_projects() -> list[dict]:
    if not PROJECTS.exists():
        return []
    out = []
    for d in sorted(PROJECTS.iterdir()):
        f = d / "project.json"
        if f.exists():
            try:
                name = json.loads(f.read_text()).get("name", d.name)
            except Exception:
                name = d.name
            out.append({"name": name, "updated": f.stat().st_mtime, "versions": len(list((d / "versions").glob("v*.json")))})
    return sorted(out, key=lambda p: -p["updated"])


def existing_assets(name: str) -> list[str]:
    a = project_dir(name) / "assets"
    return [p.stem for p in a.glob("*.wav")] if a.exists() else []


def save(project: dict, assets: dict[str, bytes]) -> dict:
    d = project_dir(project.get("name", "Untitled"))
    (d / "versions").mkdir(parents=True, exist_ok=True)
    (d / "assets").mkdir(exist_ok=True)
    for asset_id, data in assets.items():
        if not SAFE_ID.match(asset_id):
            raise ValueError(f"Bad asset id {asset_id!r}")
        target = d / "assets" / f"{asset_id}.wav"
        if not target.exists():
            target.write_bytes(data)
    text = json.dumps(project, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    n = len(list((d / "versions").glob("v*.json"))) + 1
    (d / "versions" / f"v{n:04d}.json").write_text(text)
    (d / "project.json").write_text(text)
    missing = [a for a in project.get("assets", {}) if not (d / "assets" / f"{a}.wav").exists()]
    if os.environ.get("TESSITURA_GIT") == "1" and shutil.which("git"):
        _git_commit(d, f"Save v{n:04d} · {time.strftime('%Y-%m-%d %H:%M')}")
    return {"version": n, "path": str(d), "missing_assets": missing}


def load(name: str) -> dict:
    d = project_dir(name)
    f = d / "project.json"
    if not f.exists():
        raise FileNotFoundError(name)
    project = json.loads(f.read_text())
    assets = {a: f"/api/projects/{slug(name)}/assets/{a}.wav" for a in existing_assets(name)}
    return {"project": project, "assets": assets}


def asset_path(name: str, asset: str) -> Path:
    stem = asset.removesuffix(".wav")
    if not SAFE_ID.match(stem):
        raise FileNotFoundError(asset)
    p = project_dir(name) / "assets" / f"{stem}.wav"
    if not p.exists():
        raise FileNotFoundError(asset)
    return p


def _git_commit(d: Path, msg: str) -> None:
    try:
        if not (d / ".git").exists():
            subprocess.run(["git", "init", "-q"], cwd=d, check=True)
            (d / ".gitattributes").write_text("assets/*.wav binary\n")
        subprocess.run(["git", "add", "-A"], cwd=d, check=True)
        subprocess.run(["git", "-c", "user.name=Tessitura", "-c", "user.email=tessitura@localhost", "commit", "-q", "-m", msg], cwd=d, check=False)
    except Exception:
        pass  # versioned JSON files are the source of truth; git is a convenience
