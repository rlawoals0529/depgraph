"""Tests run against a real Postgres, because the thing under test is recursive SQL.

An in-memory SQLite would not exercise a recursive CTE the same way, and the cycle guard
uses array containment that SQLite does not have. Testing the fake would prove nothing.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text

from depgraph.db import create_all, session_factory
from depgraph.models import Edge, PackageVersion


@pytest.fixture(scope="session", autouse=True)
def schema():
    create_all()


@pytest.fixture
def db():
    with session_factory()() as s:
        yield s
        s.rollback()


@pytest.fixture(autouse=True)
def clean(db):
    # Every test owns the whole graph, so they cannot leak into each other's walks.
    db.execute(text("TRUNCATE edge, package_version RESTART IDENTITY CASCADE"))
    db.commit()


@pytest.fixture
def graph(db):
    """Build a small graph from `(parent, child)` spec pairs."""

    def build(edges: list[tuple[str, str]], sizes: dict[str, int] | None = None,
              licenses: dict[str, str] | None = None):
        sizes = sizes or {}
        licenses = licenses or {}
        nodes: dict[str, PackageVersion] = {}

        def node(spec: str) -> PackageVersion:
            if spec not in nodes:
                name, version = spec.rsplit("@", 1)
                pv = PackageVersion(
                    name=name, version=version, resolved=True,
                    unpacked_bytes=sizes.get(spec), license=licenses.get(spec),
                )
                db.add(pv)
                db.flush()
                nodes[spec] = pv
            return nodes[spec]

        for parent, child in edges:
            db.add(Edge(parent_id=node(parent).id, child_id=node(child).id, range="*"))
        db.commit()
        return nodes

    return build
