"""Fetching from the npm registry, and turning it into nodes and edges.

Keyless and unauthenticated. The registry is polite about volume but not infinite, so every
version is fetched once and then read from the database.
"""

from __future__ import annotations

import asyncio
import re

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Edge, PackageVersion

BASE = "https://registry.npmjs.org"

#: Enough of semver to pick a concrete version from a range without pulling in a parser.
#: Deliberately narrow: anything it cannot resolve is recorded unresolved rather than guessed.
_EXACT = re.compile(r"^\s*v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.\-]+)?)\s*$")
_LOOSE = re.compile(r"^\s*[\^~>=<]*\s*v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.\-]+)?)")


def concrete(spec: str) -> str | None:
    """The version a range points at, or None when it needs a real resolver.

    A caret range resolves to the newest matching publish, which needs the full version list.
    This takes the floor instead, which is the version the author declared they need. It is
    an approximation and the API says so rather than implying an exact lockfile.
    """
    if not spec:
        return None
    for pattern in (_EXACT, _LOOSE):
        m = pattern.match(spec)
        if m:
            return m.group(1)
    return None


class Crawler:
    def __init__(self, db: Session, max_depth: int = 6, concurrency: int = 8):
        self.db = db
        self.max_depth = max_depth
        self.sem = asyncio.Semaphore(concurrency)
        self.seen: set[tuple[str, str]] = set()

    def _node(self, name: str, version: str) -> PackageVersion:
        found = self.db.scalar(
            select(PackageVersion).where(PackageVersion.name == name, PackageVersion.version == version)
        )
        if found is None:
            found = PackageVersion(name=name, version=version)
            self.db.add(found)
            self.db.flush()
        return found

    async def _fetch(self, client: httpx.AsyncClient, name: str, version: str) -> dict | None:
        async with self.sem:
            try:
                r = await client.get(f"{BASE}/{name}/{version}", timeout=15)
            except httpx.HTTPError:
                return None
        return r.json() if r.status_code == 200 else None

    async def crawl(self, name: str, version: str, depth: int = 0, client: httpx.AsyncClient | None = None) -> None:
        key = (name, version)
        if key in self.seen or depth > self.max_depth:
            return
        self.seen.add(key)

        owns_client = client is None
        client = client or httpx.AsyncClient(headers={"accept": "application/json"})
        try:
            node = self._node(name, version)
            if node.resolved:
                return

            data = await self._fetch(client, name, version)
            if data is None:
                # Left unresolved on purpose. A node that failed to fetch is a hole in the
                # answer, and the API reports how many there are rather than hiding them.
                self.db.commit()
                return

            node.license = (data.get("license") if isinstance(data.get("license"), str) else None)
            node.unpacked_bytes = data.get("dist", {}).get("unpackedSize")
            node.resolved = True

            children = []
            for dep_name, dep_range in (data.get("dependencies") or {}).items():
                dep_version = concrete(dep_range)
                if dep_version is None:
                    continue
                child = self._node(dep_name, dep_version)
                exists = self.db.scalar(
                    select(Edge).where(Edge.parent_id == node.id, Edge.child_id == child.id)
                )
                if exists is None:
                    self.db.add(Edge(parent_id=node.id, child_id=child.id, range=dep_range))
                children.append((dep_name, dep_version))

            self.db.commit()
            await asyncio.gather(*(self.crawl(n, v, depth + 1, client) for n, v in children))
        finally:
            if owns_client:
                await client.aclose()
