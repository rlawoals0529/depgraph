import { describe, expect, it } from "vitest";
import {
  MIN_ATTACH_GAP,
  NODE_H,
  NODE_W,
  RANK_STEP,
  elbow,
  fanAttach,
  layoutGraph,
  simplify,
  splitSpec,
  truncate,
  type GraphData,
  type Pt,
} from "./layout.js";

/**
 * A real crawl of express@4.21.2, kept whole.
 *
 * Every awkward case the layout has to survive is already in here and would be lost if the
 * fixture were tidied: an edge inside a rank (call-bind to get-intrinsic@1.2.4, both rank
 * 3), edges climbing two ranks back up (get-intrinsic@1.2.2 at rank 6 into rank 4), a node
 * six other packages depend on, and an aggregate standing for the 65 that did not fit.
 */
const GRAPH: GraphData = {
  nodes: [
    { spec: "express@4.21.2", rank: 0, fan_in: 0, aggregate: false, covers: 1 },
    { spec: "qs@6.13.0", rank: 1, fan_in: 2, aggregate: false, covers: 1 },
    { spec: "side-channel@1.0.6", rank: 2, fan_in: 1, aggregate: false, covers: 1 },
    { spec: "get-intrinsic@1.2.4", rank: 3, fan_in: 3, aggregate: false, covers: 1 },
    { spec: "call-bind@1.0.7", rank: 3, fan_in: 1, aggregate: false, covers: 1 },
    { spec: "function-bind@1.1.2", rank: 4, fan_in: 6, aggregate: false, covers: 1 },
    { spec: "hasown@2.0.0", rank: 4, fan_in: 3, aggregate: false, covers: 1 },
    { spec: "get-intrinsic@1.2.3", rank: 5, fan_in: 1, aggregate: false, covers: 1 },
    { spec: "get-intrinsic@1.2.2", rank: 6, fan_in: 2, aggregate: false, covers: 1 },
    { spec: "+65 more", rank: 6, fan_in: 0, aggregate: true, covers: 65 },
  ],
  edges: [
    { from: "call-bind@1.0.7", to: "function-bind@1.1.2" },
    { from: "call-bind@1.0.7", to: "get-intrinsic@1.2.4" },
    { from: "express@4.21.2", to: "qs@6.13.0" },
    { from: "get-intrinsic@1.2.2", to: "function-bind@1.1.2" },
    { from: "get-intrinsic@1.2.2", to: "hasown@2.0.0" },
    { from: "get-intrinsic@1.2.3", to: "function-bind@1.1.2" },
    { from: "get-intrinsic@1.2.3", to: "hasown@2.0.0" },
    { from: "get-intrinsic@1.2.4", to: "function-bind@1.1.2" },
    { from: "get-intrinsic@1.2.4", to: "hasown@2.0.0" },
    { from: "hasown@2.0.0", to: "function-bind@1.1.2" },
    { from: "qs@6.13.0", to: "side-channel@1.0.6" },
    { from: "side-channel@1.0.6", to: "call-bind@1.0.7" },
    { from: "side-channel@1.0.6", to: "get-intrinsic@1.2.4" },
  ],
  collapsed: 65,
  total: 74,
};

const laid = layoutGraph(GRAPH);

describe("splitSpec", () => {
  it("splits on the last @, so a scoped name keeps its own", () => {
    expect(splitSpec("express@4.21.2")).toEqual({ name: "express", version: "4.21.2" });
    expect(splitSpec("@babel/core@7.0.0")).toEqual({ name: "@babel/core", version: "7.0.0" });
  });

  it("leaves an aggregate spec alone rather than inventing a version for it", () => {
    expect(splitSpec("+65 more")).toEqual({ name: "+65 more", version: "" });
  });
});

describe("truncate", () => {
  it("does not touch a name that fits", () => {
    expect(truncate("function-bind", 13)).toBe("function-bind");
  });

  it("shortens to exactly the budget, ellipsis included", () => {
    expect(truncate("a-very-long-package-name", 13)).toHaveLength(13);
  });
});

describe("ranks", () => {
  it("puts rank 0 at the top and every deeper rank below it", () => {
    const y = (spec: string) => laid.nodes.find((n) => n.spec === spec)!.y;
    expect(y("express@4.21.2")).toBeLessThan(y("qs@6.13.0"));
    expect(y("qs@6.13.0")).toBeLessThan(y("side-channel@1.0.6"));
    expect(y("get-intrinsic@1.2.2")).toBeGreaterThan(y("function-bind@1.1.2"));
  });

  it("spaces the rows by exactly one rank step", () => {
    const rows = [...new Set(laid.nodes.map((n) => n.y))].sort((a, b) => a - b);
    rows.slice(1).forEach((y, i) => expect(y - rows[i]!).toBe(RANK_STEP));
  });

  it("gives every node in one rank the same y", () => {
    for (const rank of new Set(laid.nodes.map((n) => n.rank))) {
      const ys = new Set(laid.nodes.filter((n) => n.rank === rank).map((n) => n.y));
      expect(ys.size).toBe(1);
    }
  });

  it("never overlaps two nodes in the same rank", () => {
    // Two boxes sharing a row and sharing pixels is the failure that makes a ranked layout
    // unreadable, and the one a hand-written layout gets wrong first.
    for (const rank of new Set(laid.nodes.map((n) => n.rank))) {
      const row = laid.nodes.filter((n) => n.rank === rank).sort((a, b) => a.x - b.x);
      row.slice(1).forEach((n, i) => {
        const left = row[i]!;
        expect(n.x).toBeGreaterThanOrEqual(left.x + left.w);
      });
    }
  });
});

