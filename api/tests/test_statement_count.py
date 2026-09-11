"""The N+1 claim, made mechanical.

A schema that promises it does not go back to the database per node is worth nothing. The
claim here is that nesting is free, and the way to hold it is to count the statements and
watch the number not move as the graph gets bigger.

`gql/context.py` says why there is no DataLoader: the walk is one recursive CTE, so there is
one round trip to batch. If the prefetch is ever removed in favour of resolving a node at a
time, the first of these tests fails on the count and the second fails on the growth.
"""

from __future__ import annotations


def chain(n: int) -> list[tuple[str, str]]:
    """A dependency chain `p0 -> p1 -> ... -> pn`, so depth and node count rise together."""
    return [(f"p{i}@1.0.0", f"p{i + 1}@1.0.0") for i in range(n)]


def nested(depth: int) -> str:
    """A query that walks `depth` levels of `dependencies`."""
    inner = "spec"
    for _ in range(depth):
        inner = f"spec dependencies {{ {inner} }}"
    return f'query {{ package(name: "p0", version: "1.0.0") {{ ... on Package {{ {inner} }} }} }}'


def test_the_whole_walk_costs_one_statement(run_query, graph, statements):
    # One recursive CTE answers the reachable set, and the resolvers read from it. Anything
    # above one here means a resolver went back to the database for a node.
    graph(chain(6))
    with statements() as counted:
        run_query(nested(6))
    assert counted.count == 1, f"nesting six levels issued {counted.count} statements:\n" + "\n".join(
        counted.sql
    )


def test_the_statement_count_does_not_grow_with_the_graph(run_query, graph, statements):
    # The shape of the claim, not a single measurement of it. A per-node fetch would make
    # this rise with depth, which is exactly what N+1 looks like from the outside.
    graph(chain(12))
    with statements() as shallow:
        run_query(nested(2))
    with statements() as deep:
        run_query(nested(12))
    assert deep.count == shallow.count, (
        f"two levels cost {shallow.count} statements and twelve cost {deep.count}, "
        "so the cost is growing with the graph"
    )


def test_the_counter_can_see_a_statement_when_there_is_one(run_query, graph, statements):
    # A counter that reports zero because it is not attached would make every test above
    # pass while measuring nothing. This is the positive control.
    graph(chain(3))
    with statements() as counted:
        run_query(nested(1))
    assert counted.count > 0, "the statement counter recorded nothing at all, so it is not attached"


def test_each_aggregate_is_one_more_statement_and_says_so(run_query, graph, statements):
    # `size`, `duplicates` and `licences` are separate questions with their own SQL, so they
    # cost one statement each. Pinned rather than left implicit: the claim is that nesting is
    # free, not that everything is.
    graph(chain(4))
    with statements() as counted:
        run_query(
            'query { package(name: "p0", version: "1.0.0") { ... on Package {'
            " size { bytes } duplicates { name } licences { licence } } } }"
        )
    assert counted.count == 4, (
        f"expected the walk plus three aggregates, got {counted.count} statements"
    )
