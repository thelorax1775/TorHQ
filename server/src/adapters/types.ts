/** Common adapter contract so new services can be added uniformly. */
export interface HealthResult {
  healthy: boolean;
  version?: string;
  detail?: string;
  latencyMs?: number;
}

export interface ServiceAdapter {
  readonly kind: string;
  /** Fully functional integration vs. initially stubbed (documented in README). */
  readonly status: "functional" | "stubbed";
  health(): Promise<HealthResult>;
}

export interface AdapterConfig {
  baseUrl: string;
  secret: string; // apiKey OR "username:password"
  extra?: Record<string, unknown>;
}

/** Arr-family (Radarr/Sonarr/Lidarr) shared read/write surface. */
export interface ArrItem {
  id?: number;
  title: string;
  year?: number;
  status?: string;
  monitored?: boolean;
  hasFile?: boolean;
}
export interface ArrActivity {
  id: number;
  eventType: string;
  title: string;
  date: string;
}

/**
 * A normalized lookup result the user chooses from before anything is added.
 * `selectionId` is a stable, flavor-specific foreign id (tmdb/tvdb/musicbrainz)
 * used to re-select the exact candidate on submit, so TorHQ never blindly adds
 * the first search hit.
 */
export interface ArrCandidate {
  selectionId: string;
  title: string;
  subtitle?: string; // e.g. artist name for an album
  year?: number;
  poster?: string;
  overview?: string;
  alreadyAdded: boolean; // the lookup already carries a library id
}
