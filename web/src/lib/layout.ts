/**
 * Ranked-grid layout for a dependency graph, written out rather than installed.
 *
 * A layout library exists for graphs whose shape you do not know. This one is known: the
 * API already hands back a rank per node, so the positions are a grid and the grid is
 * arithmetic. What is left is the routing, and that is where the rules live.
 *
 * Two rules drive every decision below.
 *
 * 1. No diagonals. A slanted line between two boxes says "these are related" and nothing
 *    else; an orthogonal one has a direction you can follow with a finger, and a corner is
 *    a place the eye can rest. So every connector is a run of axis-aligned segments joined
 *    by quarter-circle corners, and a straight line only happens when the two endpoints
 *    genuinely share an axis.
 * 2. Every horizontal run lives in the gap between two rank rows, never at a node's own y.
 *    That is the whole reason a connector cannot end up drawn across the middle of a box:
 *    the only place it is allowed to travel sideways has no boxes in it.
 *
 * Edges that are not simple parent-to-child are the interesting part. A dependency graph
 * is not a tree, so the same crawl produces edges within a rank (two rank-3 packages where
 * one needs the other) and edges that climb back up (a rank-6 package needing a rank-4
 * one). Those are routed out to a side channel and back in through a gap, so they read as
 * the detour they are instead of being hidden.
 */

export interface GraphNode {
  spec: string;
  rank: number;
  fan_in: number;
  aggregate: boolean;
  covers: number;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  collapsed: number;
  total: number;
}

/* ---- The grammar, as numbers -------------------------------------------------------- */

export const NODE_W = 160;
export const NODE_H = 56;
/** Rank rows are this far apart, top of box to top of box. */
export const RANK_STEP = 120;
/** Corner radius on every elbow. */
export const CORNER = 8;
/** Two connectors attaching to the same side of a box never come closer than this. */
export const MIN_ATTACH_GAP = 12;

const COL_GAP = 48;
const ATTACH_INSET = 20;
const MAX_ATTACH_GAP = 24;
/** Clearance between a box edge and the nearest horizontal run in the gap below it. */
const GAP_MARGIN = 8;
const MAX_LANE_GAP = 18;
/** Horizontal clearance before two runs are allowed to share one lane. */
const LANE_PAD = 10;
const CHANNEL_OFFSET = 24;
const CHANNEL_STEP = 18;
const VIEW_PAD = 16;
/** Longest package name that fits beside the chip at the name's type size. */
const NAME_CHARS = 13;

export interface Pt {
  x: number;
  y: number;
}

export interface PlacedNode {
  spec: string;
  name: string;
  version: string;
  /** The name as drawn, shortened if it would run under the chip. */
  label: string;
  rank: number;
  row: number;
  fanIn: number;
  aggregate: boolean;
  covers: number;
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  chip: string;
  chipX: number;
  chipW: number;
}

export interface RoutedEdge {
  from: string;
  to: string;
  /** The corners, before rounding. Consecutive points always share an x or a y. */
  points: Pt[];
  d: string;
  /** Arrowhead at the target end, as an SVG polygon `points` value. */
  arrow: string;
}

export interface Layout {
  nodes: PlacedNode[];
  edges: RoutedEdge[];
  viewBox: string;
  width: number;
  height: number;
  /** The node the graph exists to show: the one the most other packages depend on. */
  hub: PlacedNode | null;
  /** Boxes standing for exactly one package, so the caption can say what it left out. */
  drawn: number;
}

/* ---- Small pure pieces --------------------------------------------------------------- */

