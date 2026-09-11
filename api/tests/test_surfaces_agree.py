"""Two surfaces over one data layer, held to the same answers.

A second API is normally how a codebase acquires two implementations of one thing that drift
until nobody knows which is right. The defence is not review, it is this file: for each REST
endpoint, the GraphQL answer to the same question has to match.

Both go through `queries.py`, so these should agree by construction. That is exactly why the
test is worth having: the day somebody computes something in a resolver instead of asking the
query layer, this is what notices.
"""

from __future__ import annotations

import pytest

from depgraph import queries

FIXTURE = [
    ("root@1.0.0", "a@1.0.0"),
    ("root@1.0.0", "b@1.0.0"),
    ("a@1.0.0", "shared@1.0.0"),
    ("b@1.0.0", "shared@2.0.0"),
    ("b@1.0.0", "deep@1.0.0"),
]
SIZES = {"root@1.0.0": 400, "a@1.0.0": 100, "shared@1.0.0": 50, "shared@2.0.0": 60}
LICENCES = {"root@1.0.0": "MIT", "a@1.0.0": "MIT", "b@1.0.0": "Apache-2.0"}


@pytest.fixture
def built(graph):
    return graph(FIXTURE, sizes=SIZES, licenses=LICENCES)


def test_size_agrees(run_query, db, built):
    rest = queries.install_size(db, "root", "1.0.0")
    gql = run_query(
        'query { package(name: "root", version: "1.0.0") { ... on Package {'
        " size { bytes naiveBytes countedPackages unknownPackages isFloor } } } }"
    )["package"]["size"]
    assert gql["bytes"] == rest["deduped_bytes"], "the two surfaces disagree about install size"
    assert gql["naiveBytes"] == rest["naive_bytes"]
    assert gql["unknownPackages"] == rest["unknown_size"]
    # Derived in the resolver rather than read from a column, which makes it the field most
    # able to drift. It was left out of this test first time round, and a mutation that broke
    # it was caught by a different file: the guard had a hole exactly where the risk is.
    assert gql["countedPackages"] == rest["unique_packages"] - rest["unknown_size"], (
        "the resolver and the query layer disagree about how many packages were counted"
    )
    # The REST surface computes this in `app.py`; the schema computes it in a resolver. Two
    # places deciding what "partial" means is the drift this file exists for.
    assert gql["isFloor"] == (rest["unknown_size"] > 0)


def test_duplicates_agree(run_query, db, built):
    rest = queries.duplicate_versions(db, "root", "1.0.0")
    gql = run_query(
        'query { package(name: "root", version: "1.0.0") { ... on Package {'
        " duplicates { name versions which } } } }"
    )["package"]["duplicates"]
    assert [(d["name"], d["versions"], d["which"]) for d in gql] == [
        (r["name"], r["versions"], list(r["which"])) for r in rest
    ], "the duplicate list differs between the two surfaces"


def test_licences_agree(run_query, db, built):
    rest = queries.licenses(db, "root", "1.0.0")
    gql = run_query(
        'query { package(name: "root", version: "1.0.0") { ... on Package {'
        " licences { licence packages } } } }"
    )["package"]["licences"]
    assert [(x["licence"], x["packages"]) for x in gql] == [
        (r["license"], r["packages"]) for r in rest
    ], "the licence mix differs between the two surfaces"


def test_why_agrees(run_query, db, built):
    rest = queries.why(db, "root", "1.0.0", "deep")
    gql = run_query(
        'query { package(name: "root", version: "1.0.0") { ... on Package {'
        ' why(target: "deep") } } }'
    )["package"]["why"]
    assert gql == rest, "the two surfaces disagree about why a package is present"


def test_the_reachable_set_agrees_with_the_tree_endpoint(run_query, db, built):
    # REST returns the flat walk; the schema returns it nested. Flattening the nesting has to
    # produce the same set, or one of them is reaching packages the other cannot see.
    rest = {n.spec for n in queries.tree(db, "root", "1.0.0")}
    out = run_query(
        'query { package(name: "root", version: "1.0.0") { ... on Package { spec'
        " dependencies { spec dependencies { spec dependencies { spec } } } } } }"
    )["package"]

    seen: set[str] = set()

    def walk(node: dict) -> None:
        seen.add(node["spec"])
        for child in node.get("dependencies", []):
            walk(child)

    walk(out)
    assert seen == rest, f"only one surface can see {sorted(seen ^ rest)}"


def test_a_missing_package_is_refused_by_both(run_query, db):
    # Both have to refuse, and for the same reason. One surface inventing an empty answer
    # where the other refuses is the worst version of drift, because it looks like data.
    assert queries.tree(db, "ghost", "1.0.0") == []
    out = run_query(
        'query { package(name: "ghost", version: "1.0.0") { __typename } }'
    )["package"]
    assert out["__typename"] == "NotCrawled"
