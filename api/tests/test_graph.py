from __future__ import annotations

from depgraph import queries


def specs(out):
    return {n["spec"] for n in out["nodes"]}


def node(out, spec):
    return next(n for n in out["nodes"] if n["spec"] == spec)


def test_ranks_by_shallowest_depth(db, graph):
    # `shared` is reachable at depth 1 and again at depth 2. It is a direct dependency
    # that also happens to be reached the long way round, and filing it at 2 would
    # misreport the shape of the graph.
    graph([
        ("root@1.0.0", "shared@1.0.0"),
        ("root@1.0.0", "a@1.0.0"),
        ("a@1.0.0", "shared@1.0.0"),
    ])
    out = queries.graph(db, "root", "1.0.0")
    assert node(out, "shared@1.0.0")["rank"] == 1


def test_fan_in_counts_who_depends_on_it(db, graph):
    graph([
        ("root@1.0.0", "a@1.0.0"), ("root@1.0.0", "b@1.0.0"),
        ("a@1.0.0", "shared@1.0.0"), ("b@1.0.0", "shared@1.0.0"),
    ])
    out = queries.graph(db, "root", "1.0.0")
    # Two packages depend on shared. That convergence is the only thing a graph shows
    # that a tree cannot, so it is the number the picture is for.
    assert node(out, "shared@1.0.0")["fan_in"] == 2
    assert node(out, "a@1.0.0")["fan_in"] == 1


def test_fan_in_is_over_the_whole_graph_not_the_visible_part(db, graph):
    # Twelve packages all depend on `shared`, more than the budget will draw. If fan-in
    # were counted over survivors it would shrink as the picture got smaller, which is
    # backwards: the crowded graph is exactly when the number matters.
    edges = [("root@1.0.0", f"p{i}@1.0.0") for i in range(12)]
    edges += [(f"p{i}@1.0.0", "shared@1.0.0") for i in range(12)]
    graph(edges)
    out = queries.graph(db, "root", "1.0.0", budget=6)
    assert node(out, "shared@1.0.0")["fan_in"] == 12


def test_keeps_the_highest_fan_in_and_folds_the_rest(db, graph):
    edges = [("root@1.0.0", f"p{i}@1.0.0") for i in range(10)]
    edges += [(f"p{i}@1.0.0", "hub@1.0.0") for i in range(10)]
    graph(edges)
    out = queries.graph(db, "root", "1.0.0", budget=6)

    assert "hub@1.0.0" in specs(out), "the node everything converges on must survive"
    # Nothing vanishes silently: whatever was folded is counted and labelled.
    assert out["collapsed"] > 0
    agg = [n for n in out["nodes"] if n["aggregate"]]
    assert agg, "an overflowing rank gets an aggregate standing in for it"
    assert sum(a["covers"] for a in agg) == out["collapsed"]
    assert all(a["spec"].startswith("+") for a in agg)


def test_reports_the_true_total_alongside_what_it_drew(db, graph):
    edges = [("root@1.0.0", f"p{i}@1.0.0") for i in range(10)]
    graph(edges)
    out = queries.graph(db, "root", "1.0.0", budget=5)
    # A reader has to be able to tell a small graph from a small picture of a big one.
    assert out["total"] == 11
    assert len(out["nodes"]) <= 8


def test_edges_only_join_nodes_that_were_drawn(db, graph):
    edges = [("root@1.0.0", f"p{i}@1.0.0") for i in range(10)]
    edges += [(f"p{i}@1.0.0", "hub@1.0.0") for i in range(10)]
    graph(edges)
    out = queries.graph(db, "root", "1.0.0", budget=6)
    drawn = specs(out)
    # An edge to a node that is not on the canvas is a line to nowhere.
    for e in out["edges"]:
        assert e["from"] in drawn and e["to"] in drawn


