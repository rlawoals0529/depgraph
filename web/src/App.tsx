import { useCallback, useMemo, useState } from "react";
import { Ticker, stagger } from "./lib/motion.js";
import { layoutGraph, type GraphData } from "./lib/layout.js";

const API = import.meta.env.VITE_API ?? "http://127.0.0.1:8100";

interface Size {
  unique_packages: number; paths: number; deduped_bytes: number; naive_bytes: number;
  max_depth_seen: number; unknown_size: number; size_is_partial: boolean;
}
interface Dup { name: string; versions: number; which: string[] }
interface Lic { license: string; packages: number }
interface Node { name: string; version: string; depth: number; license: string | null; unpacked_bytes: number | null }

const mb = (n: number) => `${(n / 1_048_576).toFixed(2)} MB`;

/**
 * The graph, drawn as boxes in rank rows with orthogonal connectors between them.
 *
 * Every number here comes out of `layoutGraph`; nothing is positioned in the markup. That
 * split is what makes the layout rules testable, because "no diagonals" and "connectors
 * 12px apart" are claims about arithmetic, not about React.
 */
function DepGraph({ data }: { data: GraphData }) {
  const g = useMemo(() => layoutGraph(data), [data]);
  const hub = g.hub;

  return (
    <>
      <svg
        className="dg"
        viewBox={g.viewBox}
        width={g.width}
        height={g.height}
        role="img"
        aria-label={`${g.drawn} of ${data.total} packages, in ${data.edges.length} dependency links`}
      >
        <g className="dg-wires">
          {g.edges.map((e) => (
            <g key={`${e.from}>${e.to}`}>
              <path d={e.d} />
              <polygon points={e.arrow} />
            </g>
          ))}
        </g>
        {g.nodes.map((n) => {
          const classes = ["dg-node"];
          if (n.aggregate) classes.push("is-folded");
          // The one accented thing on the page: the chip on the box the most other
          // packages depend on. Colouring four things accents nothing.
          if (hub && n.spec === hub.spec) classes.push("is-hub");
          return (
            <g className={classes.join(" ")} key={n.spec}>
              <rect className="dg-box" x={n.x} y={n.y} width={n.w} height={n.h} rx={6} />
              <text className="dg-name" x={n.x + 14} y={n.y + 24}>{n.label}</text>
              <text className="dg-ver" x={n.x + 14} y={n.y + 41}>
                {n.aggregate ? "not drawn" : n.version}
              </text>
              <rect className="dg-chip" x={n.chipX} y={n.y + 9} width={n.chipW} height={16} rx={2} />
              <text className="dg-chip-num" x={n.chipX + n.chipW / 2} y={n.y + 20.5}>{n.chip}</text>
            </g>
          );
        })}
      </svg>
      <p className="note">
        This drew <b>{g.drawn}</b> of <b>{data.total}</b> packages. The other{" "}
        <b>{data.collapsed}</b> are folded into the dashed box: they are installed, they are
        just not in the picture. The chip on each box counts the packages that depend on it,
        which is the one thing a tree cannot tell you
        {hub && <> - <b>{hub.name}@{hub.version}</b> is reached by {hub.fanIn} of them, and a
        tree would draw it at least {hub.fanIn} separate times</>}.
      </p>
    </>
  );
}

