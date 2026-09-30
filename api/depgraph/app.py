"""The HTTP surface.

Every endpoint answers one graph question. None of them compute anything in Python that
Postgres can answer in SQL.
"""

from __future__ import annotations

import os
import re
import time
from collections import defaultdict, deque

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import queries
from .db import create_all, get_db
from .gql import graphql_router
from .models import PackageVersion
from .registry import Crawler, concrete

app = FastAPI(title="depgraph", version="0.1.0")

_DEFAULT_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173,https://rlawoals0529.github.io"
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.environ.get("DEPGRAPH_ALLOWED_ORIGINS", _DEFAULT_ORIGINS).split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
    allow_credentials=False,
)

_SECURITY_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "Cross-Origin-Resource-Policy": "same-site",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
}

# Lightweight per-process protection for the only route that performs outbound registry work.
# Production deployments should additionally enforce a distributed/edge limit.
_CRAWL_WINDOW_SECONDS = 60
_CRAWL_LIMIT = 30
_crawl_requests: dict[str, deque[float]] = defaultdict(deque)


def _secure_response(response):
    for name, value in _SECURITY_HEADERS.items():
        response.headers[name] = value
    return response


@app.middleware("http")
async def security_boundary(request: Request, call_next):
    if request.method == "POST" and request.url.path.startswith("/crawl/"):
        ip = request.client.host if request.client else "unknown"
        now = time.monotonic()
        bucket = _crawl_requests[ip]
        while bucket and now - bucket[0] >= _CRAWL_WINDOW_SECONDS:
            bucket.popleft()
        if len(bucket) >= _CRAWL_LIMIT:
            return _secure_response(JSONResponse(
                {"detail": "Too many crawl requests. Try again later."},
                status_code=429,
                headers={"Retry-After": str(_CRAWL_WINDOW_SECONDS)},
            ))
        bucket.append(now)

    return _secure_response(await call_next(request))


_PACKAGE_RE = re.compile(r"^[A-Za-z0-9@._~/-]{1,256}$")


def _validated_package_name(name: str) -> str:
    if not _PACKAGE_RE.fullmatch(name) or "//" in name or name.startswith("/") or name.endswith("/"):
        raise HTTPException(422, "Invalid package name.")
    return name


# A second surface over the same `queries` module, not a second implementation. The argument
# for having it at all is in `gql/schema.py`, and `tests/test_surfaces_agree.py` is what stops
# it drifting from the endpoints below.
app.include_router(graphql_router, prefix="/graphql")


@app.on_event("startup")
def startup() -> None:
    create_all()


def _resolve(version: str) -> str:
    if len(version) > 128:
        raise HTTPException(422, "Version is too long.")
    exact = concrete(version)
    if exact is None:
        raise HTTPException(422, f"Cannot resolve {version!r} to a concrete version. Give an exact one.")
    return exact


@app.post("/crawl/{name:path}")
async def crawl(name: str, version: str = Query(...), depth: int = Query(6, ge=1, le=12),
                db: Session = Depends(get_db)):
    """Fetch a package and everything it reaches, up to `depth`."""
    name = _validated_package_name(name)
    v = _resolve(version)
    crawler = Crawler(db, max_depth=depth)
    await crawler.crawl(name, v)
    total = db.scalar(select(PackageVersion).where(PackageVersion.name == name, PackageVersion.version == v))
    if total is None or not total.resolved:
        raise HTTPException(404, f"{name}@{v} could not be fetched from the registry.")
    return {"root": f"{name}@{v}", "visited": len(crawler.seen), "depth": depth}


@app.get("/tree/{name:path}")
def tree(name: str, version: str = Query(...), db: Session = Depends(get_db)):
    name = _validated_package_name(name)
    v = _resolve(version)
    nodes = queries.tree(db, name, v)
    if not nodes:
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
    name = _validated_package_name(name)
    v = _resolve(version)
    out = queries.install_size(db, name, v)
    if not out["unique_packages"]:
        raise HTTPException(404, f"{name}@{v} has not been crawled yet.")
    out["size_is_partial"] = out["unknown_size"] > 0
    return out


@app.get("/duplicates/{name:path}")
def duplicates(name: str, version: str = Query(...), db: Session = Depends(get_db)):
    name = _validated_package_name(name)
    return {"duplicates": queries.duplicate_versions(db, name, _resolve(version))}


@app.get("/licenses/{name:path}")
def licenses(name: str, version: str = Query(...), db: Session = Depends(get_db)):
    name = _validated_package_name(name)
    return {"licenses": queries.licenses(db, name, _resolve(version))}


@app.get("/why/{name:path}")
def why(name: str, version: str = Query(...), target: str = Query(..., min_length=1, max_length=256), db: Session = Depends(get_db)):
    """The shortest path from the root to `target`."""
    name = _validated_package_name(name)
    target = _validated_package_name(target)
    v = _resolve(version)
    path = queries.why(db, name, v, target)
    if path is None:
        raise HTTPException(404, f"{target} is not reachable from {name}@{v}.")
    return {"target": target, "path": path, "hops": len(path) - 1}


@app.get("/graph/{name:path}")
def graph(name: str, version: str = Query(...), db: Session = Depends(get_db)):
    name = _validated_package_name(name)
    v = _resolve(version)
    out = queries.graph(db, name, v)
    if not out["nodes"]:
        raise HTTPException(404, f"{name}@{v} has not been crawled")
    return out