describe("connectors", () => {
  const offAxis = laid.edges.filter((e) => {
    const a = e.points[0]!;
    const b = e.points[e.points.length - 1]!;
    return a.x !== b.x && a.y !== b.y;
  });

  it("has off-axis edges to test at all", () => {
    expect(offAxis.length).toBeGreaterThan(4);
  });

  it("routes every edge as axis-aligned runs, with no diagonal anywhere", () => {
    for (const e of laid.edges) {
      e.points.slice(1).forEach((p, i) => {
        const prev = e.points[i]!;
        const aligned = p.x === prev.x || p.y === prev.y;
        expect(aligned, `${e.from} -> ${e.to} segment ${i} is diagonal`).toBe(true);
      });
    }
  });

  it("turns a corner rather than slanting when the endpoints share no axis", () => {
    for (const e of offAxis) {
      // Two points can only be joined by a diagonal. A real elbow needs a corner.
      expect(e.points.length, `${e.from} -> ${e.to}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("emits only axis-aligned line commands and true corner curves", () => {
    // The polyline being clean is not the same as the drawn path being clean, so this
    // reads the `d` the browser actually gets.
    for (const e of laid.edges) {
      const cursor: Pt = { x: NaN, y: NaN };
      const tokens = e.d.match(/[MLQ][^MLQ]*/g) ?? [];
      expect(tokens.length).toBeGreaterThan(0);
      for (const token of tokens) {
        const n = (token.slice(1).match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
        if (token[0] === "M") {
          cursor.x = n[0]!;
          cursor.y = n[1]!;
          continue;
        }
        if (token[0] === "L") {
          const aligned = n[0] === cursor.x || n[1] === cursor.y;
          expect(aligned, `${e.from} -> ${e.to}: L ${n.join(" ")} is a diagonal`).toBe(true);
          cursor.x = n[0]!;
          cursor.y = n[1]!;
          continue;
        }
        // A quadratic is a corner only when its control point sits on the incoming run and
        // the end point sits on the outgoing one. Anything else is a slanted curve.
        const [cxp, cyp, ex, ey] = n as [number, number, number, number];
        const corner = (cxp === cursor.x && ey === cyp) || (cyp === cursor.y && ex === cxp);
        expect(corner, `${e.from} -> ${e.to}: Q ${n.join(" ")} is not a right-angle corner`).toBe(true);
        cursor.x = ex;
        cursor.y = ey;
      }
    }
  });

  it("keeps a straight line only where the endpoints do share an axis", () => {
    for (const e of laid.edges) {
      if (e.points.length !== 2) continue;
      const [a, b] = e.points as [Pt, Pt];
      expect(a.x === b.x || a.y === b.y).toBe(true);
    }
  });

  it("never runs sideways at a node's own height", () => {
    // The invariant that keeps a connector from being drawn across the middle of a box:
    // horizontal travel only ever happens in the space between two rank rows.
    for (const e of laid.edges) {
      e.points.slice(1).forEach((p, i) => {
        const prev = e.points[i]!;
        if (p.y !== prev.y) return;
        const insideARow = laid.nodes.some((n) => p.y > n.y && p.y < n.y + n.h);
        expect(insideARow, `${e.from} -> ${e.to} travels sideways at y=${p.y}`).toBe(false);
      });
    }
  });

  it("fans the connectors on a shared box edge at least 12px apart", () => {
    const touching = (node: (typeof laid.nodes)[number], y: number) =>
      laid.edges
        .flatMap((e) => e.points)
        .filter((p) => p.y === y && p.x >= node.x - NODE_W && p.x <= node.x + node.w + NODE_W)
        .filter((p) => p.x >= node.x - 1 && p.x <= node.x + node.w + 1)
        .map((p) => p.x);

    let checked = 0;
    for (const node of laid.nodes) {
      for (const y of [node.y, node.y + node.h]) {
        const xs = [...new Set(touching(node, y))].sort((a, b) => a - b);
        if (xs.length < 2) continue;
        checked += 1;
        xs.slice(1).forEach((x, i) => {
          expect(x - xs[i]!, `${node.spec} at y=${y}`).toBeGreaterThanOrEqual(MIN_ATTACH_GAP);
        });
      }
    }
    // A vacuously passing loop would be the easiest way for this guard to stop meaning
    // anything, so the fixture is required to have crowded edges in it.
    expect(checked).toBeGreaterThan(2);
  });

  it("attaches only to the top or bottom of a box, never mid-height", () => {
    const edgeYs = new Set(laid.nodes.flatMap((n) => [n.y, n.y + n.h]));
    for (const e of laid.edges) {
      for (const end of [e.points[0]!, e.points[e.points.length - 1]!]) {
        expect(edgeYs.has(end.y)).toBe(true);
      }
    }
  });

  it("drops an edge whose endpoint was collapsed, rather than drawing it to nowhere", () => {
    const partial = layoutGraph({
      ...GRAPH,
      edges: [...GRAPH.edges, { from: "express@4.21.2", to: "gone@1.0.0" }],
    });
    expect(partial.edges).toHaveLength(laid.edges.length);
  });

  it("leaves the aggregate unconnected", () => {
    expect(laid.edges.some((e) => e.from === "+65 more" || e.to === "+65 more")).toBe(false);
  });
});

describe("fanAttach", () => {
  it("centres a single connector on the box", () => {
    expect(fanAttach(1, 80)).toEqual([80]);
  });

  it("stays at or above the minimum gap however many arrive", () => {
    for (const count of [2, 3, 6, 11, 20]) {
      const xs = fanAttach(count, 80);
      expect(xs).toHaveLength(count);
      xs.slice(1).forEach((x, i) => expect(x - xs[i]!).toBeGreaterThanOrEqual(MIN_ATTACH_GAP));
    }
  });

  it("keeps the fan symmetrical about the box centre", () => {
    const xs = fanAttach(4, 80);
    expect(xs[0]! + xs[3]!).toBeCloseTo(160);
  });
});

describe("elbow", () => {
  it("is empty for a path with nowhere to go", () => {
    expect(elbow([{ x: 0, y: 0 }])).toBe("");
    expect(elbow([])).toBe("");
  });

  it("draws a single line for two points and adds no curve", () => {
    expect(elbow([{ x: 10, y: 0 }, { x: 10, y: 40 }])).toBe("M 10 0 L 10 40");
  });

  it("rounds the corner with the radius it is given", () => {
    const d = elbow([{ x: 0, y: 0 }, { x: 0, y: 40 }, { x: 60, y: 40 }], 8);
    expect(d).toBe("M 0 0 L 0 32 Q 0 40 8 40 L 60 40");
  });

  it("shrinks the radius rather than overshooting a short run", () => {
    const d = elbow([{ x: 0, y: 0 }, { x: 0, y: 6 }, { x: 60, y: 6 }], 8);
    expect(d).toContain("L 0 3 Q 0 6 3 6");
  });
});

describe("simplify", () => {
  it("drops a repeated point", () => {
    expect(simplify([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 5 }])).toHaveLength(2);
  });

  it("drops a collinear middle, which would otherwise round a corner that is not there", () => {
    expect(simplify([{ x: 0, y: 0 }, { x: 0, y: 5 }, { x: 0, y: 9 }])).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 9 },
    ]);
  });
});

describe("what the caption has to be able to say", () => {
  it("counts the boxes standing for one package each, aggregate excluded", () => {
    expect(laid.drawn).toBe(9);
  });

  it("adds up: what it drew plus what it folded away is the whole crawl", () => {
    expect(laid.drawn + GRAPH.collapsed).toBe(GRAPH.total);
  });

  it("names the highest fan-in node, which is the reason the graph is not a tree", () => {
    expect(laid.hub?.spec).toBe("function-bind@1.1.2");
    expect(laid.hub?.fanIn).toBe(6);
  });

  it("has no hub to accent when nothing is shared", () => {
    const chain = layoutGraph({
      nodes: [
        { spec: "a@1", rank: 0, fan_in: 0, aggregate: false, covers: 1 },
        { spec: "b@1", rank: 1, fan_in: 0, aggregate: false, covers: 1 },
      ],
      edges: [{ from: "a@1", to: "b@1" }],
      collapsed: 0,
      total: 2,
    });
    expect(chain.hub).toBeNull();
  });
});

describe("the drawn box", () => {
  it("shows the covers count on the aggregate and the fan-in everywhere else", () => {
    expect(laid.nodes.find((n) => n.aggregate)!.chip).toBe("65 pkgs");
    expect(laid.nodes.find((n) => n.spec === "function-bind@1.1.2")!.chip).toBe("6 in");
  });

  it("keeps the chip inside the box and clear of the name", () => {
    for (const n of laid.nodes) {
      expect(n.chipX).toBeGreaterThanOrEqual(n.x + 14 + n.label.length * 7);
      expect(n.chipX + n.chipW).toBeLessThanOrEqual(n.x + n.w);
    }
  });

  it("fits the whole graph inside the viewBox it reports", () => {
    const [vx, vy, vw, vh] = laid.viewBox.split(" ").map(Number) as [number, number, number, number];
    for (const n of laid.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(vx);
      expect(n.x + n.w).toBeLessThanOrEqual(vx + vw);
      expect(n.y).toBeGreaterThanOrEqual(vy);
      expect(n.y + n.h).toBeLessThanOrEqual(vy + vh);
    }
    for (const p of laid.edges.flatMap((e) => e.points)) {
      expect(p.x).toBeGreaterThanOrEqual(vx);
      expect(p.x).toBeLessThanOrEqual(vx + vw);
    }
    expect(vh).toBe(NODE_H + 6 * RANK_STEP + 32);
  });
});
