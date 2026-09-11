"""The GraphQL surface, and the one reason it is worth having a second one.

A second API over one data layer is usually a liability: two implementations of one thing,
drifting, with no test that they agree. This one earns its place for a reason specific to
what this service is for.

**GraphQL makes `null` ambiguous, and refusing that ambiguity is the whole point of this
codebase.** The README already says it about the crawler: a package the registry refused
stays unresolved rather than being recorded as having no dependencies, because those two look
identical and mean opposite things. Over REST that survives as `resolved`, `unknown_size`,
`size_is_partial` and a 422. In an ordinary GraphQL schema all of it collapses into a nullable
Int, and the caller cannot tell "there is none" from "we could not find out".

So no nullable scalar here is allowed to carry a failure. Anything that can fail returns a
type that says which of the two happened:

    a range that cannot be resolved  ->  UnresolvableVersion, inside `data`, not a status
    a package nobody has crawled     ->  NotCrawled, inside `data`, not an empty list
    a size nobody published          ->  Size.isFloor with a count, never a bare number

`license` is the one nullable scalar in the schema, and it is nullable because npm genuinely
permits a package with no licence field. That is an absence, not a failure, which is the
distinction this docstring exists to hold.
"""

from __future__ import annotations

from typing import Annotated

import strawberry
from strawberry.types import Info

from .. import queries
from ..registry import concrete
from .context import Context, Walk


@strawberry.type
class LicenceCount:
    licence: str
    packages: int


@strawberry.type
class Duplicate:
    name: str
    versions: int
    which: list[str]


@strawberry.type
class Size:
    """Install cost, with the size of what is missing beside it.

    `bytes` is the deduplicated total of everything whose size is known. It is a floor rather
    than a total whenever `unknownPackages` is non-zero, and `isFloor` says so, because a
    floor presented as a total is a number somebody will act on.
    """

    bytes: int
    naive_bytes: int
    counted_packages: int
    unknown_packages: int

    @strawberry.field(description="True when some package's size is unknown, so `bytes` is a floor.")
    def is_floor(self) -> bool:
        return self.unknown_packages > 0


@strawberry.type
class Package:
    name: str
    version: str
    #: Nullable on purpose, and the only nullable scalar here: npm allows a package to
    #: publish no licence at all. An absence, not a failure.
    licence: str | None
    depth: int

    @strawberry.field
    def spec(self) -> str:
        return f"{self.name}@{self.version}"

    @strawberry.field(description="Direct dependencies. Read from the walk, so this costs no query.")
    def dependencies(self, info: Info) -> list[Package]:
        walk = _walk(info)
        return [_package(n) for n in walk.kids(f"{self.name}@{self.version}")]

    @strawberry.field(description="Deduplicated install cost of everything reachable from here.")
    def size(self, info: Info) -> Size:
        row = queries.install_size(_ctx(info).db, self.name, self.version)
        return Size(
            bytes=int(row["deduped_bytes"]),
            naive_bytes=int(row["naive_bytes"]),
            counted_packages=int(row["unique_packages"]) - int(row["unknown_size"]),
            unknown_packages=int(row["unknown_size"]),
        )

    @strawberry.field(description="Packages present at more than one version at once.")
    def duplicates(self, info: Info) -> list[Duplicate]:
        rows = queries.duplicate_versions(_ctx(info).db, self.name, self.version)
        return [Duplicate(name=r["name"], versions=r["versions"], which=list(r["which"])) for r in rows]

    @strawberry.field(description="The licence mix, counted over packages rather than over paths.")
    def licences(self, info: Info) -> list[LicenceCount]:
        rows = queries.licenses(_ctx(info).db, self.name, self.version)
        return [LicenceCount(licence=r["license"], packages=r["packages"]) for r in rows]

    @strawberry.field(
        description="Shortest path to `target`, as specs. Null means unreachable, which is an answer."
    )
    def why(self, info: Info, target: str) -> list[str] | None:
        return queries.why(_ctx(info).db, self.name, self.version, target)


@strawberry.type
class UnresolvableVersion:
    """A range this cannot turn into a version, said as a value rather than a status code."""

    asked: str
    reason: str
    suggestion: str


@strawberry.type
class NotCrawled:
    """Nobody has fetched this yet. Distinct from "it has no dependencies", which looks the same."""

    spec: str
    suggestion: str


PackageResult = Annotated[
    Package | NotCrawled | UnresolvableVersion, strawberry.union("PackageResult")
]


def _ctx(info: Info) -> Context:
    return info.context


def _walk(info: Info) -> Walk:
    walk = _ctx(info).walk
    if walk is None:
        # Unreachable through the schema, because every path to a Package goes through the
        # root resolver that sets this. Said out loud rather than returning an empty list,
        # because an empty list here would read as "no dependencies".
        raise RuntimeError("no walk in context: a Package was built without the root resolver")
    return walk


def _package(node: queries.Node) -> Package:
    return Package(name=node.name, version=node.version, licence=node.license, depth=node.depth)


@strawberry.type
class Query:
    @strawberry.field(description="One package and everything reachable from it.")
    def package(self, info: Info, name: str, version: str) -> PackageResult:
        exact = concrete(version)
        if exact is None:
            # The same refusal the REST surface makes with a 422, in the same words, as a
            # type the caller can branch on instead of a status they have to interpret.
            return UnresolvableVersion(
                asked=version,
                reason=f"Cannot resolve {version!r} to a concrete version.",
                suggestion="Give an exact one.",
            )

        ctx = _ctx(info)
        nodes = queries.tree(ctx.db, name, exact)
        if not nodes:
            return NotCrawled(
                spec=f"{name}@{exact}",
                suggestion="POST /crawl first.",
            )

        by_spec = {n.spec: n for n in nodes}
        # Children come out of the paths the walk already returned: a node's parent is the
        # second-to-last id on its shortest path. No second query, and no edge table read.
        children: dict[str, list[str]] = {}
        ids_to_spec = {n.path[-1]: n.spec for n in nodes}
        for n in nodes:
            if len(n.path) < 2:
                continue
            parent_spec = ids_to_spec.get(n.path[-2])
            if parent_spec is not None:
                children.setdefault(parent_spec, []).append(n.spec)

        root = by_spec[f"{name}@{exact}"]
        ctx.walk = Walk(root=root, by_spec=by_spec, children=children)
        return _package(root)


schema = strawberry.Schema(query=Query, types=[Package, NotCrawled, UnresolvableVersion])
