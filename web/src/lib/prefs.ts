/**
 * Local UI preferences.
 *
 * These are per-browser, not per-account: they change nothing on the server and
 * nothing about what TorHQ does to the media stack, so they live in
 * localStorage and survive a logout. `applyPrefs()` runs once at boot — before
 * React mounts — so the chosen theme paints on the first frame instead of
 * flashing the default one.
 */
export type Theme = "system" | "dark" | "light";

export interface Prefs {
  theme: Theme;
  /** Multiplier on every poll interval. 1 = as designed, 3 = a third as often. */
  pollRate: number;
}

export const DEFAULT_PREFS: Prefs = { theme: "system", pollRate: 1 };

const KEY = "torhq.prefs";
const THEMES: Theme[] = ["system", "dark", "light"];

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      theme: THEMES.includes(parsed.theme as Theme) ? (parsed.theme as Theme) : DEFAULT_PREFS.theme,
      pollRate: typeof parsed.pollRate === "number" && parsed.pollRate >= 1 && parsed.pollRate <= 20
        ? parsed.pollRate
        : DEFAULT_PREFS.pollRate,
    };
  } catch {
    // Private-mode browsers and corrupt JSON both land here; defaults are fine.
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs: Prefs): void {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* storage disabled */ }
}

const LIGHT_QUERY = "(prefers-color-scheme: light)";

/** "system" resolved against the OS; anything else is taken literally. */
export function resolveTheme(theme: Theme): "dark" | "light" {
  if (theme !== "system") return theme;
  return typeof window !== "undefined" && window.matchMedia?.(LIGHT_QUERY).matches ? "light" : "dark";
}

/**
 * Push preferences into the places that act on them: a concrete `data-theme` on
 * the root element (the stylesheet defines the light palette against that
 * attribute, so "system" has to be resolved here) and the polling layer's rate.
 */
export function applyPrefs(prefs: Prefs, setPollRate: (n: number) => void): void {
  document.documentElement.setAttribute("data-theme", resolveTheme(prefs.theme));
  setPollRate(prefs.pollRate);
}

/**
 * Apply the stored preferences and keep following the OS while the app is open.
 * Called once from the entry point, before React's first render, so the right
 * palette paints immediately instead of flashing.
 */
export function initPrefs(setPollRate: (n: number) => void): void {
  applyPrefs(loadPrefs(), setPollRate);
  window.matchMedia?.(LIGHT_QUERY).addEventListener("change", () => {
    const prefs = loadPrefs();
    if (prefs.theme === "system") applyPrefs(prefs, setPollRate);
  });
}
