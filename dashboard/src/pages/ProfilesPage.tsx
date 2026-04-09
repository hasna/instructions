import { useEffect, useState } from "react";
import { api, type Profile } from "../api";

const S = {
  card: { background: "#161b22", border: "1px solid #21262d", borderRadius: 8, padding: 20, marginBottom: 12 } as React.CSSProperties,
  input: { background: "#21262d", border: "1px solid #30363d", borderRadius: 6, padding: "6px 10px", color: "#e6edf3", fontSize: 13, flex: 1 } as React.CSSProperties,
  btn: (primary?: boolean) => ({ background: primary ? "#238636" : "#21262d", color: "#e6edf3", border: "1px solid #30363d", borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontSize: 13 }) as React.CSSProperties,
};

export default function ProfilesPage() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [newName, setNewName] = useState("");
  const [selected, setSelected] = useState<(Profile & { configs: { id: string; name: string; slug: string; category: string }[] }) | null>(null);
  const [msg, setMsg] = useState("");

  const load = async () => setProfiles(await api.profiles.list());

  useEffect(() => { load(); }, []);

  const create = async () => {
    if (!newName.trim()) return;
    await api.profiles.create(newName.trim());
    setNewName(""); load();
  };

  const apply = async (id: string, dryRun = false) => {
    const results = await api.profiles.apply(id, dryRun);
    const changed = results.filter((r) => r.changed).length;
    setMsg(`${dryRun ? "[dry-run] " : ""}Applied ${changed}/${results.length} changed`);
    setTimeout(() => setMsg(""), 3000);
  };

  const loadProfile = async (p: Profile) => {
    const full = await api.profiles.get(p.id);
    setSelected(full as typeof selected);
  };

  return (
    <div style={{ display: "flex", gap: 16 }}>
      <div style={{ width: 340 }}>
        <div style={{ ...S.card, display: "flex", gap: 8, marginBottom: 16 }}>
          <input style={S.input} placeholder="New profile name…" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} />
          <button style={S.btn(true)} onClick={create}>Create</button>
        </div>
        {profiles.map((p) => (
          <div key={p.id} style={{ ...S.card, cursor: "pointer", border: selected?.id === p.id ? "1px solid #388bfd" : "1px solid #21262d" }} onClick={() => loadProfile(p)}>
            <div style={{ fontWeight: "bold" }}>{p.name}</div>
            <div style={{ color: "#8b949e", fontSize: 12, marginTop: 4 }}>{p.slug}</div>
            {p.description && <div style={{ color: "#8b949e", fontSize: 12, marginTop: 4 }}>{p.description}</div>}
          </div>
        ))}
      </div>

      {selected && (
        <div style={{ flex: 1 }}>
          <div style={S.card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h2 style={{ margin: 0 }}>{selected.name}</h2>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {msg && <span style={{ color: "#3fb950", fontSize: 13 }}>{msg}</span>}
                <button style={S.btn()} onClick={() => apply(selected.id, true)}>Dry Run</button>
                <button style={S.btn(true)} onClick={() => apply(selected.id)}>Apply All</button>
              </div>
            </div>
            {(selected.selectors.os?.length || selected.selectors.arch?.length || selected.selectors.hostnames?.length) && (
              <div style={{ color: "#8b949e", fontSize: 12, marginBottom: 12 }}>
                Match:
                {selected.selectors.os?.length ? ` os=${selected.selectors.os.join(",")}` : ""}
                {selected.selectors.arch?.length ? ` arch=${selected.selectors.arch.join(",")}` : ""}
                {selected.selectors.hostnames?.length ? ` host=${selected.selectors.hostnames.join(",")}` : ""}
              </div>
            )}
            {Object.keys(selected.variables).length > 0 && (
              <div style={{ color: "#8b949e", fontSize: 12, marginBottom: 16 }}>
                Vars: {Object.entries(selected.variables).map(([key, value]) => `${key}=${value}`).join(", ")}
              </div>
            )}
            {selected.configs.length === 0 ? (
              <div style={{ color: "#8b949e" }}>No configs in this profile.</div>
            ) : (
              selected.configs.map((c) => (
                <div key={c.id} style={{ padding: "8px 12px", background: "#0d1117", borderRadius: 6, marginBottom: 8, display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={{ background: "#1f6feb", borderRadius: 4, padding: "2px 6px", fontSize: 11, color: "#fff" }}>{c.category}</span>
                  <span style={{ fontSize: 13 }}>{c.name}</span>
                  <code style={{ color: "#8b949e", fontSize: 11, marginLeft: "auto" }}>{c.slug}</code>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
