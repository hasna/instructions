import { useEffect, useState } from "react";
import { api, type Machine } from "../api";

const S = {
  card: { background: "#161b22", border: "1px solid #21262d", borderRadius: 8, padding: 20, marginBottom: 12 } as React.CSSProperties,
};

export default function MachinesPage() {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [stats, setStats] = useState<Record<string, number>>({});

  useEffect(() => {
    api.machines.list().then(setMachines);
    api.stats().then(setStats);
  }, []);

  return (
    <div>
      <div style={S.card}>
        <h2 style={{ margin: "0 0 16px" }}>Config Stats</h2>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          {Object.entries(stats).map(([key, count]) => (
            <div key={key} style={{ textAlign: "center" }}>
              <div style={{ fontSize: 28, fontWeight: "bold", color: "#58a6ff" }}>{count}</div>
              <div style={{ color: "#8b949e", fontSize: 12 }}>{key}</div>
            </div>
          ))}
        </div>
      </div>

      <h2 style={{ margin: "0 0 16px" }}>Machines</h2>
      {machines.length === 0 ? (
        <div style={{ color: "#8b949e" }}>No machines recorded yet. Apply a config to register this machine.</div>
      ) : (
        machines.map((m) => (
          <div key={m.id} style={S.card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: "bold", fontSize: 15 }}>{m.hostname}</div>
                <div style={{ color: "#8b949e", fontSize: 12, marginTop: 4 }}>
                  {[m.os, m.arch].filter(Boolean).join(" • ")}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ color: "#8b949e", fontSize: 12 }}>Last applied</div>
                <div style={{ fontSize: 13, marginTop: 4 }}>
                  {m.last_applied_at ? new Date(m.last_applied_at).toLocaleString() : <span style={{ color: "#8b949e" }}>never</span>}
                </div>
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
