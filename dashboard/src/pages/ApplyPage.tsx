import { useEffect, useState } from "react";
import { api, type Config, type ApplyResult } from "../api";

const S = {
  card: { background: "#161b22", border: "1px solid #21262d", borderRadius: 8, padding: 20, marginBottom: 12 } as React.CSSProperties,
  input: { background: "#21262d", border: "1px solid #30363d", borderRadius: 6, padding: "6px 10px", color: "#e6edf3", fontSize: 13, flex: 1 } as React.CSSProperties,
  btn: (color?: string) => ({ background: color ?? "#21262d", color: "#e6edf3", border: "1px solid #30363d", borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontSize: 13 }) as React.CSSProperties,
};

export default function ApplyPage() {
  const [configs, setConfigs] = useState<Config[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [error, setError] = useState("");
  const [syncDir, setSyncDir] = useState("~/.claude");
  const [syncResult, setSyncResult] = useState<{ added: number; updated: number; unchanged: number } | null>(null);

  useEffect(() => {
    api.configs.list().then((cs) => setConfigs(cs.filter((c) => c.kind === "file")));
  }, []);

  const preview = async () => {
    if (!selected) return;
    setError("");
    try { setResult(await api.configs.apply(selected, true)); } catch (e) { setError(String(e)); }
  };

  const apply = async () => {
    if (!selected) return;
    setError("");
    try { setResult(await api.configs.apply(selected, false)); } catch (e) { setError(String(e)); }
  };

  const sync = async () => {
    try {
      const r = await api.sync(syncDir);
      setSyncResult(r);
    } catch (e) { setError(String(e)); }
  };

  return (
    <div>
      <div style={S.card}>
        <h3 style={{ margin: "0 0 16px" }}>Apply a Config to Disk</h3>
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <select
            style={{ ...S.input, flex: "none", width: 300 }}
            value={selected}
            onChange={(e) => { setSelected(e.target.value); setResult(null); }}
          >
            <option value="">Select a config…</option>
            {configs.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.slug})</option>)}
          </select>
          <button style={S.btn()} onClick={preview} disabled={!selected}>Preview (dry-run)</button>
          <button style={S.btn("#238636")} onClick={apply} disabled={!selected}>Apply to Disk</button>
        </div>

        {error && <div style={{ color: "#f85149", fontSize: 13, marginBottom: 12 }}>{error}</div>}

        {result && (
          <div>
            <div style={{ display: "flex", gap: 12, marginBottom: 12, fontSize: 13 }}>
              <span style={{ color: result.dry_run ? "#d29922" : "#3fb950" }}>{result.dry_run ? "⚡ Dry run" : "✓ Applied"}</span>
              <span style={{ color: "#8b949e" }}>{result.path}</span>
              {/* Labelled with result.path, so it shows that path's own verdict. */}
              <span style={{ color: result.primary_changed ? "#3fb950" : "#8b949e" }}>{result.primary_changed ? "Changed" : "Unchanged"}</span>
            </div>
            {result.primary_changed && (
              <div>
                <div style={{ color: "#8b949e", fontSize: 12, marginBottom: 6 }}>Diff (stored → disk):</div>
                <pre style={{ background: "#0d1117", borderRadius: 6, padding: 14, overflow: "auto", maxHeight: 300, fontSize: 11, margin: 0 }}>
                  {result.previous_content !== null
                    ? result.previous_content.split("\n").map((line, i) => <div key={i} style={{ color: "#f85149" }}>-{line}</div>)
                    : <div style={{ color: "#8b949e" }}>(new file)</div>
                  }
                  {result.new_content.split("\n").map((line, i) => <div key={i} style={{ color: "#3fb950" }}>+{line}</div>)}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>

      <div style={S.card}>
        <h3 style={{ margin: "0 0 16px" }}>Sync Directory from Disk</h3>
        <div style={{ display: "flex", gap: 8 }}>
          <input style={S.input} value={syncDir} onChange={(e) => setSyncDir(e.target.value)} placeholder="~/.claude" />
          <button style={S.btn("#238636")} onClick={sync}>Sync from Disk</button>
        </div>
        {syncResult && (
          <div style={{ marginTop: 12, fontSize: 13, color: "#3fb950" }}>
            ✓ Added: {syncResult.added} · Updated: {syncResult.updated} · Unchanged: {syncResult.unchanged}
          </div>
        )}
      </div>
    </div>
  );
}
