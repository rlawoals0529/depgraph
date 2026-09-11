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

@pytest.fixture
def statements(db):
    """Count the SQL statements a block of work actually issues.

    Used by `test_statement_count.py` to hold the N+1 claim to something measurable. A
    promise that a schema does not go back to the database per node is worth exactly nothing;
    a count that does not move when the graph gets bigger is worth something.

    Each counter owns its own list and freezes it on the way out. The first version shared
    one list between every counter and cleared it on entry, so two blocks in one test both
    reported the second block's number and `deep.count == shallow.count` was true whatever
    the code did. It was found by reintroducing N+1 and watching the growth test pass.
    """
    from typing import Self

    from sqlalchemy import event

    engine = db.get_bind()

    class Counter:
        def __init__(self) -> None:
            self._seen: list[str] = []
            self._frozen: list[str] | None = None

        def _record(self, conn, cursor, statement, parameters, context, executemany) -> None:
            self._seen.append(statement)

        def __enter__(self) -> Self:
            event.listen(engine, "before_cursor_execute", self._record)
            return self

        def __exit__(self, *exc) -> bool:
            event.remove(engine, "before_cursor_execute", self._record)
            self._frozen = list(self._seen)
            return False

        @property
        def sql(self) -> list[str]:
            return list(self._frozen if self._frozen is not None else self._seen)

        @property
        def count(self) -> int:
            return len(self.sql)

    return Counter


@pytest.fixture
def run_query(db):
    """Execute a GraphQL document against the same session the REST tests use."""
    from depgraph.gql.context import Context
    from depgraph.gql.schema import schema

    def execute(document: str, **variables):
        result = schema.execute_sync(
            document, variable_values=variables or None, context_value=Context(db=db)
        )
        assert result.errors is None, f"GraphQL errored: {result.errors}"
        return result.data

    return execute


@pytest.fixture
def built_client(db):
    """The real FastAPI app, wired to the same session the other fixtures use.

    Exists because `schema.execute_sync` skips the router, and the router is where the
    context type is checked and where a real caller arrives.
    """
    from fastapi.testclient import TestClient

    from depgraph.app import app
    from depgraph.db import get_db

    app.dependency_overrides[get_db] = lambda: db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()