export default function App() {
  const [name, setName] = useState("express");
  const [version, setVersion] = useState("4.21.2");
  const [target, setTarget] = useState("ms");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<Size | null>(null);
  const [dups, setDups] = useState<Dup[]>([]);
  const [lics, setLics] = useState<Lic[]>([]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [path, setPath] = useState<string[] | null>(null);
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);

  const call = useCallback(async (p: string, init?: RequestInit) => {
    const r = await fetch(`${API}/${p}`, init);
    const body = await r.json().catch(() => ({}));
    // Surface the API's own message. A generic "request failed" throws away the one thing
    // that says what to do next.
    if (!r.ok) throw new Error(body.detail ?? `${r.status} from the API`);
    return body;
  }, []);

  const guard = useCallback(async (label: string, fn: () => Promise<void>) => {
    setError(null); setBusy(label);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }, []);

  /** Everything a previous package left behind. */
  const clear = useCallback(() => {
    setSize(null);
    setDups([]);
    setLics([]);
    setNodes([]);
    setPath(null);
    setGraph(null);
    setGraphError(null);
  }, []);

  const analyse = () =>
    guard("Crawling the registry", async () => {
      // Drop the last package's answers before asking about this one. A failed crawl used
      // to leave them on screen underneath the error, so the page showed the name you just
      // typed above the numbers for the package you typed before it.
      clear();
      const q = `${encodeURIComponent(name)}?version=${encodeURIComponent(version)}`;
      await call(`crawl/${q}&depth=6`, { method: "POST" });
      const [s, d, l, t, g] = await Promise.all([
        call(`size/${q}`), call(`duplicates/${q}`), call(`licenses/${q}`), call(`tree/${q}`),
        // The graph is a second reading of the same crawl, so a failure here costs the
        // picture and not the figures. Kept as its own outcome rather than swallowed:
        // "the graph is missing" and "the graph is empty" are different answers.
        call(`graph/${q}`).then(
          (body: GraphData) => body,
          (e: unknown) => (e instanceof Error ? e.message : String(e)),
        ),
      ]);
      setSize(s); setDups(d.duplicates); setLics(l.licenses);
      if (typeof g === "string") setGraphError(g); else setGraph(g);
      setNodes([...t.nodes].sort((a: Node, b: Node) => a.depth - b.depth || a.name.localeCompare(b.name)));
      setPath(null);
    });

  const explain = () =>
    guard("Finding the path", async () => {
      const q = `${encodeURIComponent(name)}?version=${encodeURIComponent(version)}&target=${encodeURIComponent(target)}`;
      setPath((await call(`why/${q}`)).path);
    });

  return (
    <div className="wrap">
      <h1>dep<span>graph</span></h1>
      <p className="tagline">
        What a dependency actually costs, and why it is there. A dependency graph is not a
        tree. One package is reachable by many paths, so counting paths overstates everything.
      </p>

      <section className="panel">
        <h2>Package</h2>
        <div className="row">
          <input className="name" type="text" value={name} onChange={(e) => setName(e.target.value)} aria-label="Package name" />
          <input className="version" type="text" value={version} onChange={(e) => setVersion(e.target.value)} aria-label="Exact version" />
          <button className="primary" onClick={analyse} disabled={!!busy}>Analyse</button>
        </div>
        <p className="note">An exact version. A range has no single answer without a full resolver, and guessing one would be worse than refusing.</p>
        {busy && <p className="note">{busy}…</p>}
        {error && <p className="err">{error}</p>}
      </section>

      {size && (
        <>
          <section className="panel">
            <h2>Cost</h2>
            <div className="grid">
              <div className="metric"><b><Ticker value={size.unique_packages} /></b><span>packages</span></div>
              <div className="metric"><b><Ticker value={size.paths} /></b><span>paths to them</span></div>
              <div className="metric"><b><Ticker value={size.deduped_bytes / 1_048_576} decimals={2} suffix=" MB" /></b><span>real size</span></div>
              <div className="metric warn"><b><Ticker value={size.naive_bytes / 1_048_576} decimals={2} suffix=" MB" /></b><span>if you counted paths</span></div>
              <div className="metric"><b><Ticker value={size.max_depth_seen} /></b><span>deepest chain</span></div>
            </div>
            <p className="note">
              Counting paths overstates the download by{" "}
              <b>{(size.naive_bytes / Math.max(1, size.deduped_bytes)).toFixed(1)}×</b>: a package
              reachable forty ways is still fetched once.
              {size.size_is_partial && (
                <> The registry publishes no size for <b>{size.unknown_size}</b> of these, so the
                real figure is a floor rather than a total.</>
              )}
            </p>
          </section>

          {(graph || graphError) && (
            <section className="panel">
              <h2>Graph</h2>
              {graph ? (
                <DepGraph data={graph} />
              ) : (
                <p className="err">
                  The graph could not be built: {graphError}. Every figure above is unaffected.
                </p>
              )}
            </section>
          )}

          <section className="panel">
            <h2>Why is it here</h2>
            <div className="row">
              <input className="target" type="text" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Package to explain" />
              <button onClick={explain} disabled={!!busy}>Explain</button>
            </div>
            {path && (
              <div className="path" style={{ marginTop: 18 }}>
                {path.map((p, i) => (
                  <span key={i} className="hop">
                    {i > 0 && <span className="arrow">→</span>}
                    <span className="chip">{p}</span>
                  </span>
                ))}
              </div>
            )}
            <p className="note">The shortest route from your package to that one.</p>
          </section>

          {dups.length > 0 && (
            <section className="panel">
              <h2>Installed at more than one version</h2>
              {dups.map((d) => (
                <div className="dup" key={d.name}>
                  <b>{d.name}</b>
                  <span className="versions">
                    {d.which.map((v) => <span key={v} className={d.versions > 2 ? "chip hot" : "chip"}>{v}</span>)}
                  </span>
                </div>
              ))}
              <p className="note">Every extra version is a separate copy on disk, and two of them can be in memory at once.</p>
            </section>
          )}

          <section className="panel">
            <h2>Licences</h2>
            <div className="grid">
              {lics.map((l, i) => (
                <div className="metric rise" key={l.license} style={stagger(i)}>
                  <b><Ticker value={l.packages} /></b><span>{l.license}</span>
                </div>
              ))}
            </div>
            <p className="note">Counted per package, not per path, so a shared dependency is not double-counted in an audit.</p>
          </section>

          <section className="panel">
            <h2>Everything it reaches ({nodes.length})</h2>
            <div className="deps">
              {nodes.map((n) => (
                <div className="dep" key={`${n.name}@${n.version}`}>
                  <span className="depth">depth {n.depth}</span>
                  <span>{n.name}<span className="ver">@{n.version}</span></span>
                  <span className="lic">{n.license ?? "unknown"}</span>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
