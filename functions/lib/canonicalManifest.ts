/**
 * AETERNA — Canonical manifest serialization
 *
 * THE single authoritative implementation of canonical JSON
 * serialization for Capsule manifests, shared by every Cloudflare
 * Function that must derive a manifest's identity/hash:
 *
 *   - functions/api/capsule/seal.ts    (persists the canonical form)
 *   - functions/api/seal/verify.ts     (hashes stored + submitted forms)
 *
 * Protocol invariant (INVARIANT — do not fork):
 *
 *   Two semantically identical manifests MUST serialize to the same
 *   bytes regardless of object key insertion order. Consequently the
 *   persisted manifest in CAPSULE_MANIFESTS and the client-submitted
 *   manifest at /api/seal/verify hash identically.
 *
 * A prior production failure (409 MANIFEST_MISMATCH) was caused by this
 * module not existing: capsule/seal.ts persisted a key-sorted form while
 * seal/verify.ts hashed both sides with plain JSON.stringify. Object key
 * order then leaked into the hash. This module removes that class of bug
 * by construction — there is exactly ONE serializer.
 *
 * Recursive semantics (must remain exactly these):
 *   - arrays preserve element ORDER (order is significant);
 *   - plain objects have their own enumerable string keys SORTED
 *     ascending (lexicographic, via Array.prototype.sort default);
 *   - non-plain objects (prototype !== Object.prototype and !== null)
 *     and primitives are returned verbatim;
 *   - no getters are invoked by sorting (only own keys of a plain object
 *     are read, and only through normal property access of already
 *     materialized JSON-parsed values).
 */

function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  if (!value || typeof value !== "object")
    return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively produce a canonical copy of `value`:
 * object keys sorted ascending, array order preserved.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isPlainObject(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize(value[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Canonical JSON string for `value` — the sole definition of manifest
 * identity in the protocol. Both seal and seal/verify MUST route every
 * manifest through this function.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
