import { describe, expect, it } from "vitest";
import {
  canonicalStringify,
  canonicalize,
} from "./../lib/canonicalManifest";
import { sha256 } from "./../lib/sha256";

/**
 * Canonical manifest serialization invariants.
 *
 * These tests pin the ONE authoritative manifest serializer shared by
 * /api/capsule/seal and /api/seal/verify. A regression here reopens the
 * 409 MANIFEST_MISMATCH production failure class (object key order
 * leaking into manifest identity).
 */

async function manifestHash(manifest: unknown): Promise<string> {
  const digest = await sha256(
    new TextEncoder().encode(canonicalStringify(manifest))
  );
  return `manifest:${digest}`;
}

const BASE_MANIFEST = {
  version: 1,
  capsuleId: "c".repeat(64),
  saltBase: "s".repeat(32),
  vaultTxId: "v".repeat(43),
  openAt: 1791374400000,
  sealedAt: 1791207079008,
  encryptedSizeBytes: 550,
  heartbeatInterval: 167320992,
  ext: { vaultSha256: "a".repeat(64) },
};

describe("canonical manifest serialization", () => {
  it("1. same manifest with different object key order -> identical hash", async () => {
    const a = {
      version: 1,
      capsuleId: "c",
      saltBase: "s",
      vaultTxId: "v",
      openAt: 2,
      sealedAt: 1,
      encryptedSizeBytes: 10,
      heartbeatInterval: 5,
      ext: { vaultSha256: "h" },
    };
    const b = {
      heartbeatInterval: 5,
      encryptedSizeBytes: 10,
      sealedAt: 1,
      openAt: 2,
      vaultTxId: "v",
      saltBase: "s",
      capsuleId: "c",
      version: 1,
      ext: { vaultSha256: "h" },
    };

    expect(await manifestHash(a)).toBe(await manifestHash(b));
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  it("2. nested ext object with different key order -> identical hash", async () => {
    const a = {
      version: 1,
      capsuleId: "c",
      ext: { vaultSha256: "h", chunkPointers: { "0": "p".repeat(43) } },
    };
    const b = {
      capsuleId: "c",
      version: 1,
      ext: { chunkPointers: { "0": "p".repeat(43) }, vaultSha256: "h" },
    };

    expect(await manifestHash(a)).toBe(await manifestHash(b));
  });

  it("3. different manifest value -> different hash", async () => {
    const a = { ...BASE_MANIFEST };
    const b = { ...BASE_MANIFEST, encryptedSizeBytes: 551 };

    expect(await manifestHash(a)).not.toBe(await manifestHash(b));
  });

  it("3b. same keys, different value -> different hash", async () => {
    const a = { capsuleId: "capsule-1", vaultTxId: "vault-1" };
    const b = { capsuleId: "capsule-1", vaultTxId: "vault-2" };

    expect(await manifestHash(a)).not.toBe(await manifestHash(b));
  });

  it("4. array ordering remains significant", async () => {
    const a = { capsuleId: "c", tags: ["x", "y", "z"] };
    const b = { capsuleId: "c", tags: ["z", "y", "x"] };

    expect(await manifestHash(a)).not.toBe(await manifestHash(b));
  });

  it("4b. identical array order -> identical hash", async () => {
    const a = { capsuleId: "c", tags: ["x", "y", "z"] };
    const b = { tags: ["x", "y", "z"], capsuleId: "c" };

    expect(await manifestHash(a)).toBe(await manifestHash(b));
  });

  it("preserves recursive semantics: nested objects sorted, arrays not", () => {
    const value = {
      b: 2,
      a: { d: 4, c: [3, 1, 2] },
    };

    const canonical = canonicalize(value) as Record<string, unknown>;
    expect(Object.keys(canonical)).toEqual(["a", "b"]);
    const nested = canonical.a as Record<string, unknown>;
    expect(Object.keys(nested)).toEqual(["c", "d"]);
    expect(nested.c).toEqual([3, 1, 2]);
  });

  it("non-plain objects and primitives pass through unchanged", () => {
    class Custom {
      constructor(public value: number) {}
    }
    const custom = new Custom(7);
    expect(canonicalize(custom)).toBe(custom);
    expect(canonicalize(null)).toBe(null);
    expect(canonicalize(42)).toBe(42);
    expect(canonicalize("str")).toBe("str");
    expect(canonicalize(undefined)).toBe(undefined);
  });

  it("canonicalStringify output is stable across repeated calls", () => {
    expect(canonicalStringify(BASE_MANIFEST)).toBe(
      canonicalStringify({ ...BASE_MANIFEST })
    );
  });
});
