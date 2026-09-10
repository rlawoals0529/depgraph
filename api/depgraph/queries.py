"""Graph questions, answered in SQL.

Every one of these is a recursive walk. Doing them in Python would mean pulling the whole
graph across the wire to answer a question about three rows of it.

The cycle guard is the load-bearing part. npm's graph is *supposed* to be acyclic and is
not: circular dependencies are legal and common. A recursive CTE without a guard does not
return a wrong answer, it never returns at all.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.orm import Session

#: One walk shared by the queries below. `path` carries the ids visited so far, which is
#: both the cycle guard and the answer to "why is this here".
_WALK = """
WITH RECURSIVE walk AS (
    SELECT pv.id,
           pv.name,
           pv.version,
           pv.license,
           pv.unpacked_bytes,
           0 AS depth,
           ARRAY[pv.id] AS path
    FROM package_version pv
    WHERE pv.name = :name AND pv.version = :version

    UNION ALL

    SELECT c.id,
           c.name,
           c.version,
           c.license,
           c.unpacked_bytes,
           w.depth + 1,
           w.path || c.id
    FROM walk w
    JOIN edge e ON e.parent_id = w.id
    JOIN package_version c ON c.id = e.child_id
    -- Stop on a repeated node. A circular dependency is legal in npm, and without this the
    -- query does not return a wrong answer, it runs forever.
    WHERE NOT c.id = ANY(w.path)
      AND w.depth < :max_depth
)
"""


@dataclass(frozen=True)
class Node:
    name: str
    version: str
    depth: int
    license: str | None
    unpacked_bytes: int | None
    path: list[int]

    @property
    def spec(self) -> str:
        return f"{self.name}@{self.version}"


def tree(db: Session, name: str, version: str, max_depth: int = 40) -> list[Node]:
    """Every reachable package version, with the shallowest depth each was reached at."""
    rows = db.execute(
        text(
            _WALK
            + """
            SELECT DISTINCT ON (id)
                   name, version, depth, license, unpacked_bytes, path
            FROM walk
            ORDER BY id, depth ASC
            """
        ),
        {"name": name, "version": version, "max_depth": max_depth},
    ).all()
    return [Node(r.name, r.version, r.depth, r.license, r.unpacked_bytes, list(r.path)) for r in rows]


def install_size(db: Session, name: str, version: str, max_depth: int = 40) -> dict:
    """Real deduplicated size, and the naive per-path total beside it.

    The gap between them is the point: a package reachable by forty paths is downloaded once,
    so a sum over paths overstates the cost by an order of magnitude on a real project.
    """
    row = db.execute(
        text(
            _WALK
            + """
            SELECT
                (SELECT COUNT(DISTINCT id) FROM walk)                       AS unique_packages,
                (SELECT COUNT(*) FROM walk)                                 AS paths,
                (SELECT COALESCE(SUM(unpacked_bytes), 0)
                   FROM (SELECT DISTINCT ON (id) id, unpacked_bytes
                           FROM walk ORDER BY id) d)                        AS deduped_bytes,
                (SELECT COALESCE(SUM(unpacked_bytes), 0) FROM walk)         AS naive_bytes,
                (SELECT MAX(depth) FROM walk)                               AS max_depth_seen,
                -- Counted over DISTINCT packages, like every other figure here. Counting
                -- paths would make the caveat look larger than the thing it qualifies.
                (SELECT COUNT(*) FROM (SELECT DISTINCT ON (id) id, unpacked_bytes
                                         FROM walk ORDER BY id) u
                  WHERE u.unpacked_bytes IS NULL)                           AS unknown_size
            """
        ),
        {"name": name, "version": version, "max_depth": max_depth},
    ).one()
    return dict(row._mapping)


def duplicate_versions(db: Session, name: str, version: str, max_depth: int = 40) -> list[dict]:
    """Packages present at more than one version at once. The commonest bloat, and invisible."""
    rows = db.execute(
        text(
            _WALK
            + """
            SELECT name, COUNT(DISTINCT version) AS versions,
                   ARRAY_AGG(DISTINCT version ORDER BY version) AS which
            FROM walk
            GROUP BY name
            HAVING COUNT(DISTINCT version) > 1
            ORDER BY versions DESC, name
            """
        ),
        {"name": name, "version": version, "max_depth": max_depth},
    ).all()
    return [dict(r._mapping) for r in rows]


def why(db: Session, name: str, version: str, target: str, max_depth: int = 40) -> list[str] | None:
    """The shortest path from the root to `target`, as package specs.

    "Why is this here" is the question a lockfile cannot answer and everyone asks.
    """
    row = db.execute(
        text(
            _WALK
            + """
            SELECT path FROM walk
            WHERE name = :target
            ORDER BY depth ASC
            LIMIT 1
            """
        ),
        {"name": name, "version": version, "target": target, "max_depth": max_depth},
    ).first()
    if row is None:
        return None
    ids = list(row.path)
    specs = db.execute(
        text("SELECT id, name, version FROM package_version WHERE id = ANY(:ids)"), {"ids": ids}
    ).all()
    by_id = {s.id: f"{s.name}@{s.version}" for s in specs}
    return [by_id[i] for i in ids]


def licenses(db: Session, name: str, version: str, max_depth: int = 40) -> list[dict]:
    """The licence mix, counted over distinct packages rather than over paths."""
    rows = db.execute(
        text(
            _WALK
            + """
            SELECT COALESCE(license, 'unknown') AS license, COUNT(*) AS packages
            FROM (SELECT DISTINCT ON (id) id, license FROM walk ORDER BY id) d
            GROUP BY 1
            ORDER BY packages DESC, license
            """
        ),
        {"name": name, "version": version, "max_depth": max_depth},
    ).all()
    return [dict(r._mapping) for r in rows]
