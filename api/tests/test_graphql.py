"""What the schema says when it does not know, which is the reason the schema exists.

Every test here is about a case where an ordinary GraphQL schema would return a null or an
empty list, and a caller could not tell which of two opposite things had happened.
"""

from __future__ import annotations

ROOT = """
query ($name: String!, $version: String!) {
  package(name: $name, version: $version) {
    __typename
    ... on Package { name version licence depth spec }
    ... on NotCrawled { spec suggestion }
    ... on UnresolvableVersion { asked reason suggestion }
  }
}
"""


def test_a_crawled_package_comes_back_as_a_package(run_query, graph):
    graph([("root@1.0.0", "leaf@2.0.0")])
    out = run_query(ROOT, name="root", version="1.0.0")["package"]
    assert out["__typename"] == "Package", "a package that exists must not be a refusal"
    assert out["spec"] == "root@1.0.0"


def test_a_package_nobody_crawled_is_a_typed_answer_not_an_empty_one(run_query):
    # The distinction the whole schema is for. An empty dependency list and "nobody has
    # fetched this" look identical, and they mean opposite things.
    out = run_query(ROOT, name="ghost", version="1.0.0")["package"]
    assert out["__typename"] == "NotCrawled", "an uncrawled package must not read as an empty one"
    assert "crawl" in out["suggestion"].lower(), "the refusal has to say what to do next"


def test_an_unresolvable_range_is_a_typed_refusal_not_a_null(run_query, graph):
    # REST answers this with a 422. Over GraphQL a status code is not available per field, so
    # the refusal has to be a value, or it would arrive as a null that means nothing.
    #
    # `>=3` and not `^1.0.0`: a caret range resolves to its own floor, which the README
    # documents as deliberate. Picking a range that does resolve would have made this test
    # pass for the wrong reason, or in this case fail for one.
    graph([("root@1.0.0", "leaf@2.0.0")])
    out = run_query(ROOT, name="root", version=">=3")["package"]
    assert out["__typename"] == "UnresolvableVersion"
    assert out["asked"] == ">=3", "the refusal must name what was actually asked for"


def test_a_caret_range_resolves_to_its_floor_rather_than_being_refused(run_query, graph):
    # The other side of the line, pinned so the refusal above cannot quietly widen into
    # refusing things the crawler is documented to accept.
    graph([("root@1.0.0", "leaf@2.0.0")])
    out = run_query(ROOT, name="root", version="^1.0.0")["package"]
    assert out["__typename"] == "Package"
    assert out["spec"] == "root@1.0.0"


def test_the_refusal_uses_the_same_words_as_the_rest_surface(run_query, graph):
    # Two surfaces disagreeing about why something was refused is the drift this repo is
    # otherwise careful about. The wording is part of the answer.
    from fastapi import HTTPException

    from depgraph.app import _resolve

    graph([("root@1.0.0", "leaf@2.0.0")])
    out = run_query(ROOT, name="root", version=">=3")["package"]
    try:
        _resolve(">=3")
        raise AssertionError("REST was expected to refuse this range")
    except HTTPException as e:
        assert out["reason"] in e.detail, "the two surfaces must refuse in the same words"


def test_a_package_with_no_licence_is_null_which_is_an_absence_not_a_failure(run_query, graph):
    # The one nullable scalar in the schema, and the test that pins why it is allowed to be
    # one: npm genuinely permits a package to publish no licence.
    graph([("root@1.0.0", "leaf@2.0.0")])
    out = run_query(ROOT, name="root", version="1.0.0")["package"]
    assert out["licence"] is None


SIZE = """
query { package(name: "root", version: "1.0.0") { ... on Package {
  size { bytes naiveBytes countedPackages unknownPackages isFloor }
} } }
"""


