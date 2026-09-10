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


@dataclass(frozen=True)
class GraphNode:
    spec: str
    rank: int
    #: How many distinct packages depend on this one. The reason to draw a graph rather
    #: than a tree: it is the only thing that shows where dependencies converge.
    fan_in: int
    #: True for an aggregate standing in for several collapsed leaves.
    aggregate: bool = False
    #: How many real packages an aggregate represents, else 1.
    covers: int = 1


def graph(db: Session, name: str, version: str, max_depth: int = 40,
          budget: int = 9, ranks: int = 4) -> dict:
    """The reachability graph, reduced to something a person can actually read.

    A real dependency graph is a hairball: express reaches 74 packages, and drawing 74
    boxes produces a picture whose only message is "a lot". The budget is the point of
    this function, not a limitation of it.

    Reduction has two rules. Rank a package by its SHALLOWEST depth, because a package
    reachable at depth 1 and depth 5 is a direct dependency that also happens to be
    reached the long way round, and filing it at 5 would be a lie about the shape.
    Then keep the highest fan-in nodes and fold the rest of each rank into one aggregate
    that says how many it stands for, so nothing is silently dropped.
    """
    rows = db.execute(
        text(_WALK + """
        SELECT name || '@' || version AS spec, MIN(depth) AS rank
        FROM walk GROUP BY name, version ORDER BY rank, spec
        """),
        {"name": name, "version": version, "max_depth": max_depth},
    ).all()
    if not rows:
        return {"nodes": [], "edges": [], "collapsed": 0, "total": 0}

    rank_of = {r.spec: r.rank for r in rows}

    # Fan-in over the whole reachable graph, not over what survives the budget. Counting
    # only the survivors would report a number that shrinks as the picture gets smaller,
    # which is exactly backwards.
    pairs = db.execute(
        text(_WALK + """
        SELECT DISTINCT w.name || '@' || w.version AS parent,
                        c.name || '@' || c.version AS child
        FROM walk w
        JOIN edge e ON e.parent_id = w.id
        JOIN package_version c ON c.id = e.child_id
        """),
        {"name": name, "version": version, "max_depth": max_depth},
    ).all()

    fan_in: dict[str, int] = {}
    for p in pairs:
        if p.parent != p.child:
            fan_in[p.child] = fan_in.get(p.child, 0) + 1

    root = f"{name}@{version}"
    parents_of: dict[str, list[str]] = {}
    for p in pairs:
        if p.parent != p.child:
            parents_of.setdefault(p.child, []).append(p.parent)

    # Choose around the convergence, not rank by rank.
    #
    # Taking the highest fan-in node in each rank independently produced ten boxes and
    # three edges, because those nodes mostly do not depend on each other. Ten unconnected
    # boxes is a list with extra steps. The picture has to be built around the thing the
    # graph exists to show: pick the package the most things converge on, then draw the
    # packages that actually converge on it.
    ranked = sorted(
        (s for s in rank_of if s != root and fan_in.get(s, 0) > 0),
        key=lambda s: (-fan_in.get(s, 0), rank_of[s], s),
    )

    chosen: list[str] = [root]

    # Spend slots first on the route from the root to the convergence.
    #
    # Without this the root sits on the canvas touching nothing, because a hub six levels
    # down is rarely a direct dependency of the package you asked about. An unattached
    # box labelled with your own package is the most confusing thing the picture could
    # contain, and a synthetic fixture that wires the root straight to the hub will never
    # show it: real graphs reach the hub through a chain.
    if ranked:
        route = why(db, name, version, ranked[0].split("@")[0], max_depth=max_depth) or []
        for spec in route:
            if len(chosen) >= budget:
                break
            if spec not in chosen and spec in rank_of:
                chosen.append(spec)

    for hub in ranked:
        if len(chosen) >= budget:
            break
        feeders = [p for p in sorted(parents_of.get(hub, [])) if p != hub]
        # A hub earns a slot only if it is already attached or a dependent fits beside it,
        # since a hub with nothing pointing at it shows no convergence at all.
        attached = hub in chosen or any(f in chosen for f in feeders)
        if not attached and budget - len(chosen) < 2:
            break
        if hub not in chosen:
            chosen.append(hub)
        for f in feeders:
            if len(chosen) >= budget:
                break
            if f not in chosen:
                chosen.append(f)

    shown_specs = set(chosen)
    keep = [
        GraphNode(s, rank_of[s], fan_in.get(s, 0))
        for s in sorted(shown_specs, key=lambda s: (rank_of[s], -fan_in.get(s, 0), s))
    ]
    collapsed = len(rank_of) - len(shown_specs)
    if collapsed:
        # Nothing is dropped quietly. The aggregate carries the count and the caller
        # renders it, so a small picture cannot be mistaken for a small graph.
        deepest = max((n.rank for n in keep), default=0)
        keep.append(GraphNode(f"+{collapsed} more", deepest, 0, aggregate=True, covers=collapsed))

    edges = sorted({(p.parent, p.child) for p in pairs
                    if p.parent in shown_specs and p.child in shown_specs and p.parent != p.child})

    return {
        "nodes": [n.__dict__ for n in keep],
        "edges": [{"from": a, "to": b} for a, b in edges],
        # Named so the caller cannot mistake what was left out for what was found.
        "collapsed": collapsed,
        "total": len(rank_of),
    }
