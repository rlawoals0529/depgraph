"""The GraphQL surface. `schema` carries the argument for why it exists alongside REST."""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.orm import Session
from strawberry.fastapi import GraphQLRouter

from ..db import get_db
from .context import Context
from .schema import schema


def context_for(db: Session = Depends(get_db)) -> Context:
    """One session and one empty walk per request.

    The session comes from the same `get_db` the REST endpoints use, so the two surfaces
    cannot end up reading through different engines or different transaction settings. The
    walk starts empty and is filled by the root resolver, once.
    """
    return Context(db=db)


graphql_router: GraphQLRouter = GraphQLRouter(schema, context_getter=context_for)

__all__ = ["context_for", "graphql_router", "schema"]