/** `express@4.21.2` into its two halves. An aggregate spec has no version and keeps all of it. */
export function splitSpec(spec: string): { name: string; version: string } {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return { name: spec, version: "" };
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

const axisLen = (a: Pt, b: Pt): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** A point `dist` along the axis-aligned segment from `from` towards `toward`. */
function along(from: Pt, toward: Pt, dist: number): Pt {
  const total = axisLen(from, toward);
  if (total === 0) return { x: from.x, y: from.y };
  return {
    x: from.x + ((toward.x - from.x) * dist) / total,
    y: from.y + ((toward.y - from.y) * dist) / total,
  };
}

/**
 * Drop the points that would produce a corner with nothing on one side of it.
 *
 * A zero-length segment or three collinear points both give a rounded corner a radius it
 * cannot use, and the visible result is a nick in an otherwise straight line.
 */
export function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    const prev = out[out.length - 2];
    if (last && prev) {
      const collinear =
        (prev.x === last.x && last.x === p.x) || (prev.y === last.y && last.y === p.y);
      if (collinear) out.pop();
    }
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

/**
 * A polyline drawn as straight runs joined by quarter-circle corners.
 *
 * Quadratic curves rather than arcs: the control point is the corner itself, so the curve
 * is tangent to both runs by construction and there is no sweep flag to get backwards.
 */
export function elbow(pts: Pt[], r: number = CORNER): string {
  const p = simplify(pts);
  const first = p[0];
  const last = p[p.length - 1];
  if (!first || !last || p.length < 2) return "";

  let d = `M ${round2(first.x)} ${round2(first.y)}`;
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[i - 1]!;
    const c = p[i]!;
    const b = p[i + 1]!;
    const rr = Math.min(r, axisLen(a, c) / 2, axisLen(c, b) / 2);
    const enter = along(c, a, rr);
    const leave = along(c, b, rr);
    d += ` L ${round2(enter.x)} ${round2(enter.y)}`;
    d += ` Q ${round2(c.x)} ${round2(c.y)} ${round2(leave.x)} ${round2(leave.y)}`;
  }
  return `${d} L ${round2(last.x)} ${round2(last.y)}`;
}

/**
 * Where `count` connectors attach along one side of a box, centred on it.
 *
 * The floor is the point of this function. Fanned closer than MIN_ATTACH_GAP the
 * connectors arrive as one thick line and the count stops being readable, so a box with
 * more connectors than its width comfortably holds spreads past its own edge rather than
 * bunching them.
 */
export function fanAttach(count: number, centre: number): number[] {
  if (count <= 1) return count === 1 ? [centre] : [];
  const span = NODE_W - 2 * ATTACH_INSET;
  const gap = Math.max(MIN_ATTACH_GAP, Math.min(MAX_ATTACH_GAP, span / (count - 1)));
  const start = centre - ((count - 1) * gap) / 2;
  return Array.from({ length: count }, (_, i) => start + i * gap);
}

/**
 * Greedy interval colouring: the lowest lane whose occupants do not overlap this one.
 *
 * Runs that do not share any x are the same line as far as the eye is concerned, so
 * giving each edge its own lane would spend the gap on separations nobody can see and
 * force the lanes closer than they can be told apart.
 */
function assignLane(lanes: Array<Array<[number, number]>>, span: [number, number]): number {
  for (let i = 0; i < lanes.length; i++) {
    const occupied = lanes[i]!;
    const clash = occupied.some(([a0, a1]) => !(a1 + LANE_PAD < span[0] || span[1] + LANE_PAD < a0));
    if (!clash) {
      occupied.push(span);
      return i;
    }
  }
  lanes.push([span]);
  return lanes.length - 1;
}

/** An arrowhead whose tip is `p`, pointing away from `from`. */
function arrowAt(p: Pt, from: Pt): string {
  const half = 4.5;
  const back = 7;
  if (from.y < p.y) return `${p.x - half},${p.y - back} ${p.x + half},${p.y - back} ${p.x},${p.y}`;
  if (from.y > p.y) return `${p.x - half},${p.y + back} ${p.x + half},${p.y + back} ${p.x},${p.y}`;
  if (from.x < p.x) return `${p.x - back},${p.y - half} ${p.x - back},${p.y + half} ${p.x},${p.y}`;
  return `${p.x + back},${p.y - half} ${p.x + back},${p.y + half} ${p.x},${p.y}`;
}

