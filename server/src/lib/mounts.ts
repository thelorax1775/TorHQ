import { readFileSync, statfsSync } from "node:fs";

/**
 * Read-only visibility into network (NFS/SMB) mounts visible inside this
 * container. TorHQ never mounts anything itself — shares are mounted on the
 * Proxmox host and bind-mounted in (see scripts/mount-share.sh). This just
 * surfaces what's mounted so the dashboard can show it and its free space.
 */
export interface NetworkMount {
  target: string;
  source: string;
  fstype: string;
  totalBytes?: number;
  freeBytes?: number;
}

const NETWORK_FS = new Set(["nfs", "nfs4", "cifs", "smb3", "smbfs"]);

/** Decode mountinfo's octal escapes (\040 space, \011 tab, \012 nl, \134 \). */
function unescape(s: string): string {
  return s.replace(/\\(040|011|012|134)/g, (_, o) =>
    ({ "040": " ", "011": "\t", "012": "\n", "134": "\\" } as Record<string, string>)[o]!);
}

/**
 * Parse the contents of /proc/self/mountinfo and return only network mounts.
 * Format: `id parent maj:min root mountPoint opts [tags...] - fstype source superOpts`.
 */
export function parseNetworkMounts(mountinfo: string): NetworkMount[] {
  const seen = new Set<string>();
  const out: NetworkMount[] = [];
  for (const line of mountinfo.split("\n")) {
    const sep = line.indexOf(" - ");
    if (sep === -1) continue;
    const pre = line.slice(0, sep).split(" ");
    const post = line.slice(sep + 3).split(" ");
    const target = pre[4];
    const fstype = post[0];
    const source = post[1] ?? "";
    if (!target || !fstype || !NETWORK_FS.has(fstype)) continue;
    const t = unescape(target);
    if (seen.has(t)) continue;
    seen.add(t);
    out.push({ target: t, source: unescape(source), fstype });
  }
  return out;
}

/** Live network mounts with best-effort capacity, sorted by mountpoint. */
export function listNetworkMounts(): NetworkMount[] {
  let mountinfo: string;
  try {
    mountinfo = readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return []; // non-Linux / no procfs
  }
  return parseNetworkMounts(mountinfo)
    .map((m) => {
      try {
        const s = statfsSync(m.target);
        return { ...m, totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
      } catch {
        return m; // mounted but currently unreachable
      }
    })
    .sort((a, b) => a.target.localeCompare(b.target));
}
