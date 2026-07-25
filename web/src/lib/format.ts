/** Formatting helpers. Shared so every table renders sizes/speeds identically. */

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

export function bytes(n: number | null | undefined, digits = 1): string {
  if (n == null || !isFinite(n)) return "—";
  if (n <= 0) return "0 B";
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), UNITS.length - 1);
  const v = n / 1024 ** i;
  return `${v.toFixed(i === 0 ? 0 : v >= 100 ? 0 : digits)} ${UNITS[i]}`;
}

export function speed(n: number | null | undefined): string {
  if (n == null || !isFinite(n) || n <= 0) return "—";
  return `${bytes(n)}/s`;
}

/** qBittorrent reports 8640000 (100 days) for "unknown/never". */
export function eta(seconds: number | null | undefined): string {
  if (seconds == null || !isFinite(seconds) || seconds <= 0 || seconds >= 8640000) return "∞";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

export function percent(fraction: number | null | undefined, digits = 0): string {
  if (fraction == null || !isFinite(fraction)) return "—";
  return `${(Math.max(0, Math.min(1, fraction)) * 100).toFixed(digits)}%`;
}

/** Relative time from an ISO string, epoch-ms, or epoch-seconds number. */
export function ago(value: string | number | null | undefined): string {
  const ms = toMillis(value);
  if (ms == null) return "—";
  const diff = Date.now() - ms;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? "ago" : "from now";
  const steps: Array<[number, string]> = [
    [1000, "s"], [60_000, "m"], [3_600_000, "h"], [86_400_000, "d"],
  ];
  if (abs < 45_000) return "just now";
  if (abs < 3_600_000) return `${Math.round(abs / steps[1]![0])}m ${suffix}`;
  if (abs < 86_400_000) return `${Math.round(abs / steps[2]![0])}h ${suffix}`;
  if (abs < 30 * 86_400_000) return `${Math.round(abs / steps[3]![0])}d ${suffix}`;
  return new Date(ms).toLocaleDateString();
}

export function dateTime(value: string | number | null | undefined): string {
  const ms = toMillis(value);
  return ms == null ? "—" : new Date(ms).toLocaleString();
}

export function timeOnly(value: string | number | null | undefined): string {
  const ms = toMillis(value);
  return ms == null ? "—" : new Date(ms).toLocaleTimeString();
}

function toMillis(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    if (!isFinite(value) || value <= 0) return null;
    // Epoch seconds (qBittorrent `addedOn`) vs epoch millis.
    return value < 1e12 ? value * 1000 : value;
  }
  const t = Date.parse(value);
  return isNaN(t) ? null : t;
}

/** Truncate long identifiers for display without hiding that they are longer. */
export function shortId(id: string | null | undefined, len = 8): string {
  if (!id) return "—";
  return id.length <= len ? id : `${id.slice(0, len)}…`;
}

export function titleCase(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
