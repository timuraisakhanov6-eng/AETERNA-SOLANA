/**
 * =========================================================
 * AETERNA — Container upload feature flag (Stage 3)
 * =========================================================
 *
 * Gates the AETERNA media-container write path. The existing
 * multi-DataItem upload path remains the default and MUST stay
 * byte-for-byte behaviourally unchanged while this is OFF.
 *
 * DELIBERATE PROPERTIES
 * ---------------------
 *  • DEFAULT OFF — absence, emptiness, or any unrecognised value
 *    disables the container path.
 *  • DETERMINISTIC — a pure function of the supplied environment.
 *  • ACCIDENT-PROOF — ONLY the exact token "true" (case-insensitive,
 *    trimmed) enables it. A truthy value, the number 1, "yes", "on",
 *    a non-empty object, or `undefined` all leave it OFF. There is no
 *    `Boolean(...)`/`!!` coercion anywhere on this path.
 *  • NOT AUTHORITY-CONTROLLED — the flag is read from build-time
 *    environment only. It is never derived from wallet state, payment
 *    state, runtime state, a query parameter, or any server response,
 *    so no authority chain can flip it.
 *  • EASY TO DISABLE — unset the variable, or set it to anything other
 *    than "true".
 *
 * Wiring note (Stage 3): this flag is intentionally NOT yet consumed by
 * the upload flow. See containerUploader.ts for the publication-schema
 * boundary that blocks integration.
 */

/**
 * Build-time environment key.
 *
 * Vite only exposes `VITE_`-prefixed variables to client code, so this
 * is the canonical switch for the browser bundle.
 */
export const CONTAINER_UPLOAD_ENV_KEY = "VITE_AETERNA_CONTAINER_UPLOAD";

/**
 * The ONLY value that enables the container path.
 */
export const CONTAINER_UPLOAD_ENABLED_TOKEN = "true";

/**
 * Structural view of the environment (never `any`).
 */
export interface ContainerUploadEnv {
  readonly [key: string]: unknown;
}

function defaultEnv(): ContainerUploadEnv {
  const env = (import.meta as { env?: unknown }).env;
  return env && typeof env === "object"
    ? (env as ContainerUploadEnv)
    : Object.freeze({});
}

/**
 * True only when the container write path is explicitly enabled.
 *
 * `env` is injectable so the behaviour is testable without touching
 * build configuration.
 */
export function isContainerUploadEnabled(
  env: ContainerUploadEnv = defaultEnv()
): boolean {
  if (!env || typeof env !== "object") return false;

  const raw = env[CONTAINER_UPLOAD_ENV_KEY];

  // No coercion: anything that is not a string leaves the flag OFF.
  if (typeof raw !== "string") return false;

  return raw.trim().toLowerCase() === CONTAINER_UPLOAD_ENABLED_TOKEN;
}
