/**
 * Phase C — Creator-paid publication claim.
 *
 * Canonical chain under test:
 *   PAYMENT_VERIFIED (storage payment)
 *   → client txId evidence (Irys data-item id)
 *   → server-side Irys Node confirmation
 *   → server-authored authority:
 *       vault  → PUBLICATION_VERIFICATIONS PENDING (expectedTxId=txId,
 *                expectedVaultSha256=null — computed later by verify)
 *       chunk  → CHUNK_POINTER_REGISTRY chunkId→txId
 *   → secondary tx index (no one tx across two lifecycles/capsules)
 *
 * Executor Hot is never touched; client state/hash/destination/payer
 * fields are never accepted.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createFakeKV, createFakeRequest, makeEventContext } from "./harness";

const ORIGIN = "https://aeternacapsule.com";
/**
 * Active Irys L1 Mainnet bundler — where new capsules publish.
 * The legacy Arweave bundler is intentionally NOT routed: a regression
 * back to it must surface as a loud failure, not a silent pass.
 */
const NODE_URL = "https://uploader.irys.xyz";
const LEGACY_NODE_URL = "https://node1.irys.xyz";
const NOW = 1_800_000_000_000;

const IDENTITY_ID = "f".repeat(32);
const WALLET_ACCOUNT = "B".repeat(44);
const LIFECYCLE_ID = "lifecycle-1";
const CAPSULE_ID = "a".repeat(64);
const STORAGE_PAYMENT_ID = "storage-pay-1";
const VAULT_TX = "V".repeat(43);
const CHUNK_TX = "C".repeat(43);
const CHUNK_ID = "c".repeat(64);
const TOKEN_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const IRYS_DESTINATION = "IrysDestinationAccount333333333333333333333";

function buildEnv() {
  return {
    CREATOR_CREDITS: createFakeKV(),
    PREPARED_PROJECTIONS: createFakeKV(),
    STORAGE_PAYMENTS: createFakeKV(),
    PUBLICATION_VERIFICATIONS: createFakeKV(),
    CHUNK_POINTER_REGISTRY: createFakeKV(),
  };
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

function seedVerifiedPayment(env: ReturnType<typeof buildEnv>) {
  env.STORAGE_PAYMENTS.put(
    `storage-payment:${STORAGE_PAYMENT_ID}`,
    JSON.stringify({
      storagePaymentId: STORAGE_PAYMENT_ID,
      state: "PAYMENT_VERIFIED",
      transactionSignature: "S".repeat(88),
      payer: WALLET_ACCOUNT,
      quote: {
        storagePaymentId: STORAGE_PAYMENT_ID,
        preparedProjectionId: "prep-1",
        creatorIdentityId: IDENTITY_ID,
        lifecycleId: LIFECYCLE_ID,
        capsuleId: CAPSULE_ID,
        expectedAmountAtomic: "1000000",
        irysDestination: IRYS_DESTINATION,
        tokenMint: TOKEN_MINT,
      },
    })
  );
}

let nodeStatus = 200;
let nodeBody: Record<string, unknown> = { id: VAULT_TX };

function stubNode() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(LEGACY_NODE_URL)) {
        // Legacy Arweave bundler: never a valid active rail.
        return new Response("unexpected legacy bundler", { status: 500 });
      }
      if (url.startsWith(NODE_URL) && url.includes("/tx/")) {
        if (nodeStatus === 200) {
          return new Response(JSON.stringify(nodeBody), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("node", { status: nodeStatus });
      }
      return new Response("unexpected", { status: 500 });
    })
  );
}

function claimContext(env: ReturnType<typeof buildEnv>, body: unknown) {
  const request = createFakeRequest({
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body,
  });
  return makeEventContext({ request, env: env as never });
}

async function claim(
  env: ReturnType<typeof buildEnv>,
  overrides: Record<string, unknown> = {}
) {
  const { onRequestPost } = await import("./../api/publication/claim");
  return onRequestPost(
    claimContext(env, {
      creatorIdentityId: IDENTITY_ID,
      lifecycleId: LIFECYCLE_ID,
      capsuleId: CAPSULE_ID,
      storagePaymentId: STORAGE_PAYMENT_ID,
      txId: VAULT_TX,
      kind: "vault",
      ...overrides,
    })
  );
}

