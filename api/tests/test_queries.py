from __future__ import annotations

from depgraph import queries


def test_tree_reaches_every_node(db, graph):
    graph([("root@1.0.0", "a@1.0.0"), ("a@1.0.0", "b@1.0.0")])
    assert {n.spec for n in queries.tree(db, "root", "1.0.0")} == {
        "root@1.0.0", "a@1.0.0", "b@1.0.0"
    }


def test_a_node_reached_twice_appears_once(db, graph):
    # A dependency graph is not a tree: `shared` hangs off both branches. Counting it twice
    # is how a size estimate ends up an order of magnitude too big.
    graph([
        ("root@1.0.0", "a@1.0.0"), ("root@1.0.0", "b@1.0.0"),
        ("a@1.0.0", "shared@1.0.0"), ("b@1.0.0", "shared@1.0.0"),
    ])
    nodes = queries.tree(db, "root", "1.0.0")
    assert [n.spec for n in nodes].count("shared@1.0.0") == 1


def test_depth_is_the_shortest_route(db, graph):
    graph([
        ("root@1.0.0", "deep@1.0.0"),
        ("root@1.0.0", "a@1.0.0"), ("a@1.0.0", "b@1.0.0"), ("b@1.0.0", "deep@1.0.0"),
    ])
    deep = next(n for n in queries.tree(db, "root", "1.0.0") if n.name == "deep")
    assert deep.depth == 1


def test_a_cycle_terminates(db, graph):
    # Circular dependencies are legal in npm and common. Without the guard this query does
    # not return a wrong answer, it never returns at all.
    graph([("a@1.0.0", "b@1.0.0"), ("b@1.0.0", "c@1.0.0"), ("c@1.0.0", "a@1.0.0")])
    assert {n.spec for n in queries.tree(db, "a", "1.0.0")} == {
        "a@1.0.0", "b@1.0.0", "c@1.0.0"
    }


def test_self_dependency_terminates(db, graph):
    graph([("a@1.0.0", "a@1.0.0")])
    assert [n.spec for n in queries.tree(db, "a", "1.0.0")] == ["a@1.0.0"]


def test_deduplicated_size_is_smaller_than_the_naive_sum(db, graph):
    graph(
        [("root@1.0.0", "a@1.0.0"), ("root@1.0.0", "b@1.0.0"),
         ("a@1.0.0", "big@1.0.0"), ("b@1.0.0", "big@1.0.0")],
        sizes={"root@1.0.0": 100, "a@1.0.0": 100, "b@1.0.0": 100, "big@1.0.0": 1000},
    )
    out = queries.install_size(db, "root", "1.0.0")
    assert out["unique_packages"] == 4
    assert out["deduped_bytes"] == 1300
    # `big` is reachable by two paths but downloaded once.
    assert out["naive_bytes"] == 2300
    assert out["paths"] > out["unique_packages"]


def test_unknown_size_is_counted_not_treated_as_zero(db, graph):
    graph([("root@1.0.0", "a@1.0.0")], sizes={"root@1.0.0": 50})
    out = queries.install_size(db, "root", "1.0.0")
    assert out["unknown_size"] == 1
    assert out["deduped_bytes"] == 50


def test_duplicate_versions_are_found(db, graph):
    graph([
        ("root@1.0.0", "a@1.0.0"), ("root@1.0.0", "b@1.0.0"),
        ("a@1.0.0", "dup@1.0.0"), ("b@1.0.0", "dup@2.0.0"),
    ])
    dups = queries.duplicate_versions(db, "root", "1.0.0")
    assert len(dups) == 1
    assert dups[0]["name"] == "dup"
    assert sorted(dups[0]["which"]) == ["1.0.0", "2.0.0"]


def test_one_version_is_not_a_duplicate(db, graph):
    graph([("root@1.0.0", "a@1.0.0")])
    assert queries.duplicate_versions(db, "root", "1.0.0") == []


def test_why_gives_the_shortest_path(db, graph):
    graph([
        ("root@1.0.0", "a@1.0.0"), ("a@1.0.0", "b@1.0.0"), ("b@1.0.0", "target@1.0.0"),
        ("root@1.0.0", "shortcut@1.0.0"), ("shortcut@1.0.0", "target@1.0.0"),
    ])
    path = queries.why(db, "root", "1.0.0", "target")
    assert path == ["root@1.0.0", "shortcut@1.0.0", "target@1.0.0"]


def test_why_returns_nothing_for_an_unreachable_package(db, graph):
    graph([("root@1.0.0", "a@1.0.0")])
    assert queries.why(db, "root", "1.0.0", "nope") is None


def test_licences_count_packages_not_paths(db, graph):
    graph(
        [("root@1.0.0", "a@1.0.0"), ("root@1.0.0", "b@1.0.0"),
         ("a@1.0.0", "shared@1.0.0"), ("b@1.0.0", "shared@1.0.0")],
        licenses={"root@1.0.0": "MIT", "a@1.0.0": "MIT", "b@1.0.0": "MIT", "shared@1.0.0": "GPL-3.0"},
    )
    out = {r["license"]: r["packages"] for r in queries.licenses(db, "root", "1.0.0")}
    # `shared` is reached twice and must still count once, or a licence audit overstates.
    assert out == {"MIT": 3, "GPL-3.0": 1}


def test_missing_licence_reports_unknown_rather_than_being_dropped(db, graph):
    graph([("root@1.0.0", "a@1.0.0")], licenses={"root@1.0.0": "MIT"})
    out = {r["license"]: r["packages"] for r in queries.licenses(db, "root", "1.0.0")}
    assert out == {"MIT": 1, "unknown": 1}


def test_max_depth_bounds_the_walk(db, graph):
    graph([(f"p{i}@1.0.0", f"p{i + 1}@1.0.0") for i in range(10)])
    assert max(n.depth for n in queries.tree(db, "p0", "1.0.0", max_depth=3)) == 3


def test_an_unknown_root_returns_nothing_rather_than_erroring(db):
    assert queries.tree(db, "does-not-exist", "1.0.0") == []


def test_unknown_size_counts_packages_not_paths(db, graph):
    # `nosize` is reachable by two paths. Counting paths would report 2 unknown packages out
    # of 4, which reads as twice the uncertainty that actually exists.
    graph(
        [("root@1.0.0", "a@1.0.0"), ("root@1.0.0", "b@1.0.0"),
         ("a@1.0.0", "nosize@1.0.0"), ("b@1.0.0", "nosize@1.0.0")],
        sizes={"root@1.0.0": 10, "a@1.0.0": 10, "b@1.0.0": 10},
    )
    out = queries.install_size(db, "root", "1.0.0")
    assert out["unique_packages"] == 4
    assert out["paths"] == 5
    assert out["unknown_size"] == 1
