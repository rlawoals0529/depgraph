"""The graph, stored as nodes and edges.

A dependency tree is not a tree. One package version is reachable by many paths, so it is
stored ONCE and the paths are derived by walking edges. Storing a row per path would
duplicate the same package thousands of times over on a real project and make "how big is
this actually" unanswerable.
"""

from __future__ import annotations

from sqlalchemy import BigInteger, ForeignKey, String, UniqueConstraint, text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class PackageVersion(Base):
    """One published version of one package. The node."""

    __tablename__ = "package_version"
    __table_args__ = (UniqueConstraint("name", "version", name="uq_package_version"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(214), index=True)
    version: Mapped[str] = mapped_column(String(64))
    license: Mapped[str | None] = mapped_column(String(128), default=None)
    unpacked_bytes: Mapped[int | None] = mapped_column(BigInteger, default=None)
    #: False when the registry could not be reached, so a gap is visible rather than silent.
    resolved: Mapped[bool] = mapped_column(default=False, server_default=text("false"))

    dependencies: Mapped[list[Edge]] = relationship(
        back_populates="parent", foreign_keys="Edge.parent_id", cascade="all, delete-orphan"
    )

    @property
    def spec(self) -> str:
        return f"{self.name}@{self.version}"


class Edge(Base):
    """`parent` depends on `child`. The edge."""

    __tablename__ = "edge"
    __table_args__ = (UniqueConstraint("parent_id", "child_id", name="uq_edge"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    parent_id: Mapped[int] = mapped_column(ForeignKey("package_version.id", ondelete="CASCADE"), index=True)
    child_id: Mapped[int] = mapped_column(ForeignKey("package_version.id", ondelete="CASCADE"), index=True)
    #: The range the parent asked for, kept so a resolution can be explained.
    range: Mapped[str] = mapped_column(String(128))

    parent: Mapped[PackageVersion] = relationship(back_populates="dependencies", foreign_keys=[parent_id])
    child: Mapped[PackageVersion] = relationship(foreign_keys=[child_id])
