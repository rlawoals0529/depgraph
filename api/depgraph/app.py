"""The HTTP surface.

Every endpoint answers one graph question. None of them compute anything in Python that
Postgres can answer in SQL.
"""

from __future__ import annotations

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import queries
from .db import create_all, get_db
from .models import PackageVersion
from .registry import Crawler, concrete

app = FastAPI(title="depgraph", version="0.1.0")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST"], allow_headers=["*"]
)


@app.on_event("startup")
def startup() -> None:
    create_all()


def _resolve(version: str) -> str:
    exact = concrete(version)
    if exact is None:
        raise HTTPException(422, f"Cannot resolve {version!r} to a concrete version. Give an exact one.")
    return exact


@app.post("/crawl/{name:path}")
async def crawl(name: str, version: str = Query(...), depth: int = Query(6, ge=1, le=12),
                db: Session = Depends(get_db)):
    """Fetch a package and everything it reaches, up to `depth`."""
    v = _resolve(version)
    crawler = Crawler(db, max_depth=depth)
    await crawler.crawl(name, v)
    total = db.scalar(select(PackageVersion).where(PackageVersion.name == name, PackageVersion.version == v))
    if total is None or not total.resolved:
        raise HTTPException(404, f"{name}@{v} could not be fetched from the registry.")
    return {"root": f"{name}@{v}", "visited": len(crawler.seen), "depth": depth}


@app.get("/tree/{name:path}")
def tree(name: str, version: str = Query(...), db: Session = Depends(get_db)):
    v = _resolve(version)
    nodes = queries.tree(db, name, v)
    if not nodes:
        # Name the version actually looked up, not the range asked for. An error that names
        # something other than what was queried sends you looking in the wrong place.
        raise HTTPException(404, f"{name}@{v} has not been crawled yet. POST /crawl first.")
    return {
        "root": f"{name}@{v}",
        "nodes": [
            {"name": n.name, "version": n.version, "depth": n.depth,
             "license": n.license, "unpacked_bytes": n.unpacked_bytes}
            for n in nodes
        ],
    }


@app.get("/size/{name:path}")
def size(name: str, version: str = Query(...), db: Session = Depends(get_db)):
    """Deduplicated install cost, with the naive per-path total beside it."""
    v = _resolve(version)
    out = queries.install_size(db, name, v)
    if not out["unique_packages"]:
        raise HTTPException(404, f"{name}@{v} has not been crawled yet.")
    # Reported rather than hidden: a package the registry refused leaves a hole in the total.
    out["size_is_partial"] = out["unknown_size"] > 0
    return out


@app.get("/duplicates/{name:path}")
def duplicates(name: str, version: str = Query(...), db: Session = Depends(get_db)):
    return {"duplicates": queries.duplicate_versions(db, name, _resolve(version))}


@app.get("/licenses/{name:path}")
def licenses(name: str, version: str = Query(...), db: Session = Depends(get_db)):
    return {"licenses": queries.licenses(db, name, _resolve(version))}


@app.get("/why/{name:path}")
def why(name: str, version: str = Query(...), target: str = Query(...), db: Session = Depends(get_db)):
    """The shortest path from the root to `target`."""
    v = _resolve(version)
    path = queries.why(db, name, v, target)
    if path is None:
        raise HTTPException(404, f"{target} is not reachable from {name}@{v}.")
    return {"target": target, "path": path, "hops": len(path) - 1}


@app.get("/graph/{name:path}")
def graph(name: str, version: str = Query(...), db: Session = Depends(get_db)):
    out = queries.graph(db, name, _resolve(version))
    if not out["nodes"]:
        raise HTTPException(404, f"{name}@{_resolve(version)} has not been crawled")
    return out
