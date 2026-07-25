/**
 * Mutation helper. Every write in the SPA goes through this so that pending
 * state, the server's error message, and cache invalidation are handled the
 * same way everywhere.
 *
 * `run` never throws: it resolves to a discriminated result, so a call site can
 * branch without a try/catch and an unhandled rejection can't escape a click
 * handler.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiSend, errorMessage } from "./api.js";
import { invalidate } from "./usePolled.js";

export type MutationResult<R> = { ok: true; data: R } | { ok: false; error: string };

export interface Mutation<A extends unknown[], R> {
  run: (...args: A) => Promise<MutationResult<R>>;
  pending: boolean;
  error: string | null;
  data: R | null;
  reset: () => void;
}

export interface MutationOptions {
  /** Paths (prefixes) whose polled data should be refetched after success. */
  invalidates?: string[];
}

export function useMutation<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  options: MutationOptions = {},
): Mutation<A, R> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<R | null>(null);

  // Keep the latest closure without making `run` change identity every render.
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const optRef = useRef(options);
  optRef.current = options;
  // Don't set state after unmount — a dialog is often closed while its request
  // is still in flight.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const run = useCallback(async (...args: A): Promise<MutationResult<R>> => {
    setPending(true);
    setError(null);
    try {
      const result = await fnRef.current(...args);
      const paths = optRef.current.invalidates;
      if (paths?.length) await invalidate(...paths);
      if (alive.current) { setData(result); setPending(false); }
      return { ok: true, data: result };
    } catch (e) {
      const message = errorMessage(e);
      if (alive.current) { setError(message); setPending(false); }
      return { ok: false, error: message };
    }
  }, []);

  const reset = useCallback(() => { setError(null); setData(null); }, []);

  return { run, pending, error, data, reset };
}

/** Shorthand for the common `POST <path>` mutation. */
export function usePost<B = unknown, R = unknown>(
  path: string,
  options: MutationOptions = {},
): Mutation<[B?], R> {
  return useMutation<[B?], R>((body?: B) => apiSend<R>(path, "POST", body), options);
}
