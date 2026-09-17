/**
 * AETERNA — Prepared Projection invariant tests
 *
 * These tests exercise the REAL /api/capsule/prepared endpoint
 * (onRequestPost) against the canonical PREPARED contract.
 *
 * CHUNK SIZE MODEL — canonical independence
 * -----------------------------------------
 * The prepared boundary carries TWO independent size quantities:
 *
 *   encryptedSizeBytes    = encrypted VAULT blob length (encryptVault
 *                           output). The vault contains metadata JSON
 *                           only; it is bounded by MIN/MAX_ENCRYPTED_SIZE.
 *
 *   totalChunkSizeBytes   = Σ chunkMetadata[].size, i.e. the sum of
 *                           per-MEDIA-chunk ciphertext lengths
 *                           (encryptChunk output).
 *
 * constants.ts: "Vault contains metadata JSON only. Binary payload
 * stored separately as encrypted chunks." The canon lists
 * `chunkMetadata core fields (chunkId, mediaId, index, size)` and
 * `encryptedSizeBytes` as SEPARATE immutables and never defines an
 * equality between them.
 *
 * There is therefore NO equality invariant between these two values.
 * Any test asserting one would enshrine a contract the canon does not
 * define — and the endpoint previously enforced exactly such a
 * comparison (CHUNK_SIZE_MISMATCH), which rejected every canonically
 * prepared capsule that contained media.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createFakeKV, createFakeRequest, makeEventContext } from "./harness";
import { sha256 } from "../lib/sha256";

const ORIGIN = "https://aeternacapsule.com";

const IDENTITY_ID = "f".repeat(32);
const WALLET_ACCOUNT = "CreatorWalletAccount111111111111111111111111";
const CAPSULE_ID = "a".repeat(64);
const LIFECYCLE_ID = "lifecycle-1";

const LOCAL_VAULT_POINTER = `aeterna-local-vault:${CAPSULE_ID}`;

/* Mirrors the endpoint's own bounds (prepared.ts). */
const MIN_ENCRYPTED_SIZE = 1;
const MAX_ENCRYPTED_SIZE = 50 * 1024 * 1024;

function buildEnv() {
  return {
    CREATOR_IDENTITIES: createFakeKV(),
    PREPARED_PROJECTIONS: createFakeKV(),
    CREATOR_CREDITS: createFakeKV(),
  };
}

function seedIdentity(env: ReturnType<typeof buildEnv>) {
  env.CREATOR_IDENTITIES.put(
    `creator:identity:solana:${WALLET_ACCOUNT}`,
    JSON.stringify({
      id: IDENTITY_ID,
      network: "solana",
      account: WALLET_ACCOUNT,
      firstVerifiedAt: 1_800_000_000_000,
      lastVerifiedAt: 1_800_000_000_000,
    })
  );
  env.CREATOR_IDENTITIES.put(
    `creator:identity:id:${IDENTITY_ID}`,
    `solana:${WALLET_ACCOUNT}`
  );
}

function seedReservedLifecycle(env: ReturnType<typeof buildEnv>) {
  env.CREATOR_CREDITS.put(
    `creator:credit:lifecycle:${IDENTITY_ID}:${LIFECYCLE_ID}`,
    JSON.stringify({
      id: "credit-1",
      status: "CONSUMING",
      creatorIdentityId: IDENTITY_ID,
      capsuleId: CAPSULE_ID,
      lifecycleId: LIFECYCLE_ID,
    })
  );
}

function fakeContext(env: Record<string, unknown>, body: unknown) {
  const request = createFakeRequest({
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body,
  });
  return makeEventContext({ request, env: env as never });
}

interface ChunkFixture {
  chunkId: string;
  mediaId: string;
  index: number;
  size: number;
}

function buildChunk(index: number, size: number, mediaId = "m1"): ChunkFixture {
  return {
    chunkId: String(index).padStart(64, "0"),
    mediaId,
    index,
    size,
  };
}

/** Calls the real onRequestPost with an overridable body. */
async function submitPrepared(
  env: ReturnType<typeof buildEnv>,
  overrides: Record<string, unknown> = {}
) {
  const { onRequestPost } = await import("./../api/capsule/prepared");
  return onRequestPost(
    fakeContext(env, {
      creatorIdentityId: IDENTITY_ID,
      lifecycleId: LIFECYCLE_ID,
      capsuleId: CAPSULE_ID,
      encryptedSizeBytes: 714,
      vaultSha256: "a".repeat(64),
      saltBase: "b".repeat(32),
      encryptedVaultPointer: LOCAL_VAULT_POINTER,
      chunkMetadata: [buildChunk(0, 4096)],
      ...overrides,
    })
  );
}

