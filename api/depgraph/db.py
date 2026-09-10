"""Engine and session. One place, so tests and the app cannot drift apart."""

from __future__ import annotations

import os
from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from .models import Base

DEFAULT_URL = "postgresql+psycopg://depgraph:depgraph@localhost:5433/depgraph"


def engine_from_env():
    return create_engine(os.environ.get("DATABASE_URL", DEFAULT_URL), pool_pre_ping=True)


_engine = None
_Session: sessionmaker[Session] | None = None


def session_factory() -> sessionmaker[Session]:
    global _engine, _Session
    if _Session is None:
        _engine = engine_from_env()
        _Session = sessionmaker(bind=_engine, expire_on_commit=False)
    return _Session


def create_all() -> None:
    Base.metadata.create_all(engine_from_env())


def get_db() -> Iterator[Session]:
    with session_factory()() as s:
        yield s