def test_a_cycle_does_not_hang_or_duplicate(db, graph):
    # npm allows circular dependencies and they are common. Without the walk's guard this
    # does not return a wrong answer, it never returns.
    graph([
        ("root@1.0.0", "a@1.0.0"),
        ("a@1.0.0", "b@1.0.0"),
        ("b@1.0.0", "a@1.0.0"),
    ])
    out = queries.graph(db, "root", "1.0.0")
    assert len(specs(out)) == len(out["nodes"]), "no package appears twice"
    assert "a@1.0.0" in specs(out) and "b@1.0.0" in specs(out)


def test_a_package_never_counts_itself(db, graph):
    graph([("root@1.0.0", "a@1.0.0"), ("a@1.0.0", "a@1.0.0")])
    out = queries.graph(db, "root", "1.0.0")
    assert node(out, "a@1.0.0")["fan_in"] == 1


def test_an_uncrawled_package_is_empty_rather_than_a_guess(db, graph):
    graph([("root@1.0.0", "a@1.0.0")])
    out = queries.graph(db, "nothing", "9.9.9")
    assert out == {"nodes": [], "edges": [], "collapsed": 0, "total": 0}


def test_a_lone_root_still_draws(db, graph):
    graph([])
    out = queries.graph(db, "root", "1.0.0")
    assert out["nodes"] == [] or specs(out) == {"root@1.0.0"}


def test_every_drawn_node_is_connected_to_another(db, graph):
    # The first version of this picked the highest fan-in node in each rank
    # independently and produced ten boxes joined by three edges, because those nodes
    # mostly do not depend on each other. Ten unconnected boxes is a list.
    edges = [("root@1.0.0", f"p{i}@1.0.0") for i in range(12)]
    edges += [(f"p{i}@1.0.0", "hub@1.0.0") for i in range(12)]
    edges += [(f"q{i}@1.0.0", "other@1.0.0") for i in range(3)]
    edges += [("root@1.0.0", f"q{i}@1.0.0") for i in range(3)]
    graph(edges)
    out = queries.graph(db, "root", "1.0.0", budget=9)

    joined = {e["from"] for e in out["edges"]} | {e["to"] for e in out["edges"]}
    drawn = {n["spec"] for n in out["nodes"] if not n["aggregate"]}
    assert drawn <= joined, f"isolated nodes drawn: {sorted(drawn - joined)}"


def test_the_convergence_and_the_things_converging_are_both_shown(db, graph):
    edges = [("root@1.0.0", f"p{i}@1.0.0") for i in range(12)]
    edges += [(f"p{i}@1.0.0", "hub@1.0.0") for i in range(12)]
    graph(edges)
    out = queries.graph(db, "root", "1.0.0", budget=9)
    drawn = {n["spec"] for n in out["nodes"]}

    assert "hub@1.0.0" in drawn
    # A hub with no visible dependents does not show convergence, it shows a box.
    feeders = [e for e in out["edges"] if e["to"] == "hub@1.0.0"]
    assert len(feeders) >= 2, "at least two dependents, or there is nothing converging"


def test_the_root_is_attached_even_when_the_hub_is_far_below_it(db, graph):
    # The shape that broke this: the root does not depend on the hub directly, it reaches
    # it through a chain, and the hub's dependents are all deep. Every fixture above wires
    # the root straight to the hub, so all of them passed while the real graph drew the
    # package you asked about as a box touching nothing.
    edges = [
        ("root@1.0.0", "mid@1.0.0"),
        ("mid@1.0.0", "lower@1.0.0"),
        ("lower@1.0.0", "hub@1.0.0"),
    ]
    edges += [(f"d{i}@1.0.0", "hub@1.0.0") for i in range(6)]
    edges += [("lower@1.0.0", f"d{i}@1.0.0") for i in range(6)]
    graph(edges)
    out = queries.graph(db, "root", "1.0.0", budget=9)

    joined = {e["from"] for e in out["edges"]} | {e["to"] for e in out["edges"]}
    assert "root@1.0.0" in joined, "the package you asked about must connect to something"

    drawn = {n["spec"] for n in out["nodes"] if not n["aggregate"]}
    assert drawn <= joined, f"isolated nodes drawn: {sorted(drawn - joined)}"
    assert "hub@1.0.0" in drawn, "the convergence is still the story"