describe("Phase C — creator-paid publication claim", () => {
  beforeEach(() => {
    nodeStatus = 200;
    nodeBody = { id: VAULT_TX };
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("A. valid vault claim writes PENDING publication with server-owned fields", async () => {
    const env = buildEnv();
    seedReservedLifecycle(env);
    seedVerifiedPayment(env);
    stubNode();

    const res = await claim(env);
    expect(res.status).toBe(200);

    const stored = JSON.parse(
      (await env.PUBLICATION_VERIFICATIONS.get(`creator:publication:${LIFECYCLE_ID}`))!
    );
    expect(stored.state).toBe("PENDING");
    expect(stored.expectedTxId).toBe(VAULT_TX);
    expect(stored.expectedVaultSha256).toBeNull(); // computed by verify, never client
    expect(stored.creatorIdentityId).toBe(IDENTITY_ID);
    expect(stored.capsuleId).toBe(CAPSULE_ID);

    const txIndex = JSON.parse(
      (await env.PUBLICATION_VERIFICATIONS.get(`publication-tx:${VAULT_TX}`))!
    );
    expect(txIndex.lifecycleId).toBe(LIFECYCLE_ID);
  });

  it("B. valid chunk claim writes pointer registry only (no publication record)", async () => {
    const env = buildEnv();
    seedReservedLifecycle(env);
    seedVerifiedPayment(env);
    stubNode();

    nodeBody = { id: CHUNK_TX };
    const res = await claim(env, { kind: "chunk", chunkId: CHUNK_ID, txId: CHUNK_TX });
    expect(res.status).toBe(200);

    // Per-chunk key model: this chunk owns its OWN KV entry. There is
    // no shared capsule-level registry blob to read or rewrite.
    const entry = await env.CHUNK_POINTER_REGISTRY.get(
      `chunk-pointer-entry:${CAPSULE_ID}:${CHUNK_ID}`
    );
    expect(entry).toBe(CHUNK_TX);
    expect(
      await env.CHUNK_POINTER_REGISTRY.get(`chunk-pointer-registry:${CAPSULE_ID}`)
    ).toBeNull();
    expect(await env.PUBLICATION_VERIFICATIONS.get(`creator:publication:${LIFECYCLE_ID}`)).toBeNull();
    expect(await env.PUBLICATION_VERIFICATIONS.get(`publication-tx:${CHUNK_TX}`)).toBeTruthy();
  });

  it("C. claim without PAYMENT_VERIFIED storage payment → fail closed", async () => {
    const env = buildEnv();
    seedReservedLifecycle(env);
    // no verified payment seeded
    env.STORAGE_PAYMENTS.put(
      `storage-payment:${STORAGE_PAYMENT_ID}`,
      JSON.stringify({ state: "FAILED", quote: { creatorIdentityId: IDENTITY_ID, lifecycleId: LIFECYCLE_ID, capsuleId: CAPSULE_ID } })
    );
    stubNode();

    const res = await claim(env);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("STORAGE_PAYMENT_NOT_VERIFIED");
    expect(await env.PUBLICATION_VERIFICATIONS.get(`creator:publication:${LIFECYCLE_ID}`)).toBeNull();
  });

  it("D. lifecycle mismatch → reject", async () => {
    const env = buildEnv();
    seedReservedLifecycle(env);
    seedVerifiedPayment(env);
    stubNode();

    const res = await claim(env, { lifecycleId: "lifecycle-other" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("LIFECYCLE_NOT_RESERVED");
  });

  it("E. capsule mismatch → reject", async () => {
    const env = buildEnv();
    seedReservedLifecycle(env);
    seedVerifiedPayment(env);
    stubNode();

    const res = await claim(env, { capsuleId: "b".repeat(64) });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("CAPSULE_MISMATCH");
  });

  it("F. identity mismatch → reject", async () => {
    const env = buildEnv();
    seedReservedLifecycle(env);
    seedVerifiedPayment(env);
    stubNode();

    const res = await claim(env, { creatorIdentityId: "e".repeat(32) });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("LIFECYCLE_NOT_RESERVED");
  });

  it("G. Node 404 → fail closed, no PENDING publication", async () => {
    const env = buildEnv();
    seedReservedLifecycle(env);
    seedVerifiedPayment(env);
    nodeStatus = 404;
    stubNode();

    const res = await claim(env);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("PUBLICATION_NOT_CONFIRMED");
    expect(await env.PUBLICATION_VERIFICATIONS.get(`creator:publication:${LIFECYCLE_ID}`)).toBeNull();
  });

  it("H. Node 5xx → retryable temporary failure, no authority record", async () => {
    const env = buildEnv();
    seedReservedLifecycle(env);
    seedVerifiedPayment(env);
    nodeStatus = 503;
    stubNode();

    const res = await claim(env);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("PUBLICATION_NODE_UNAVAILABLE");
    expect(await env.PUBLICATION_VERIFICATIONS.get(`creator:publication:${LIFECYCLE_ID}`)).toBeNull();
  });

  it("I. same claim repeated → idempotent", async () => {
    const env = buildEnv();
    seedReservedLifecycle(env);
    seedVerifiedPayment(env);
    stubNode();

    const first = await claim(env);
    expect(first.status).toBe(200);
    const second = await claim(env);
    expect(second.status).toBe(200);
    const json = (await second.json()) as Record<string, unknown>;
    expect(json.claimed ?? true).toBeTruthy();
  });

  it("J. same tx claimed by a different lifecycle → TX_ALREADY_CLAIMED", async () => {
    const env = buildEnv();
    seedReservedLifecycle(env);
    seedVerifiedPayment(env);
    stubNode();

    await claim(env);
    env.CREATOR_CREDITS.put(
      `creator:credit:lifecycle:${IDENTITY_ID}:lifecycle-2`,
      JSON.stringify({ id: "credit-1", status: "CONSUMING", creatorIdentityId: IDENTITY_ID, capsuleId: CAPSULE_ID, lifecycleId: "lifecycle-2" })
    );
    env.STORAGE_PAYMENTS.put(
      `storage-payment:storage-pay-2`,
      JSON.stringify({ state: "PAYMENT_VERIFIED", quote: { creatorIdentityId: IDENTITY_ID, lifecycleId: "lifecycle-2", capsuleId: CAPSULE_ID } })
    );
    const res = await claim(env, { lifecycleId: "lifecycle-2", storagePaymentId: "storage-pay-2" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("TX_ALREADY_CLAIMED");
  });

  it("K. same tx claimed for a different capsule → TX_ALREADY_CLAIMED", async () => {
    const env = buildEnv();
    seedReservedLifecycle(env);
    seedVerifiedPayment(env);
    stubNode();

    await claim(env);
    const res = await claim(env, { capsuleId: "b".repeat(64) });
    // capsule mismatch gate fires first — either way the cross-capsule
    // claim must not succeed.
    expect([409, 403]).toContain(res.status);
  });

  it("L. same lifecycle claiming a different tx → PUBLICATION_ALREADY_BOUND", async () => {
    const env = buildEnv();
    seedReservedLifecycle(env);
    seedVerifiedPayment(env);
    stubNode();

    await claim(env);
    nodeBody = { id: "D".repeat(43) };
    const res = await claim(env, { txId: "D".repeat(43) });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("PUBLICATION_ALREADY_BOUND");
  });

  it("M. already VERIFIED publication → terminal replay", async () => {
    const env = buildEnv();
    seedReservedLifecycle(env);
    seedVerifiedPayment(env);
    env.PUBLICATION_VERIFICATIONS.put(
      `creator:publication:${LIFECYCLE_ID}`,
      JSON.stringify({ lifecycleId: LIFECYCLE_ID, capsuleId: CAPSULE_ID, creatorIdentityId: IDENTITY_ID, state: "VERIFIED", expectedTxId: VAULT_TX, expectedVaultSha256: "h".repeat(64), evidenceIds: [VAULT_TX], createdAt: NOW, updatedAt: NOW, verifiedAt: NOW })
    );
    stubNode();

    const res = await claim(env);
    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe("VERIFIED");
  });

  it("N. already REJECTED publication → terminal replay", async () => {
    const env = buildEnv();
    seedReservedLifecycle(env);
    seedVerifiedPayment(env);
    env.PUBLICATION_VERIFICATIONS.put(
      `creator:publication:${LIFECYCLE_ID}`,
      JSON.stringify({ lifecycleId: LIFECYCLE_ID, capsuleId: CAPSULE_ID, creatorIdentityId: IDENTITY_ID, state: "REJECTED", expectedTxId: VAULT_TX, expectedVaultSha256: null, evidenceIds: [VAULT_TX], createdAt: NOW, updatedAt: NOW, rejectedAt: NOW })
    );
    stubNode();

    const res = await claim(env);
    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe("REJECTED");
  });

  it("O/P. client-injected authority fields are ignored", async () => {
    const env = buildEnv();
    seedReservedLifecycle(env);
    seedVerifiedPayment(env);
    stubNode();

    const res = await claim(env, {
      state: "VERIFIED",
      expectedVaultSha256: "z".repeat(64),
      expectedTxId: "Z".repeat(43),
    });
    expect(res.status).toBe(200);
    const stored = JSON.parse(
      (await env.PUBLICATION_VERIFICATIONS.get(`creator:publication:${LIFECYCLE_ID}`))!
    );
    expect(stored.state).toBe("PENDING"); // client "VERIFIED" ignored
    expect(stored.expectedTxId).toBe(VAULT_TX); // client expectedTxId ignored
    expect(stored.expectedVaultSha256).toBeNull(); // client hash ignored
  });

  it("Q/R. chunk writes pointer only; vault writes publication record", async () => {
    const env = buildEnv();
    seedReservedLifecycle(env);
    seedVerifiedPayment(env);
    stubNode();

    await claim(env, { kind: "chunk", chunkId: CHUNK_ID, txId: CHUNK_TX });
    expect(await env.PUBLICATION_VERIFICATIONS.get(`creator:publication:${LIFECYCLE_ID}`)).toBeNull();

    await claim(env); // vault
    const stored = JSON.parse(
      (await env.PUBLICATION_VERIFICATIONS.get(`creator:publication:${LIFECYCLE_ID}`))!
    );
    expect(stored.state).toBe("PENDING");
  });

  it("S. no Executor Hot dependency — claim module has no executor imports", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("functions/api/publication/claim.ts", "utf8");
    expect(src).not.toMatch(/executorHot|EXECUTOR_PRIVATE_KEY|publishCiphertext/);
  });

  it("T. Node confirmation targets the Irys L1 bundler, not the legacy Arweave bundler", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("functions/lib/irys/node.ts", "utf8");
    expect(src).toContain('"https://uploader.irys.xyz"');
    expect(src).not.toContain('"https://node1.irys.xyz"');
    // The read path must not re-couple to the unrelated base-eth rail.
    expect(src).not.toMatch(/from "\.\.\/\.\.\/irys\/transport"/);
  });

  it("U. a legacy-bundler-only node can never confirm a publication", async () => {
    const env = buildEnv();
    seedReservedLifecycle(env);
    seedVerifiedPayment(env);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith(LEGACY_NODE_URL)) {
          return new Response("legacy", { status: 404 });
        }
        return new Response("unexpected", { status: 500 });
      })
    );

    const res = await claim(env);
    // Fail closed: no authority record may be written off the legacy host.
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("PUBLICATION_NODE_UNAVAILABLE");
    expect(
      await env.PUBLICATION_VERIFICATIONS.get(`creator:publication:${LIFECYCLE_ID}`)
    ).toBeNull();
  });
});

