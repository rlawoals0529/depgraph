# Mutations

A test suite nobody has watched fail is not evidence. Each row below is a change to the
source that must turn a **named** test red. Run them by hand after touching the GraphQL
layer.

The method: back the file up, apply the change, `uv run pytest -q`, restore.

| Mutation | Should fail |
| --- | --- |
| `gql/schema.py`: resolve `dependencies` with its own SQL instead of reading the walk | "the whole walk costs one statement" **and** "the statement count does not grow with the graph" |
| `gql/schema.py`: `counted_packages` forgets to subtract `unknown_size` | "size agrees" |
| `gql/schema.py`: `is_floor` returns `False` unconditionally | "a size nobody published is a floor that says so" |
| `gql/schema.py`: return `None` instead of `NotCrawled` for an uncrawled package | "a package nobody crawled is a typed answer not an empty one" |
| `gql/schema.py`: raise instead of returning `UnresolvableVersion` | "an unresolvable range is a typed refusal not a null" |
| `gql/schema.py`: change the refusal wording | "the refusal uses the same words as the rest surface" |
| `gql/schema.py`: make `why` return `[]` rather than `None` when unreachable | "why returns null for something unreachable which is an answer" |
| `gql/schema.py`: refuse `^1.0.0` as unresolvable | "a caret range resolves to its floor rather than being refused" |
| `gql/context.py`: make `kids` return every node rather than the children | "nesting returns the graph rather than repeating the root" |

## Two that were found by running these, not by writing them

**The growth test was vacuous, and it read as thorough.** `test_the_statement_count_does_not_grow_with_the_graph` compared two counters that shared one list, which `__enter__` cleared. After the second block both reported the second block's number, so `deep.count == shallow.count` was true whatever the code did. It was found by reintroducing N+1 and watching the growth test pass while its neighbour failed: **one test failing where two should have is the signal.** Each counter now owns its list and freezes it on exit.

There is a positive control beside it now, `test_the_counter_can_see_a_statement_when_there_is_one`, because a counter that is not attached reports zero and makes every assertion above it pass.

**The surfaces-agree guard had a hole exactly where the risk is.** Breaking `counted_packages` was caught by `test_graphql.py` rather than by `test_surfaces_agree.py`, because the size comparison checked four fields and not that one. It is the only size field derived in a resolver instead of read from a column, so it is the field most able to drift, and it was the one not being compared. **A guard that passes because it was not looking is the thing this file exists to catch.**