/* ---- Placement ----------------------------------------------------------------------- */

type Side = "top" | "bottom";

interface Wire {
  from: string;
  to: string;
  s: PlacedNode;
  t: PlacedNode;
  sSide: Side;
  tSide: Side;
  /** Gap the run leaving the source travels in, indexed by the row above it. */
  gapA: number;
  /** Gap the run arriving at the target travels in. Equal to gapA when no detour is needed. */
  gapB: number;
  channelX: number | null;
  sx: number;
  tx: number;
  laneA: number;
  laneB: number;
}

const CHIP_CHAR = 5.7;
const CHIP_PAD = 11;

function place(data: GraphData): PlacedNode[] {
  const rankValues = [...new Set(data.nodes.map((n) => n.rank))].sort((a, b) => a - b);

  // Order within a rank by the average position of the neighbours already placed above.
  // Ordering by name or by fan-in would be stable but would drag every connector across
  // the row; this puts a package near the thing that needed it.
  const rows: GraphNode[][] = [];
  let above: GraphNode[] = [];
  for (const rank of rankValues) {
    const members = data.nodes.filter((n) => n.rank === rank);
    const index = new Map(above.map((n, i) => [n.spec, i]));
    const barycentre = (n: GraphNode): number => {
      const seats: number[] = [];
      for (const e of data.edges) {
        if (e.to === n.spec && index.has(e.from)) seats.push(index.get(e.from)!);
        if (e.from === n.spec && index.has(e.to)) seats.push(index.get(e.to)!);
      }
      // No neighbour above is not a position of zero. Sorted to the end instead, which
      // keeps it out of the way of the edges that do have somewhere to be.
      return seats.length ? seats.reduce((a, b) => a + b, 0) / seats.length : Number.MAX_SAFE_INTEGER;
    };
    const keyed = members.map((n, i) => ({ n, i, b: n.aggregate ? Number.MAX_SAFE_INTEGER : barycentre(n) }));
    keyed.sort(
      (a, b) =>
        (a.n.aggregate ? 1 : 0) - (b.n.aggregate ? 1 : 0) ||
        a.b - b.b ||
        b.n.fan_in - a.n.fan_in ||
        a.i - b.i,
    );
    const ordered = keyed.map((k) => k.n);
    rows.push(ordered);
    above = ordered;
  }

  const widest = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const frame = widest * NODE_W + Math.max(0, widest - 1) * COL_GAP;

  const placed: PlacedNode[] = [];
  rows.forEach((members, row) => {
    const rowWidth = members.length * NODE_W + Math.max(0, members.length - 1) * COL_GAP;
    const x0 = (frame - rowWidth) / 2;
    members.forEach((n, i) => {
      const { name, version } = splitSpec(n.spec);
      const x = x0 + i * (NODE_W + COL_GAP);
      const y = row * RANK_STEP;
      // The aggregate's chip carries what it stands for. A fan-in of zero is true of it and
      // says nothing; the number of packages behind it is the only figure that matters.
      const chip = n.aggregate ? `${n.covers} pkgs` : `${n.fan_in} in`;
      const chipW = Math.round(chip.length * CHIP_CHAR + CHIP_PAD);
      placed.push({
        spec: n.spec,
        name,
        version,
        label: truncate(name, NAME_CHARS),
        rank: n.rank,
        row,
        fanIn: n.fan_in,
        aggregate: n.aggregate,
        covers: n.covers,
        x,
        y,
        w: NODE_W,
        h: NODE_H,
        cx: x + NODE_W / 2,
        chip,
        chipX: x + NODE_W - 12 - chipW,
        chipW,
      });
    });
  });
  return placed;
}

/* ---- Routing ------------------------------------------------------------------------- */

