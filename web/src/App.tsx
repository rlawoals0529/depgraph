import { useCallback, useState } from "react";
import { Ticker, stagger } from "./lib/motion.js";

const API = import.meta.env.VITE_API ?? "http://127.0.0.1:8100";

interface Size {
  unique_packages: number; paths: number; deduped_bytes: number; naive_bytes: number;
  max_depth_seen: number; unknown_size: number; size_is_partial: boolean;
}
interface Dup { name: string; versions: number; which: string[] }
interface Lic { license: string; packages: number }
interface Node { name: string; version: string; depth: number; license: string | null; unpacked_bytes: number | null }

const mb = (n: number) => `${(n / 1_048_576).toFixed(2)} MB`;

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
  }, []);

  const analyse = () =>
    guard("Crawling the registry", async () => {
      // Drop the last package's answers before asking about this one. A failed crawl used
      // to leave them on screen underneath the error, so the page showed the name you just
      // typed above the numbers for the package you typed before it.
      clear();
      const q = `${encodeURIComponent(name)}?version=${encodeURIComponent(version)}`;
      await call(`crawl/${q}&depth=6`, { method: "POST" });
      const [s, d, l, t] = await Promise.all([
        call(`size/${q}`), call(`duplicates/${q}`), call(`licenses/${q}`), call(`tree/${q}`),
      ]);
      setSize(s); setDups(d.duplicates); setLics(l.licenses);
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