/** Full happy path: identity + reserved lifecycle seeded, valid body. */
async function submitValid(
  env: ReturnType<typeof buildEnv>,
  overrides: Record<string, unknown> = {}
) {
  seedIdentity(env);
  seedReservedLifecycle(env);
  return submitPrepared(env, overrides);
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ================= CHUNK SIZE MODEL — NO EQUALITY ================= */

describe("Prepared Projection chunk size model (canonically independent sizes)", () => {
  it("ACCEPTS a prepared request where encryptedSizeBytes !== Σ(chunk.size)", async () => {
    const env = buildEnv();
    // encryptedSizeBytes = 714 (metadata-only vault) while the media
    // chunk sum is 4096. Different object classes — must be accepted.
    const res = await submitValid(env, {
      encryptedSizeBytes: 714,
      chunkMetadata: [buildChunk(0, 4096)],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("ACCEPTS an encryptedSizeBytes strictly greater than the chunk sum", async () => {
    const env = buildEnv();
    const res = await submitValid(env, {
      encryptedSizeBytes: 2048,
      chunkMetadata: [buildChunk(0, 16), buildChunk(1, 16)],
    });
    expect(res.status).toBe(200);
  });

  it("ACCEPTS an encryptedSizeBytes strictly less than the chunk sum", async () => {
    const env = buildEnv();
    const res = await submitValid(env, {
      encryptedSizeBytes: 32,
      chunkMetadata: [buildChunk(0, 8192), buildChunk(1, 8192)],
    });
    expect(res.status).toBe(200);
  });

  it("never fails with CHUNK_SIZE_MISMATCH", async () => {
    const env = buildEnv();
    // Deliberately maximally mismatched inputs.
    const res = await submitValid(env, {
      encryptedSizeBytes: 1,
      chunkMetadata: [
        buildChunk(0, 1024),
        buildChunk(1, 1024),
        buildChunk(2, 1024),
      ],
    });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain("CHUNK_SIZE_MISMATCH");
  });
});

/* ================= PROJECTION PERSISTENCE INVARIANTS ================= */

describe("Prepared Projection persistence invariants", () => {
  it("persists totalChunkSizeBytes === Σ(chunkMetadata[].size)", async () => {
    const env = buildEnv();
    const chunks = [buildChunk(0, 4096), buildChunk(1, 8192), buildChunk(2, 1024)];
    const expectedSum = chunks.reduce((sum, c) => sum + c.size, 0);

    const res = await submitValid(env, { chunkMetadata: chunks });
    expect(res.status).toBe(200);

    const stored = JSON.parse(
      (await env.PREPARED_PROJECTIONS.get(`prepared-projection:${CAPSULE_ID}`))!
    ) as { totalChunkSizeBytes: number };

    expect(stored.totalChunkSizeBytes).toBe(expectedSum);
  });

  it("persists chunkCount === chunkMetadata.length", async () => {
    const env = buildEnv();
    const chunks = [buildChunk(0, 16), buildChunk(1, 16), buildChunk(2, 16), buildChunk(3, 16)];

    const res = await submitValid(env, { chunkMetadata: chunks });
    expect(res.status).toBe(200);

    const stored = JSON.parse(
      (await env.PREPARED_PROJECTIONS.get(`prepared-projection:${CAPSULE_ID}`))!
    ) as { chunkCount: number; totalChunkSizeBytes: number };

    expect(stored.chunkCount).toBe(chunks.length);
    expect(stored.totalChunkSizeBytes).toBe(64);
  });

  it("keeps encryptedSizeBytes and totalChunkSizeBytes as distinct stored fields", async () => {
    const env = buildEnv();
    const res = await submitValid(env, {
      encryptedSizeBytes: 714,
      chunkMetadata: [buildChunk(0, 4096)],
    });
    expect(res.status).toBe(200);

    const stored = JSON.parse(
      (await env.PREPARED_PROJECTIONS.get(`prepared-projection:${CAPSULE_ID}`))!
    ) as { encryptedSizeBytes: number; totalChunkSizeBytes: number };

    // Both persisted independently; the vault value is never overwritten
    // by the media chunk sum (or vice versa).
    expect(stored.encryptedSizeBytes).toBe(714);
    expect(stored.totalChunkSizeBytes).toBe(4096);
    expect(stored.encryptedSizeBytes).not.toBe(stored.totalChunkSizeBytes);
  });

  it("binds the projection to creatorIdentityId + lifecycleId + capsuleId", async () => {
    const env = buildEnv();
    const res = await submitValid(env);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      preparedProjection: {
        creatorIdentityId: string;
        lifecycleId: string;
        capsuleId: string;
        state: string;
        walletAccount: string;
      };
    };

    expect(body.preparedProjection.creatorIdentityId).toBe(IDENTITY_ID);
    expect(body.preparedProjection.lifecycleId).toBe(LIFECYCLE_ID);
    expect(body.preparedProjection.capsuleId).toBe(CAPSULE_ID);
    expect(body.preparedProjection.state).toBe("ACTIVE");
    expect(body.preparedProjection.walletAccount).toBe(WALLET_ACCOUNT);
  });
});

/* ================= TEXT-ONLY CAPSULE (EMPTY CHUNK METADATA) ================= */

describe("Prepared Projection accepts canonical text-only capsules", () => {
  it("ACCEPTS a prepared request with chunkMetadata = [] (HTTP 200)", async () => {
    const env = buildEnv();
    const res = await submitValid(env, {
      encryptedSizeBytes: 550,
      chunkMetadata: [],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("persists chunkCount === 0", async () => {
    const env = buildEnv();
    const res = await submitValid(env, { encryptedSizeBytes: 550, chunkMetadata: [] });
    expect(res.status).toBe(200);

    const stored = JSON.parse(
      (await env.PREPARED_PROJECTIONS.get(`prepared-projection:${CAPSULE_ID}`))!
    ) as { chunkCount: number };

    expect(stored.chunkCount).toBe(0);
  });

  it("persists totalChunkSizeBytes === 0", async () => {
    const env = buildEnv();
    const res = await submitValid(env, { encryptedSizeBytes: 550, chunkMetadata: [] });
    expect(res.status).toBe(200);

    const stored = JSON.parse(
      (await env.PREPARED_PROJECTIONS.get(`prepared-projection:${CAPSULE_ID}`))!
    ) as { totalChunkSizeBytes: number };

    expect(stored.totalChunkSizeBytes).toBe(0);
  });

  it("keeps encryptedSizeBytes an independent field (not derived from chunks)", async () => {
    const env = buildEnv();
    const res = await submitValid(env, { encryptedSizeBytes: 550, chunkMetadata: [] });
    expect(res.status).toBe(200);

    const stored = JSON.parse(
      (await env.PREPARED_PROJECTIONS.get(`prepared-projection:${CAPSULE_ID}`))!
    ) as { encryptedSizeBytes: number; totalChunkSizeBytes: number };

    // The vault size survives intact with zero media chunks. No equality
    // between the two is asserted or enforced — they are independent.
    expect(stored.encryptedSizeBytes).toBe(550);
    expect(stored.totalChunkSizeBytes).toBe(0);
  });

  it("never returns CHUNK_METADATA_EMPTY", async () => {
    const env = buildEnv();
    const res = await submitValid(env, { encryptedSizeBytes: 550, chunkMetadata: [] });
    const raw = await res.text();
    expect(raw).not.toContain("CHUNK_METADATA_EMPTY");
    expect(res.status).toBe(200);
  });

  it("ACCEPTS a text-only capsule whose vault size differs from the chunk sum", async () => {
    const env = buildEnv();
    // Text-only: vault 550 bytes, zero media chunks (sum 0).
    const res = await submitValid(env, { encryptedSizeBytes: 550, chunkMetadata: [] });
    expect(res.status).toBe(200);

    const stored = JSON.parse(
      (await env.PREPARED_PROJECTIONS.get(`prepared-projection:${CAPSULE_ID}`))!
    ) as { encryptedSizeBytes: number; totalChunkSizeBytes: number };

    expect(stored.encryptedSizeBytes).not.toBe(stored.totalChunkSizeBytes);
  });
});

/* ================= CHUNK METADATA VALIDATION STILL ENFORCED ================= */

describe("Prepared Projection chunkMetadata validation is still enforced", () => {
  it("rejects a non-array chunkMetadata", async () => {
    const env = buildEnv();
    // A non-array fails the INVALID_FIELDS gate before validateChunkMetadata.
    const res = await submitValid(env, { chunkMetadata: "not-an-array" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_FIELDS");
  });

  it("still accepts a single-chunk payload", async () => {
    const env = buildEnv();
    const res = await submitValid(env, {
      encryptedSizeBytes: 714,
      chunkMetadata: [buildChunk(0, 4096)],
    });
    expect(res.status).toBe(200);

    const stored = JSON.parse(
      (await env.PREPARED_PROJECTIONS.get(`prepared-projection:${CAPSULE_ID}`))!
    ) as { chunkCount: number; totalChunkSizeBytes: number };

    expect(stored.chunkCount).toBe(1);
    expect(stored.totalChunkSizeBytes).toBe(4096);
  });

  it("rejects malformed chunkMetadata items", async () => {
    const env = buildEnv();
    const res = await submitValid(env, { chunkMetadata: [{ mediaId: "m1" }] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_CHUNK_METADATA_ITEM_0");
  });

  it("rejects an empty-object chunkMetadata item", async () => {
    const env = buildEnv();
    const res = await submitValid(env, { chunkMetadata: [{}] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_CHUNK_METADATA_ITEM_0");
  });

  it("rejects a negative chunk index", async () => {
    const env = buildEnv();
    const res = await submitValid(env, {
      chunkMetadata: [{ chunkId: "c".repeat(64), mediaId: "m1", index: -1, size: 16 }],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_CHUNK_INDEX_0");
  });

  it("rejects a non-integer chunk index", async () => {
    const env = buildEnv();
    const res = await submitValid(env, {
      chunkMetadata: [{ chunkId: "c".repeat(64), mediaId: "m1", index: 1.5, size: 16 }],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_CHUNK_INDEX_0");
  });
});

/* ================= CHUNK SIZE VALIDATION STILL ENFORCED ================= */

describe("Prepared Projection chunk size validation is still enforced", () => {
  it("rejects a zero chunk size", async () => {
    const env = buildEnv();
    const res = await submitValid(env, { chunkMetadata: [buildChunk(0, 0)] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_CHUNK_SIZE_0");
  });

  it("rejects a negative chunk size", async () => {
    const env = buildEnv();
    const res = await submitValid(env, { chunkMetadata: [buildChunk(0, -16)] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_CHUNK_SIZE_0");
  });

  it("rejects a non-integer chunk size", async () => {
    const env = buildEnv();
    const res = await submitValid(env, { chunkMetadata: [buildChunk(0, 16.5)] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_CHUNK_SIZE_0");
  });

  it("reports the offending chunk index", async () => {
    const env = buildEnv();
    const res = await submitValid(env, {
      chunkMetadata: [buildChunk(0, 16), buildChunk(1, -1)],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_CHUNK_SIZE_1");
  });
});

/* ================= ENCRYPTED SIZE BOUNDS STILL ENFORCED ================= */

describe("Prepared Projection encryptedSizeBytes bounds are still enforced", () => {
  it("rejects encryptedSizeBytes below MIN", async () => {
    const env = buildEnv();
    const res = await submitValid(env, { encryptedSizeBytes: MIN_ENCRYPTED_SIZE - 1 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_ENCRYPTED_SIZE");
  });

  it("rejects encryptedSizeBytes of zero", async () => {
    const env = buildEnv();
    const res = await submitValid(env, { encryptedSizeBytes: 0 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_ENCRYPTED_SIZE");
  });

  it("rejects encryptedSizeBytes above MAX", async () => {
    const env = buildEnv();
    const res = await submitValid(env, { encryptedSizeBytes: MAX_ENCRYPTED_SIZE + 1 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_ENCRYPTED_SIZE");
  });

  it("rejects a non-integer encryptedSizeBytes", async () => {
    const env = buildEnv();
    const res = await submitValid(env, { encryptedSizeBytes: 714.5 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_FIELDS");
  });

  it("accepts encryptedSizeBytes at the MIN boundary", async () => {
    const env = buildEnv();
    const res = await submitValid(env, { encryptedSizeBytes: MIN_ENCRYPTED_SIZE });
    expect(res.status).toBe(200);
  });

  it("accepts encryptedSizeBytes at the MAX boundary", async () => {
    const env = buildEnv();
    const res = await submitValid(env, { encryptedSizeBytes: MAX_ENCRYPTED_SIZE });
    expect(res.status).toBe(200);
  });
});

/* ================= ENDPOINT AUTHORIZATION ================= */

describe("Prepared Projection endpoint authorization", () => {
  it("requires an allowed Origin", async () => {
    const env = buildEnv();
    const { onRequestPost } = await import("./../api/capsule/prepared");
    const request = createFakeRequest({
      headers: { "content-type": "application/json" },
      body: {},
    });
    const res = await onRequestPost(
      makeEventContext({ request, env: env as never })
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("INVALID_ORIGIN");
  });

  it("rejects an unresolved creatorIdentityId", async () => {
    const env = buildEnv();
    // No identity seeded.
    const res = await submitPrepared(env);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("IDENTITY_NOT_FOUND");
  });

  it("ACCEPTS a prepared request whose lifecycle reservation does not exist yet", async () => {
    const env = buildEnv();
    seedIdentity(env);
    // Lifecycle deliberately NOT reserved: canonically, the reservation
    // happens AFTER final CREATE CAPSULE, while /prepared (the metadata
    // projection that feeds the storage quote) necessarily runs BEFORE it.
    // Requiring the reservation here was a false rejection.
    const res = await submitPrepared(env, {
      lifecycleId: LIFECYCLE_ID,
      encryptedSizeBytes: 714,
      chunkMetadata: [buildChunk(0, 4096)],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("persists lifecycleId verbatim even when no reservation exists", async () => {
    const env = buildEnv();
    seedIdentity(env);
    const res = await submitPrepared(env, {
      lifecycleId: LIFECYCLE_ID,
      encryptedSizeBytes: 714,
      chunkMetadata: [buildChunk(0, 4096)],
    });
    expect(res.status).toBe(200);

    const stored = JSON.parse(
      (await env.PREPARED_PROJECTIONS.get(`prepared-projection:${CAPSULE_ID}`))!
    ) as {
      lifecycleId: string;
      capsuleId: string;
      chunkCount: number;
      totalChunkSizeBytes: number;
      encryptedSizeBytes: number;
    };

    // lifecycleId survives: the Storage Quote endpoint binds it against
    // this projection (projection.lifecycleId === request.lifecycleId).
    expect(stored.lifecycleId).toBe(LIFECYCLE_ID);
    expect(stored.capsuleId).toBe(CAPSULE_ID);
    expect(stored.chunkCount).toBe(1);
    expect(stored.totalChunkSizeBytes).toBe(4096);
    // Vault size stays an independent field — no equality with the chunk sum.
    expect(stored.encryptedSizeBytes).toBe(714);
    expect(stored.encryptedSizeBytes).not.toBe(stored.totalChunkSizeBytes);
  });

  it("never returns LIFECYCLE_NOT_RESERVED for an unreserved lifecycle", async () => {
    const env = buildEnv();
    seedIdentity(env);
    const res = await submitPrepared(env, {
      lifecycleId: LIFECYCLE_ID,
      encryptedSizeBytes: 714,
      chunkMetadata: [buildChunk(0, 4096)],
    });

    const raw = await res.text();
    expect(raw).not.toContain("LIFECYCLE_NOT_RESERVED");
    expect(res.status).toBe(200);
  });

  it("produces the same result whether or not the lifecycle is reserved", async () => {
    const unreserved = buildEnv();
    seedIdentity(unreserved);
    const reserved = buildEnv();
    seedIdentity(reserved);
    seedReservedLifecycle(reserved);

    const body = {
      lifecycleId: LIFECYCLE_ID,
      encryptedSizeBytes: 714,
      chunkMetadata: [buildChunk(0, 4096)],
    };

    const a = await submitPrepared(unreserved, body);
    const b = await submitPrepared(reserved, body);

    // Reservation state is irrelevant at this boundary.
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });

  it("still rejects an empty lifecycleId with INVALID_FIELDS", async () => {
    const env = buildEnv();
    seedIdentity(env);
    const res = await submitPrepared(env, {
      lifecycleId: "",
      chunkMetadata: [buildChunk(0, 4096)],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_FIELDS");
  });
});

/* ================= SHARED HASH CONSISTENCY ================= */

describe("Prepared Projection vault hash contract", () => {
  it("persists vaultSha256 verbatim", async () => {
    const env = buildEnv();
    const expected = await sha256(new Uint8Array([7, 7, 7]));
    const res = await submitValid(env, { vaultSha256: expected });
    expect(res.status).toBe(200);

    const stored = JSON.parse(
      (await env.PREPARED_PROJECTIONS.get(`prepared-projection:${CAPSULE_ID}`))!
    ) as { vaultSha256: string };
    expect(stored.vaultSha256).toBe(expected);
  });
});