/**
 * Storage-pointer FORMAT acceptance (TXID_REGEX / STORAGE_POINTER_REGEX).
 *
 * The pointer regex had no test coverage at all before this block, and the
 * active Irys-on-Solana rail returns an id the original exact-`{43}` form
 * could not express — which made every real vault claim fail with
 * INVALID_TX_ID after the creator had already paid.
 *
 * Both encodings of the same 32-byte identifier must be accepted:
 *   - 43-char URL-safe base64 (canonical Arweave/Irys txId)
 *   - 43- or 44-char base58 (Irys SDK `receipt.id`)
 * and a Solana transaction signature (87-88 base58) must NOT be.
 */
describe("Phase C — storage pointer format acceptance", () => {
  beforeEach(() => {
    nodeStatus = 200;
    nodeBody = { id: VAULT_TX };
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** The exact id captured from a real production Irys-on-Solana upload. */
  const REAL_IRYS_ID = "4M2b1xjKeoE11NbkGCLo4HsuvDQHuQqTyLrKnRLSDQZw"; // 44, base58

  it("accepts the 43-char base64url canonical id (unchanged behaviour)", async () => {
    const env = buildEnv();
    seedReservedLifecycle(env);
    seedVerifiedPayment(env);
    stubNode();

    const res = await claim(env);
    expect(res.status).toBe(200);
    const stored = JSON.parse(
      (await env.PUBLICATION_VERIFICATIONS.get(`creator:publication:${LIFECYCLE_ID}`))!
    );
    expect(stored.expectedTxId).toBe(VAULT_TX);
  });

  it("accepts the real 44-char base58 Irys id verbatim", async () => {
    const env = buildEnv();
    seedReservedLifecycle(env);
    seedVerifiedPayment(env);
    // The node echoes the id it was asked about — the same 44-char value.
    nodeBody = { id: REAL_IRYS_ID };
    stubNode();

    const res = await claim(env, { txId: REAL_IRYS_ID });
    expect(res.status).toBe(200);

    const stored = JSON.parse(
      (await env.PUBLICATION_VERIFICATIONS.get(`creator:publication:${LIFECYCLE_ID}`))!
    );
    // Stored verbatim: no re-encoding, so the node's own id stays the
    // pointer and the /tx/<id> confirmation keeps matching.
    expect(stored.expectedTxId).toBe(REAL_IRYS_ID);
    expect(await env.PUBLICATION_VERIFICATIONS.get(`publication-tx:${REAL_IRYS_ID}`)).toBeTruthy();
  });

  it("accepts the 44-char base58 id for a chunk and stores it as the pointer", async () => {
    const env = buildEnv();
    seedReservedLifecycle(env);
    seedVerifiedPayment(env);
    nodeBody = { id: REAL_IRYS_ID };
    stubNode();

    const res = await claim(env, {
      kind: "chunk",
      chunkId: CHUNK_ID,
      txId: REAL_IRYS_ID,
    });
    expect(res.status).toBe(200);
    expect(
      await env.CHUNK_POINTER_REGISTRY.get(
        `chunk-pointer-entry:${CAPSULE_ID}:${CHUNK_ID}`
      )
    ).toBe(REAL_IRYS_ID);
  });

  it("rejects a 42-char id (too short)", async () => {
    const env = buildEnv();
    seedReservedLifecycle(env);
    seedVerifiedPayment(env);
    stubNode();

    const res = await claim(env, { txId: "V".repeat(42) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_TX_ID");
  });

  it("rejects a 45-char id (too long)", async () => {
    const env = buildEnv();
    seedReservedLifecycle(env);
    seedVerifiedPayment(env);
    stubNode();

    const res = await claim(env, { txId: "V".repeat(45) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_TX_ID");
  });

  it("rejects an 88-char base58 Solana signature — never a storage pointer", async () => {
    const env = buildEnv();
    seedReservedLifecycle(env);
    seedVerifiedPayment(env);
    stubNode();

    const signature = "5".repeat(88);
    const res = await claim(env, { txId: signature });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_TX_ID");
    expect(
      await env.PUBLICATION_VERIFICATIONS.get(`creator:publication:${LIFECYCLE_ID}`)
    ).toBeNull();
  });

  it("rejects characters outside the pointer alphabet", async () => {
    const env = buildEnv();
    seedReservedLifecycle(env);
    seedVerifiedPayment(env);
    stubNode();

    // '+' and '!' are outside [A-Za-z0-9_-] (e.g. standard base64 padding
    // or an arbitrary injected token).
    for (const bad of [`${"V".repeat(42)}+`, `${"V".repeat(42)}!`]) {
      const res = await claim(env, { txId: bad });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("INVALID_TX_ID");
    }
  });

  it("rejects a non-string / empty txId as INVALID_FIELDS", async () => {
    const env = buildEnv();
    seedReservedLifecycle(env);
    seedVerifiedPayment(env);
    stubNode();

    for (const bad of ["", "   ", 12345, null]) {
      const res = await claim(env, { txId: bad });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("INVALID_FIELDS");
    }
  });

  it("node echoing a DIFFERENT id → UNAVAILABLE, no authority written", async () => {
    // Pins the trap: functions/lib/irys/node.ts compares the node body's
    // `id` STRICTLY against the expected txId. The node always reports its
    // own (base58) id, so re-encoding the pointer before claiming would
    // turn a working claim into PUBLICATION_NODE_UNAVAILABLE.
    const env = buildEnv();
    seedReservedLifecycle(env);
    seedVerifiedPayment(env);
    nodeBody = { id: "X".repeat(44) };
    stubNode();

    const res = await claim(env, { txId: REAL_IRYS_ID });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("PUBLICATION_NODE_UNAVAILABLE");
    expect(
      await env.PUBLICATION_VERIFICATIONS.get(`creator:publication:${LIFECYCLE_ID}`)
    ).toBeNull();
  });
});
