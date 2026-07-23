import { useEffect, useState } from "react";
import { api, bytes } from "../lib/api.js";

const RAW = "https://raw.githubusercontent.com/thelorax1775/TorHQ/main/scripts/mount-share.sh";

type Mount = { target: string; source: string; fstype: string; totalBytes?: number; freeBytes?: number };

// TorHQ runs unprivileged and can't mount itself; this page shows what's mounted
// and generates the exact host command to add a share (run it on the PVE host).
export function Mounts() {
  const [mounts, setMounts] = useState<Mount[] | null>(null);
  const [type, setType] = useState<"nfs" | "cifs">("nfs");
  const [remote, setRemote] = useState("");
  const [name, setName] = useState("media");
  const [smbUser, setSmbUser] = useState("");
  const [smbDomain, setSmbDomain] = useState("");
  const [ctid, setCtid] = useState("");
  const [ctPath, setCtPath] = useState("");
  const [opts, setOpts] = useState("");
  const [copied, setCopied] = useState(false);

  const load = () => api<{ mounts: Mount[] }>("/api/status/mounts").then((d) => setMounts(d.mounts)).catch(() => setMounts([]));
  useEffect(() => { load(); }, []);

  const q = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
  function command(): string {
    const p: string[] = [`TORHQ_SHARE_TYPE=${type}`];
    if (remote) p.push(`TORHQ_SHARE_REMOTE=${q(remote)}`);
    if (name) p.push(`TORHQ_SHARE_NAME=${q(name)}`);
    if (type === "cifs" && smbUser) p.push(`TORHQ_SMB_USER=${q(smbUser)}`);
    if (type === "cifs" && smbDomain) p.push(`TORHQ_SMB_DOMAIN=${q(smbDomain)}`);
    if (ctid) p.push(`TORHQ_TARGET_CTID=${q(ctid)}`);
    if (ctPath) p.push(`TORHQ_CT_PATH=${q(ctPath)}`);
    if (opts) p.push(`TORHQ_SHARE_OPTS=${q(opts)}`);
    // NFS can run fully unattended; SMB stays interactive so the password is
    // typed on the host instead of ending up in shell history.
    if (type === "nfs") p.push("TORHQ_NONINTERACTIVE=1");
    return `${p.join(" ")} \\\n  bash -c "$(curl -fsSL ${RAW})"`;
  }

  async function copy() {
    try { await navigator.clipboard.writeText(command()); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  }

  return (
    <div>
      <h1>Mounts</h1>

      <div className="card">
        <h2>Mounted network shares</h2>
        {(!mounts || mounts.length === 0) && (
          <p className="muted small">No NFS/SMB shares mounted in this container yet. Build a command below and run it on the Proxmox host.</p>
        )}
        {mounts?.map((m) => {
          const cap = typeof m.totalBytes === "number";
          const pct = cap && m.totalBytes ? (m.totalBytes - m.freeBytes!) / m.totalBytes : 0;
          return (
            <div key={m.target} style={{ marginBottom: 10 }}>
              <div className="flex" style={{ justifyContent: "space-between" }}>
                <span className="small">{m.target} <span className="muted">· {m.fstype}</span></span>
                <span className="small muted">{cap ? `${bytes(m.freeBytes!)} free / ${bytes(m.totalBytes!)}` : "unreachable"}</span>
              </div>
              <div className="small muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.source}</div>
              {cap && <div className="bar"><span style={{ width: `${Math.round(pct * 100)}%` }} /></div>}
            </div>
          );
        })}
      </div>

      <div className="card">
        <h2>Add a share</h2>
        <p className="muted small">
          TorHQ runs unprivileged and can't mount from inside its container. Fill this in to generate
          the exact command, then run it on the <strong>Proxmox host</strong> shell. It mounts the share
          on the host and (if you give a container ID) bind-mounts it into that LXC — e.g. the one running qBittorrent.
        </p>

        <label>Type</label>
        <select value={type} onChange={(e) => setType(e.target.value as "nfs" | "cifs")}>
          <option value="nfs">NFS</option>
          <option value="cifs">SMB / CIFS</option>
        </select>

        <label>Remote share {type === "nfs" ? "(server:/export)" : "(//server/share)"}</label>
        <input value={remote} onChange={(e) => setRemote(e.target.value)}
          placeholder={type === "nfs" ? "192.168.1.10:/volume1/media" : "//192.168.1.10/media"} />

        <label>Short name (a-z0-9-)</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="media" />

        {type === "cifs" && (
          <>
            <label>SMB username</label>
            <input value={smbUser} onChange={(e) => setSmbUser(e.target.value)} />
            <label>SMB domain/workgroup (optional)</label>
            <input value={smbDomain} onChange={(e) => setSmbDomain(e.target.value)} />
            <p className="muted small" style={{ marginTop: 6 }}>The SMB password is entered on the host when you run the command — it's never put in the command or sent to TorHQ.</p>
          </>
        )}

        <label>Bind into container ID (optional — e.g. qBittorrent's CTID)</label>
        <input value={ctid} onChange={(e) => setCtid(e.target.value)} placeholder="105" inputMode="numeric" />
        {ctid && (
          <>
            <label>Mountpoint inside that container</label>
            <input value={ctPath} onChange={(e) => setCtPath(e.target.value)} placeholder={`/mnt/${name || "media"}`} />
          </>
        )}

        <label>Extra mount options (optional — e.g. uid=101000,gid=101000 for write access)</label>
        <input value={opts} onChange={(e) => setOpts(e.target.value)} placeholder="uid=101000,gid=101000" />

        <label style={{ marginTop: 12 }}>Run this on the Proxmox host</label>
        <pre style={{ background: "var(--panel2)", padding: 12, borderRadius: 8, overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{command()}</pre>
        <div className="flex" style={{ marginTop: 8 }}>
          <button className="btn primary" onClick={copy} disabled={!remote || !name}>{copied ? "Copied ✓" : "Copy command"}</button>
          <button className="btn" onClick={load}>Refresh mounts</button>
        </div>
      </div>
    </div>
  );
}