def test_a_size_nobody_published_is_a_floor_that_says_so(run_query, graph):
    # A total with a hole in it, presented as a total, is a number somebody acts on. The
    # count of what is missing travels with the figure rather than in a doc.
    graph([("root@1.0.0", "known@1.0.0"), ("root@1.0.0", "unknown@1.0.0")],
          sizes={"root@1.0.0": 100, "known@1.0.0": 50})
    size = run_query(SIZE)["package"]["size"]
    assert size["isFloor"] is True, "a total missing a package must not present as complete"
    assert size["unknownPackages"] == 1
    assert size["countedPackages"] == 2
    assert size["bytes"] == 150, "the floor is the sum of what is known, not zero"


def test_a_fully_known_size_is_not_a_floor(run_query, graph):
    # The other half. A caveat that is always on is a caveat nobody reads.
    graph([("root@1.0.0", "leaf@1.0.0")], sizes={"root@1.0.0": 100, "leaf@1.0.0": 50})
    size = run_query(SIZE)["package"]["size"]
    assert size["isFloor"] is False
    assert size["unknownPackages"] == 0


NESTED = """
query { package(name: "root", version: "1.0.0") { ... on Package {
  spec dependencies { spec dependencies { spec dependencies { spec } } }
} } }
"""


def test_nesting_returns_the_graph_rather_than_repeating_the_root(run_query, graph):
    graph([("root@1.0.0", "mid@1.0.0"), ("mid@1.0.0", "leaf@1.0.0")])
    out = run_query(NESTED)["package"]
    assert out["spec"] == "root@1.0.0"
    assert [d["spec"] for d in out["dependencies"]] == ["mid@1.0.0"]
    assert [d["spec"] for d in out["dependencies"][0]["dependencies"]] == ["leaf@1.0.0"]


def test_a_cycle_does_not_make_nesting_run_forever(run_query, graph):
    # The cycle guard lives in the SQL, and this is the test that says the GraphQL layer
    # inherits it rather than reintroducing the problem by walking edges itself.
    graph([("a@1.0.0", "b@1.0.0"), ("b@1.0.0", "a@1.0.0")])
    out = run_query(
        'query { package(name: "a", version: "1.0.0") { ... on Package {'
        " spec dependencies { spec dependencies { spec } } } } }"
    )["package"]
    assert out["spec"] == "a@1.0.0"
    assert [d["spec"] for d in out["dependencies"]] == ["b@1.0.0"]


def test_why_returns_null_for_something_unreachable_which_is_an_answer(run_query, graph):
    graph([("root@1.0.0", "leaf@1.0.0")])
    out = run_query(
        'query { package(name: "root", version: "1.0.0") { ... on Package {'
        ' here: why(target: "leaf") absent: why(target: "nothing") } } }'
    )["package"]
    assert out["here"] == ["root@1.0.0", "leaf@1.0.0"]
    assert out["absent"] is None, "unreachable is an answer, and it is not an empty path"


def test_the_http_route_serves_the_schema(built_client):
    """The endpoint, not the schema object.

    Every other test here calls `schema.execute_sync`, which does not go through the router
    and does not check the context type. That gap was real: the context was a plain dataclass,
    Strawberry's FastAPI router refuses anything that is not a `BaseContext` or a dict, and
    every test above passed while `POST /graphql` returned a 500.
    """
    response = built_client.post(
        "/graphql", json={"query": '{ package(name: "ghost", version: "1.0.0") { __typename } }'}
    )
    assert response.status_code == 200, response.text
    assert response.json() == {"data": {"package": {"__typename": "NotCrawled"}}}


def test_a_refusal_arrives_as_data_with_a_200_not_as_a_transport_error(built_client):
    # The difference from REST, stated as a test. The REST surface answers this with a 422;
    # here the refusal is a value the caller can branch on, and the request itself succeeded.
    response = built_client.post(
        "/graphql",
        json={
            "query": '{ package(name: "root", version: ">=3") { __typename '
            "... on UnresolvableVersion { asked suggestion } } }"
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert "errors" not in body, "a refusal is an answer, not a GraphQL error"
    assert body["data"]["package"]["__typename"] == "UnresolvableVersion"