export function layoutGraph(data: GraphData): Layout {
  const nodes = place(data);
  const bySpec = new Map(nodes.map((n) => [n.spec, n]));
  const rowCount = nodes.reduce((m, n) => Math.max(m, n.row + 1), 0);
  const frameMid =
    nodes.length > 0 ? nodes.reduce((m, n) => Math.max(m, n.x + n.w), 0) / 2 : 0;

  const wires: Wire[] = [];
  for (const e of data.edges) {
    const s = bySpec.get(e.from);
    const t = bySpec.get(e.to);
    // An edge to a node that did not survive collapsing has nothing to connect, and a
    // self-edge has nowhere to go. Both are dropped rather than drawn as a stub.
    if (!s || !t || s === t) continue;

    let sSide: Side;
    let tSide: Side;
    let gapA: number;
    let gapB: number;
    if (t.row > s.row) {
      sSide = "bottom";
      tSide = "top";
      gapA = s.row;
      gapB = t.row - 1;
    } else if (t.row < s.row) {
      sSide = "top";
      tSide = "bottom";
      gapA = s.row - 1;
      gapB = t.row;
    } else {
      // Within a rank there is no gap between the two boxes to travel in, so the run drops
      // into the gap below the row and comes back up. The last row has no gap below it.
      const below = s.row < rowCount - 1;
      sSide = below ? "bottom" : "top";
      tSide = sSide;
      gapA = below ? s.row : s.row - 1;
      gapB = gapA;
    }
    wires.push({
      from: e.from, to: e.to, s, t, sSide, tSide, gapA, gapB,
      channelX: null, sx: s.cx, tx: t.cx, laneA: 0, laneB: 0,
    });
  }

  // Side channels first: an edge spanning more than one gap needs somewhere to run
  // vertically that is not through the rows it passes, and the attach fanning below sorts
  // by where each connector heads, which for those edges is the channel.
  const channels: Record<"left" | "right", Array<Array<[number, number]>>> = { left: [], right: [] };
  for (const w of wires) {
    if (w.gapA === w.gapB) continue;
    const side = w.s.cx >= frameMid ? "right" : "left";
    // In pixels rather than row numbers, so the clearance the lane test adds means the
    // same thing here as it does for the horizontal runs.
    const span: [number, number] = [
      Math.min(w.s.row, w.t.row) * RANK_STEP,
      Math.max(w.s.row, w.t.row) * RANK_STEP,
    ];
    const lane = assignLane(channels[side], span);
    const outer = side === "right"
      ? nodes.reduce((m, n) => Math.max(m, n.x + n.w), 0)
      : nodes.reduce((m, n) => Math.min(m, n.x), 0);
    w.channelX = side === "right"
      ? outer + CHANNEL_OFFSET + lane * CHANNEL_STEP
      : outer - CHANNEL_OFFSET - lane * CHANNEL_STEP;
  }

  // Attach points, fanned along each side of each box in the order the connectors leave,
  // so two of them do not arrive at the same millimetre of the same edge.
  const groups = new Map<string, Array<{ w: Wire; end: "s" | "t"; key: number }>>();
  const push = (node: PlacedNode, side: Side, w: Wire, end: "s" | "t", key: number) => {
    const id = `${node.spec}|${side}`;
    const list = groups.get(id) ?? [];
    list.push({ w, end, key });
    groups.set(id, list);
  };
  for (const w of wires) {
    push(w.s, w.sSide, w, "s", w.channelX ?? w.t.cx);
    push(w.t, w.tSide, w, "t", w.channelX ?? w.s.cx);
  }
  for (const [id, list] of groups) {
    const node = bySpec.get(id.slice(0, id.lastIndexOf("|")));
    if (!node) continue;
    list.sort((a, b) => a.key - b.key || a.w.from.localeCompare(b.w.from) || a.w.to.localeCompare(b.w.to));
    const xs = fanAttach(list.length, node.cx);
    list.forEach((entry, i) => {
      const x = xs[i]!;
      if (entry.end === "s") entry.w.sx = x;
      else entry.w.tx = x;
    });
  }

  // Lanes inside each gap, so two horizontal runs in the same gap are never the same line.
  const gapLanes = new Map<number, Array<Array<[number, number]>>>();
  const laneFor = (gap: number, span: [number, number]): number => {
    const lanes = gapLanes.get(gap) ?? [];
    gapLanes.set(gap, lanes);
    return assignLane(lanes, span);
  };
  for (const w of wires) {
    if (w.channelX === null) {
      if (w.gapA === w.gapB && w.sSide !== w.tSide && w.sx === w.tx) continue; // straight drop
      w.laneA = laneFor(w.gapA, [Math.min(w.sx, w.tx), Math.max(w.sx, w.tx)]);
      w.laneB = w.laneA;
      continue;
    }
    w.laneA = laneFor(w.gapA, [Math.min(w.sx, w.channelX), Math.max(w.sx, w.channelX)]);
    w.laneB = laneFor(w.gapB, [Math.min(w.tx, w.channelX), Math.max(w.tx, w.channelX)]);
  }

  const gapHeight = RANK_STEP - NODE_H;
  const laneY = (gap: number, lane: number): number => {
    const count = gapLanes.get(gap)?.length ?? 1;
    const usable = gapHeight - 2 * GAP_MARGIN;
    const step = count > 1 ? Math.min(MAX_LANE_GAP, usable / (count - 1)) : 0;
    const top = gap * RANK_STEP + NODE_H;
    const start = top + (gapHeight - (count - 1) * step) / 2;
    return start + lane * step;
  };

  const edges: RoutedEdge[] = wires.map((w) => {
    const sy = w.sSide === "bottom" ? w.s.y + w.s.h : w.s.y;
    const ty = w.tSide === "bottom" ? w.t.y + w.t.h : w.t.y;
    const points: Pt[] = [{ x: w.sx, y: sy }];
    if (w.channelX === null) {
      const y = laneY(w.gapA, w.laneA);
      // A straight line only where the endpoints genuinely share an axis. Anywhere else it
      // would be the diagonal this whole module exists to avoid.
      if (!(w.gapA === w.gapB && w.sSide !== w.tSide && w.sx === w.tx)) {
        points.push({ x: w.sx, y }, { x: w.tx, y });
      }
    } else {
      const yA = laneY(w.gapA, w.laneA);
      const yB = laneY(w.gapB, w.laneB);
      points.push(
        { x: w.sx, y: yA },
        { x: w.channelX, y: yA },
        { x: w.channelX, y: yB },
        { x: w.tx, y: yB },
      );
    }
    points.push({ x: w.tx, y: ty });
    const clean = simplify(points);
    const tip = clean[clean.length - 1]!;
    const before = clean[clean.length - 2] ?? tip;
    return { from: w.from, to: w.to, points: clean, d: elbow(clean), arrow: arrowAt(tip, before) };
  });

  const channelXs = wires.map((w) => w.channelX).filter((x): x is number => x !== null);
  const minX = Math.min(0, ...nodes.map((n) => n.x), ...channelXs) - VIEW_PAD;
  const maxX = Math.max(0, ...nodes.map((n) => n.x + n.w), ...channelXs) + VIEW_PAD;
  const height = Math.max(0, rowCount - 1) * RANK_STEP + NODE_H + 2 * VIEW_PAD;

  const hub = nodes
    .filter((n) => !n.aggregate && n.fanIn > 0)
    .sort((a, b) => b.fanIn - a.fanIn || a.spec.localeCompare(b.spec))[0] ?? null;

  return {
    nodes,
    edges,
    viewBox: `${round2(minX)} ${-VIEW_PAD} ${round2(maxX - minX)} ${round2(height)}`,
    width: round2(maxX - minX),
    height: round2(height),
    hub,
    drawn: nodes.filter((n) => !n.aggregate).length,
  };
}
