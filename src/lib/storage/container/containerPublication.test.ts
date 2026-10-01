/**
 * Stage 4 — container publication record tests.
 */
import { describe, it, expect } from "vitest";

import {
  CONTAINER_PUBLICATION_KIND,
  CONTAINER_PUBLICATION_VERSION,
  buildContainerPublicationRecord,
  canonicalContainerLayoutDescriptor,
  computeContainerLayoutDigest,
  containerPublicationKey,
  assertContainerPublicationRecord,
  getContainerPublication,
  putContainerPublication,
} from "./containerPublication";

const CAPSULE = "a".repeat(64);
const LIFECYCLE = "lifecycle-1";
const IDENTITY = "f".repeat(32);
const TX = "K".repeat(43);
const C1 = "1".repeat(64);
const C2 = "2".repeat(64);
const C3 = "3".repeat(64);

function entries() {
  return [
    { chunkId: C1, size: 300 },
    { chunkId: C2, size: 111 },
    { chunkId: C3, size: 4096 },
  ];
}

function fakeKV() {
  const store = new Map<string, string>();
  return {
    store,
    PUBLICATION_VERIFICATIONS: {
      async get(key: string) {
        return store.has(key) ? (store.get(key) as string) : null;
      },
      async put(key: string, value: string) {
        store.set(key, value);
      },
    },
  };
}

describe("container publication — key + descriptor", () => {
  it("uses one key per capsule", () => {
    expect(containerPublicationKey(CAPSULE)).toBe(`container-publication:${CAPSULE}`);
  });

  it("builds a deterministic, order-sensitive descriptor", () => {
    const a = canonicalContainerLayoutDescriptor(entries());
    const b = canonicalContainerLayoutDescriptor(entries());

    expect(a).toBe(b);
    expect(a).toContain("AETC-LAYOUT v1");
    expect(a).toContain("chunks:3");
    expect(a).toContain(`0:${C1}:300`);
    expect(a).toContain(`2:${C3}:4096`);
  });

  it("changes when the ORDER changes", () => {
    const reordered = [
      { chunkId: C2, size: 111 },
      { chunkId: C1, size: 300 },
      { chunkId: C3, size: 4096 },
    ];
    expect(canonicalContainerLayoutDescriptor(entries())).not.toBe(
      canonicalContainerLayoutDescriptor(reordered)
    );
  });

  it("changes when a SIZE changes", () => {
    const altered = [
      { chunkId: C1, size: 301 },
      { chunkId: C2, size: 111 },
      { chunkId: C3, size: 4096 },
    ];
    expect(canonicalContainerLayoutDescriptor(entries())).not.toBe(
      canonicalContainerLayoutDescriptor(altered)
    );
  });

  it("rejects invalid entries", () => {
    expect(() => canonicalContainerLayoutDescriptor(null as never)).toThrow(
      "[AETERNA] Invalid container layout entries"
    );
    expect(() =>
      canonicalContainerLayoutDescriptor([{ chunkId: "", size: 1 }])
    ).toThrow("[AETERNA] Invalid container layout entry");
    expect(() =>
      canonicalContainerLayoutDescriptor([{ chunkId: C1, size: 0 }])
    ).toThrow("[AETERNA] Invalid container layout entry");
  });

  it("computes a stable sha256 digest", async () => {
    const d1 = await computeContainerLayoutDigest(entries());
    const d2 = await computeContainerLayoutDigest(entries());

    expect(d1).toBe(d2);
    expect(d1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("digest differs for a different chunk set", async () => {
    const d1 = await computeContainerLayoutDigest(entries());
    const d2 = await computeContainerLayoutDigest(entries().slice(0, 2));
    expect(d1).not.toBe(d2);
  });
});

describe("container publication — record validation", () => {
  async function validRecord() {
    return buildContainerPublicationRecord({
      capsuleId: CAPSULE,
      lifecycleId: LIFECYCLE,
      creatorIdentityId: IDENTITY,
      containerTxId: TX,
      chunkIds: [C1, C2, C3],
      layoutDigest: await computeContainerLayoutDigest(entries()),
      now: 1_800_000_000_000,
    });
  }

  it("builds a valid PENDING record", async () => {
    const r = await validRecord();

    expect(r.kind).toBe(CONTAINER_PUBLICATION_KIND);
    expect(r.version).toBe(CONTAINER_PUBLICATION_VERSION);
    expect(r.state).toBe("PENDING");
    expect(r.chunkIds).toEqual([C1, C2, C3]);
  });

  it("stores NO per-chunk pointer map", async () => {
    const r = await validRecord();
    expect(Object.keys(r)).not.toContain("chunkPointers");
    expect(JSON.stringify(r)).not.toContain("chunk-pointer-entry");
  });

  it("round-trips through the KV accessors", async () => {
    const env = fakeKV();
    const r = await validRecord();

    await putContainerPublication(env, r);
    const loaded = await getContainerPublication(env, CAPSULE);

    expect(loaded).toEqual(r);
  });

  it("returns null when no record exists (legacy capsule)", async () => {
    expect(await getContainerPublication(fakeKV(), CAPSULE)).toBeNull();
  });

  it("fails closed on a malformed stored record", async () => {
    const env = fakeKV();
    env.store.set(containerPublicationKey(CAPSULE), "{not json");
    await expect(getContainerPublication(env, CAPSULE)).rejects.toThrow(
      "[AETERNA] Container publication record is unreadable"
    );
  });

  it("fails closed on capsule scope mismatch", async () => {
    const r = await validRecord();
    expect(() =>
      assertContainerPublicationRecord(r, "b".repeat(64))
    ).toThrow("[AETERNA] Container publication capsule mismatch");
  });

  it("fails closed on a bad kind / version / digest / chunk list", async () => {
    const base = (await validRecord()) as unknown as Record<string, unknown>;

    expect(() =>
      assertContainerPublicationRecord({ ...base, kind: "chunk" }, CAPSULE)
    ).toThrow("[AETERNA] Invalid container publication kind");

    expect(() =>
      assertContainerPublicationRecord({ ...base, version: 99 }, CAPSULE)
    ).toThrow("[AETERNA] Unsupported container publication version");

    expect(() =>
      assertContainerPublicationRecord({ ...base, layoutDigest: "nope" }, CAPSULE)
    ).toThrow("[AETERNA] Invalid container layout digest");

    expect(() =>
      assertContainerPublicationRecord({ ...base, chunkIds: [] }, CAPSULE)
    ).toThrow("[AETERNA] Invalid container chunk identity list");

    expect(() =>
      assertContainerPublicationRecord({ ...base, chunkIds: [C1, C1] }, CAPSULE)
    ).toThrow("[AETERNA] Duplicate container chunk identity");

    expect(() =>
      assertContainerPublicationRecord({ ...base, state: "WAT" }, CAPSULE)
    ).toThrow("[AETERNA] Invalid container publication state");
  });
});
