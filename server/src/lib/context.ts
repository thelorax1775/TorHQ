import type { Buffer } from "node:buffer";
import type { Env } from "../config/env.js";
import { deriveKey } from "./crypto.js";
import { SERVICE_KINDS } from "../config/store.js";

export interface AppContext {
  env: Env;
  masterKey: Buffer;
  serviceKinds: readonly string[];
}

export function makeContext(env: Env): AppContext {
  return {
    env,
    masterKey: deriveKey(env.TORHQ_MASTER_KEY),
    serviceKinds: SERVICE_KINDS,
  };
}
