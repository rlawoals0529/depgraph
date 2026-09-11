"""One walk per request, held where every resolver can read it.

The whole reachable graph is answered by a single recursive CTE in `queries.tree`. So the
root resolver runs that once and everything below it reads from this, in memory. A field
resolver that went back to the database per node would turn one query into one per edge, and
the depth at which that starts to hurt is the depth at which a dependency graph gets
interesting.

This is deliberately not a DataLoader. A loader batches N+1 down to a few round trips; there
is one round trip here already, because the data layer was written to answer the whole
question in SQL rather than to answer a node at a time. See the README.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy.orm import Session
from strawberry.fastapi import BaseContext

from ..queries import Node


@dataclass
class Walk:
    """One package's reachable set, indexed the two ways the resolvers ask for it."""

    root: Node
    #: Every reachable node including the root, by `name@version`.
    by_spec: dict[str, Node]
    #: Child specs for each parent spec. Built from the walk, so it costs no extra query.
    children: dict[str, list[str]] = field(default_factory=dict)

    def kids(self, spec: str) -> list[Node]:
        return [self.by_spec[s] for s in self.children.get(spec, ()) if s in self.by_spec]


@dataclass
class Context(BaseContext):
    """What a resolver is allowed to reach.

    Inherits `BaseContext` because Strawberry's FastAPI router refuses anything that is not
    that or a dict, with `InvalidCustomContext`. Calling `schema.execute_sync` directly does
    not check, so this was green in the tests and broken over HTTP until a test went through
    the route. See `test_graphql.py::test_the_http_route_serves_the_schema`.

    The session is here for the aggregate queries that are genuinely separate questions
    (duplicates, licences, why), each of which is one more statement and is counted as such
    by `test_statement_count.py`. Nothing here fetches a node.
    """

    db: Session
    walk: Walk | None = None
