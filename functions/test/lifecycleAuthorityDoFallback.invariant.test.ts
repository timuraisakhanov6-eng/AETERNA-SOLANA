/**
 * R9-A92.3 — authoritative lifecycle fallback for the four downstream
 * mandatory stages.
 *
 * THE DEFECT THIS PINS
 * --------------------
 * The publication claim resolves a stale-negative KV lifecycle projection
 * through the coordinator's `op:"read"`. The later stages
 * (publication verify, seal, seal verify, finalize) did not, so the
 * November 7 window could pass the claim and then fail at verification.
 *
 * WHAT IS PROVEN HERE — against the REAL endpoint handlers, the REAL
 * CreditOperationCoordinator class over in-memory storage, and a KV double
 * that keeps returning null for the lifecycle key:
 *
 *   • each stage completes on the authoritative record;
 *   • every stage keeps its OWN state rule (verify/seal-verify require
 *     CONSUMING; finalize also accepts the idempotent CONSUMED replay);
 *   • identity / capsule / lifecycle / payment bindings still reject;
 *   • a missing, unavailable or malformed coordinator still fails closed;
 *   • omitting the address preserves the legacy KV-only behaviour.
 *
 * No network, no Irys, no payment, no Production state.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createFakeKV,
  createFakeRequest,
  makeEventContext,
  createFakeCreditCoordinatorBinding,
} from "./harness";

import { onRequestPost as publicationVerifyPost } from "./../api/publication/verify";
import { onRequestPost as sealVerifyPost } from "./../api/seal/verify";
import { onRequestPost as finalizeCreditPost } from "./../api/creator/finalize-credit";
import { onRequestPost as sealPost } from "./../api/capsule/seal";

const ORIGIN = "https://aeternacapsule.com";
const IDENTITY = "creator-1";
const OTHER_IDENTITY = "creator-OTHER";
const LIFECYCLE = "lifecycle-1";
const OTHER_LIFECYCLE = "lifecycle-OTHER";
const CAPSULE = "a".repeat(64);
const OTHER_CAPSULE = "c".repeat(64);
const CREDIT_ID = "credit-1";
const PAYMENT_INTENT = "intent-1";
const EVIDENCE = "evidence-1";
const VAULT_TX = "a".repeat(43);
const TOKEN = "a".repeat(32);
const AUTHORITY_FRAGMENT = "a".repeat(64);

/**
 * KV double that never reveals the lifecycle projection, while every other
 * key behaves normally. This is the incident's read-cache window, made
 * permanent for the duration of a test.
 */
function createStaleLifecycleKV() {
  const inner = createFakeKV();
  return {
    async get(key: string) {
      if (key.startsWith("creator:credit:lifecycle:")) return null;
      return inner.get(key);
    },
    put(
      key: string,
      value: string,
      options?: { expirationTtl?: number }
    ) {
      return inner.put(key, value, options);
    },
    delete(key: string) {
      return inner.delete(key);
    },
    list(options: { prefix?: string }) {
      return inner.list(options);
    },
    data: inner.data,
  };
}

type StaleKV = ReturnType<typeof createStaleLifecycleKV>;

interface BuildOptions {
  withCoordinator?: boolean;
  coordinatorFetch?: (request: Request) => Promise<Response>;
}

function buildEnv(options: BuildOptions = {}) {
  const lifecycleKv = createStaleLifecycleKV();
  const env: Record<string, unknown> = {
    CREATOR_CREDITS: lifecycleKv,
    PUBLICATION_VERIFICATIONS: createFakeKV(),
    SEAL_VERIFICATIONS: createFakeKV(),
    CAPSULE_MANIFESTS: createFakeKV(),
    VERIFIED_PAYMENTS: createFakeKV(),
    UPLOAD_TOKENS: createFakeKV(),
    AUTHORITY_TOKENS: createFakeKV(),
    BUSINESS_QUOTES: createFakeKV(),
  };
  if (options.withCoordinator !== false) {
    env.CREDIT_OP_COORDINATOR =
      options.coordinatorFetch !== undefined
        ? {
            idFromName(name: string) {
              return { id: name };
            },
            get() {
              return {
                fetch: (request: Request) => options.coordinatorFetch!(request),
              };
            },
          }
        : createFakeCreditCoordinatorBinding({
            creatorCredits: lifecycleKv as never,
          });
  }
  return { env, kv: lifecycleKv };
}

/** Reserves through the REAL coordinator (CONSUMING + bound). */
async function reserveThroughCoordinator(
  env: Record<string, unknown>,
  overrides: {
    creatorIdentityId?: string;
    lifecycleId?: string;
    capsuleId?: string;
    creatorCreditId?: string;
    paymentIntentId?: string | null;
  } = {}
) {
  const binding = env.CREDIT_OP_COORDINATOR as ReturnType<
    typeof createFakeCreditCoordinatorBinding
  >;
  const creditId = overrides.creatorCreditId ?? CREDIT_ID;
  const response = await binding.get(binding.idFromName(creditId)).fetch(
    new Request("https://aeterna-credit-coordinator.invalid", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "reserve",
        creatorCreditId: creditId,
        creatorIdentityId: overrides.creatorIdentityId ?? IDENTITY,
        lifecycleId: overrides.lifecycleId ?? LIFECYCLE,
        capsuleId: overrides.capsuleId ?? CAPSULE,
        paymentIntentId: overrides.paymentIntentId ?? PAYMENT_INTENT,
      }),
    })
  );
  expect(response.status).toBe(200);
}

function post(handler: unknown, env: Record<string, unknown>, body: unknown) {
  const request = createFakeRequest({
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body,
  });
  return (handler as (context: unknown) => Promise<Response>)(
    makeEventContext({ request, env: env as never })
  );
}

async function json(res: Response) {
  return (await res.json().catch(() => null)) as Record<string, unknown> | null;
}

/* ───────────────────────── publication/verify ───────────────────────── */

describe("R9-A92.3 — publication verify resolves a KV-null lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function stubIrysAndGateway() {
    const ciphertext = new Uint8Array([1, 2, 3, 4]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("https://uploader.irys.xyz") && url.includes("/tx/")) {
          return new Response(JSON.stringify({ id: VAULT_TX }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(ciphertext, {
          status: 200,
          headers: { "content-length": String(ciphertext.byteLength) },
        });
      })
    );
  }

  async function seedPending(env: Record<string, unknown>) {
    await (env.PUBLICATION_VERIFICATIONS as ReturnType<typeof createFakeKV>).put(
      `creator:publication:${LIFECYCLE}`,
      JSON.stringify({
        lifecycleId: LIFECYCLE,
        capsuleId: CAPSULE,
        creatorIdentityId: IDENTITY,
        state: "PENDING",
        expectedTxId: VAULT_TX,
        expectedVaultSha256: null,
        evidenceIds: [VAULT_TX],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
  }

  const body = {
    creatorIdentityId: IDENTITY,
    lifecycleId: LIFECYCLE,
    capsuleId: CAPSULE,
    publicationId: VAULT_TX,
    creatorCreditId: CREDIT_ID,
  };

  it("KV null + authoritative CONSUMING record → 200 VERIFIED", async () => {
    const { env } = buildEnv();
    await reserveThroughCoordinator(env);
    await seedPending(env);
    stubIrysAndGateway();

    const res = await post(publicationVerifyPost, env, body);

    expect(res.status).toBe(200);
    expect((await json(res))?.state).toBe("VERIFIED");
  });

  it("KV present still takes the existing path (unchanged)", async () => {
    // A normal (non-stale) lifecycle projection: the fallback must NOT be
    // consulted, and the historical behaviour is preserved.
    const { env } = buildEnv();
    env.CREATOR_CREDITS = createFakeKV();
    await (env.CREATOR_CREDITS as ReturnType<typeof createFakeKV>).put(
      `creator:credit:lifecycle:${IDENTITY}:${LIFECYCLE}`,
      JSON.stringify({
        id: CREDIT_ID,
        status: "CONSUMING",
        creatorIdentityId: IDENTITY,
        capsuleId: CAPSULE,
      })
    );
    await seedPending(env);
    stubIrysAndGateway();

    const res = await post(publicationVerifyPost, env, body);
    expect(res.status).toBe(200);
  });

  it("identity mismatch → 409 IDENTITY_MISMATCH", async () => {
    const { env } = buildEnv();
    await reserveThroughCoordinator(env, { creatorIdentityId: OTHER_IDENTITY });
    await seedPending(env);
    stubIrysAndGateway();

    const res = await post(publicationVerifyPost, env, body);
    expect(res.status).toBe(409);
    expect((await json(res))?.error).toBe("IDENTITY_MISMATCH");
  });

  it("capsule mismatch → 409 CAPSULE_MISMATCH", async () => {
    const { env } = buildEnv();
    await reserveThroughCoordinator(env, { capsuleId: OTHER_CAPSULE });
    await seedPending(env);

    const res = await post(publicationVerifyPost, env, body);
    expect(res.status).toBe(409);
    expect((await json(res))?.error).toBe("CAPSULE_MISMATCH");
  });

  it("lifecycle mismatch → 409 LIFECYCLE_NOT_RESERVED", async () => {
    const { env } = buildEnv();
    await reserveThroughCoordinator(env, { lifecycleId: OTHER_LIFECYCLE });
    await seedPending(env);

    const res = await post(publicationVerifyPost, env, body);
    expect(res.status).toBe(409);
    expect((await json(res))?.error).toBe("LIFECYCLE_NOT_RESERVED");
  });

  it("a finalized credit has no lifecycle binding → 409 LIFECYCLE_NOT_RESERVED", async () => {
    const { env } = buildEnv();
    await reserveThroughCoordinator(env);
    await seedPending(env);
    // Drive the credit to CONSUMED through the authoritative finalize op.
    const binding = env.CREDIT_OP_COORDINATOR as ReturnType<
      typeof createFakeCreditCoordinatorBinding
    >;
    await binding.get(binding.idFromName(CREDIT_ID)).fetch(
      new Request("https://aeterna-credit-coordinator.invalid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          op: "finalize",
          creatorCreditId: CREDIT_ID,
          creatorIdentityId: IDENTITY,
          lifecycleId: LIFECYCLE,
          capsuleId: CAPSULE,
          publicationVerified: true,
          sealVerified: true,
        }),
      })
    );

    const res = await post(publicationVerifyPost, env, {
      ...body,
      creatorCreditId: CREDIT_ID,
    });
    // Finalization clears the lifecycle/capsule binding on the authoritative
    // record, so the fallback can no longer prove this reservation. It fails
    // closed rather than reviving a finalized attempt.
    expect(res.status).toBe(409);
    expect((await json(res))?.error).toBe("LIFECYCLE_NOT_RESERVED");
  });

  it("no address + KV null → legacy 409 LIFECYCLE_NOT_RESERVED", async () => {
    const { env } = buildEnv();
    await reserveThroughCoordinator(env);
    await seedPending(env);

    const { creatorCreditId: _omit, ...legacy } = body;
    const res = await post(publicationVerifyPost, env, legacy);
    expect(res.status).toBe(409);
    expect((await json(res))?.error).toBe("LIFECYCLE_NOT_RESERVED");
  });

  it("coordinator unavailable → 503", async () => {
    const { env } = buildEnv({ withCoordinator: false });
    await seedPending(env);

    const res = await post(publicationVerifyPost, env, body);
    expect(res.status).toBe(503);
    expect((await json(res))?.error).toBe("CREDIT_COORDINATOR_UNAVAILABLE");
  });

  it("malformed coordinator answer → fail closed", async () => {
    const { env } = buildEnv({
      coordinatorFetch: async () =>
        new Response("not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    await seedPending(env);

    const res = await post(publicationVerifyPost, env, body);
    expect(res.status).toBe(409);
    expect((await json(res))?.error).toBe("LIFECYCLE_NOT_RESERVED");
  });
});

/* ─────────────────────────── seal/verify ─────────────────────────── */

describe("R9-A92.3 — seal verify resolves a KV-null lifecycle", () => {
  const manifest = {
    version: 1,
    capsuleId: CAPSULE,
    saltBase: "b".repeat(32),
    vaultTxId: VAULT_TX,
    openAt: Date.now() + 1000,
    sealedAt: Date.now(),
    encryptedSizeBytes: 1024,
    heartbeatInterval: 86_400_000,
    ext: { vaultSha256: "c".repeat(64) },
  };

  const body = {
    creatorIdentityId: IDENTITY,
    lifecycleId: LIFECYCLE,
    capsuleId: CAPSULE,
    manifest,
    creatorCreditId: CREDIT_ID,
  };

  async function seedPublication(env: Record<string, unknown>) {
    await (env.PUBLICATION_VERIFICATIONS as ReturnType<typeof createFakeKV>).put(
      `creator:publication:${LIFECYCLE}`,
      JSON.stringify({
        lifecycleId: LIFECYCLE,
        capsuleId: CAPSULE,
        state: "VERIFIED",
      })
    );
  }

  async function seedManifest(env: Record<string, unknown>) {
    // The endpoint compares hashes; a byte-identical stored manifest passes.
    await (env.CAPSULE_MANIFESTS as ReturnType<typeof createFakeKV>).put(
      CAPSULE,
      JSON.stringify(manifest)
    );
  }

  it("KV null + authoritative CONSUMING record → 200 VERIFIED", async () => {
    const { env } = buildEnv();
    await reserveThroughCoordinator(env);
    await seedPublication(env);
    await seedManifest(env);

    const res = await post(sealVerifyPost, env, body);
    expect(res.status).toBe(200);
    expect((await json(res))?.state).toBe("VERIFIED");
  });

  it("identity mismatch → 409 IDENTITY_MISMATCH", async () => {
    const { env } = buildEnv();
    await reserveThroughCoordinator(env, { creatorIdentityId: OTHER_IDENTITY });
    await seedPublication(env);
    await seedManifest(env);

    const res = await post(sealVerifyPost, env, body);
    expect(res.status).toBe(409);
    expect((await json(res))?.error).toBe("IDENTITY_MISMATCH");
  });

  it("capsule mismatch → 409 CAPSULE_MISMATCH", async () => {
    const { env } = buildEnv();
    await reserveThroughCoordinator(env, { capsuleId: OTHER_CAPSULE });
    await seedPublication(env);
    await seedManifest(env);

    const res = await post(sealVerifyPost, env, body);
    expect(res.status).toBe(409);
    expect((await json(res))?.error).toBe("CAPSULE_MISMATCH");
  });

  it("no address + KV null → legacy 409 LIFECYCLE_NOT_RESERVED", async () => {
    const { env } = buildEnv();
    await reserveThroughCoordinator(env);
    await seedPublication(env);
    await seedManifest(env);

    const { creatorCreditId: _omit, ...legacy } = body;
    const res = await post(sealVerifyPost, env, legacy);
    expect(res.status).toBe(409);
    expect((await json(res))?.error).toBe("LIFECYCLE_NOT_RESERVED");
  });
});

/* ─────────────────────────── finalize-credit ─────────────────────────── */

describe("R9-A92.3 — finalize-credit resolves a KV-null lifecycle", () => {
  const body = {
    creatorIdentityId: IDENTITY,
    lifecycleId: LIFECYCLE,
    capsuleId: CAPSULE,
    creatorCreditId: CREDIT_ID,
  };

  async function seedVerified(env: Record<string, unknown>) {
    await (env.PUBLICATION_VERIFICATIONS as ReturnType<typeof createFakeKV>).put(
      `creator:publication:${LIFECYCLE}`,
      JSON.stringify({ state: "VERIFIED" })
    );
    await (env.SEAL_VERIFICATIONS as ReturnType<typeof createFakeKV>).put(
      `creator:seal:${LIFECYCLE}`,
      JSON.stringify({ state: "VERIFIED" })
    );
  }

  it("KV null + authoritative CONSUMING → 200 CONSUMED (real transition)", async () => {
    const { env } = buildEnv();
    await reserveThroughCoordinator(env);
    await seedVerified(env);

    const res = await post(finalizeCreditPost, env, body);
    expect(res.status).toBe(200);
    const payload = await json(res);
    expect(payload?.ok).toBe(true);
    expect(payload?.status).toBe("CONSUMED");
  });

  it("a CONSUMED record that still carries its lifecycle binding is accepted (idempotent crash window)", async () => {
    const { env } = buildEnv();
    const binding = env.CREDIT_OP_COORDINATOR as ReturnType<
      typeof createFakeCreditCoordinatorBinding
    >;
    // Shape left by a crash between the consumed-record write and the
    // lifecycle-index delete: CONSUMED, binding still intact.
    binding.get(binding.idFromName(CREDIT_ID));
    binding.storages.get(CREDIT_ID)!.data.set(`credit:${CREDIT_ID}`, {
      id: CREDIT_ID,
      creatorIdentityId: IDENTITY,
      status: "CONSUMED",
      capsuleId: CAPSULE,
      lifecycleId: LIFECYCLE,
      revision: 5,
      updatedAt: 1,
    });
    await seedVerified(env);

    const res = await post(finalizeCreditPost, env, body);
    expect(res.status).toBe(200);
    expect((await json(res))?.status).toBe("CONSUMED");
  });

  it("a fully finalized credit (binding cleared) fails a KV-null replay closed", async () => {
    const { env } = buildEnv();
    await reserveThroughCoordinator(env);
    await seedVerified(env);

    expect((await post(finalizeCreditPost, env, body)).status).toBe(200);

    // Finalization clears lifecycleId/capsuleId on the authoritative record,
    // so the fallback can no longer prove THIS reservation. Replay therefore
    // fails closed instead of re-binding a finished credit.
    const replay = await post(finalizeCreditPost, env, body);
    expect(replay.status).toBe(409);
    expect((await json(replay))?.error).toBe("LIFECYCLE_NOT_FOUND");
  });

  it("AVAILABLE (released) record cannot be finalized", async () => {
    const { env } = buildEnv();
    const binding = env.CREDIT_OP_COORDINATOR as ReturnType<
      typeof createFakeCreditCoordinatorBinding
    >;
    binding.get(binding.idFromName(CREDIT_ID));
    binding.storages.get(CREDIT_ID)!.data.set(`credit:${CREDIT_ID}`, {
      id: CREDIT_ID,
      creatorIdentityId: IDENTITY,
      status: "AVAILABLE",
      capsuleId: CAPSULE,
      lifecycleId: null,
      revision: 1,
      updatedAt: 1,
    });
    await seedVerified(env);

    const res = await post(finalizeCreditPost, env, body);
    expect(res.status).toBe(409);
    expect((await json(res))?.error).toBe("LIFECYCLE_NOT_FOUND");
  });

  it("identity mismatch → 409 IDENTITY_MISMATCH", async () => {
    const { env } = buildEnv();
    await reserveThroughCoordinator(env, { creatorIdentityId: OTHER_IDENTITY });
    await seedVerified(env);

    const res = await post(finalizeCreditPost, env, body);
    expect(res.status).toBe(409);
    expect((await json(res))?.error).toBe("IDENTITY_MISMATCH");
  });

  it("no address + KV null → legacy 409 LIFECYCLE_NOT_FOUND", async () => {
    const { env } = buildEnv();
    await reserveThroughCoordinator(env);
    await seedVerified(env);

    const { creatorCreditId: _omit, ...legacy } = body;
    const res = await post(finalizeCreditPost, env, legacy);
    expect(res.status).toBe(409);
    expect((await json(res))?.error).toBe("LIFECYCLE_NOT_FOUND");
  });

  it("coordinator unavailable → 503", async () => {
    const { env } = buildEnv({ withCoordinator: false });
    await seedVerified(env);

    const res = await post(finalizeCreditPost, env, body);
    expect(res.status).toBe(503);
    expect((await json(res))?.error).toBe("CREDIT_COORDINATOR_UNAVAILABLE");
  });
});

/* ─────────────────────────────── seal ─────────────────────────────── */

describe("R9-A92.3 — seal durable-credit authorization resolves a KV-null lifecycle", () => {
  const manifest = {
    version: 1,
    capsuleId: CAPSULE,
    saltBase: "b".repeat(32),
    vaultTxId: VAULT_TX,
    openAt: Date.now() + 1000,
    sealedAt: Date.now(),
    encryptedSizeBytes: 1024,
    heartbeatInterval: 86_400_000,
    ext: { vaultSha256: "c".repeat(64) },
  };

  const body = {
    uploadToken: TOKEN,
    manifest,
    creatorAuthorityFragment: AUTHORITY_FRAGMENT,
    creatorCreditId: CREDIT_ID,
  };

  async function seedSealEnv(env: Record<string, unknown>) {
    const kvs = env as Record<string, ReturnType<typeof createFakeKV>>;
    // Expired payment evidence forces the durable-credit fallback.
    await kvs.VERIFIED_PAYMENTS!.put(
      `verified-payment:${PAYMENT_INTENT}:${EVIDENCE}`,
      JSON.stringify({
        ok: true,
        paymentIntentId: PAYMENT_INTENT,
        transactionId: EVIDENCE,
        expiresAt: Date.now() - 1000,
      })
    );
    await kvs.VERIFIED_PAYMENTS!.put(
      `payment-intent:${PAYMENT_INTENT}`,
      EVIDENCE
    );
    await kvs.UPLOAD_TOKENS!.put(
      TOKEN,
      JSON.stringify({
        canonicalLifecycleId: LIFECYCLE,
        creatorIdentityId: IDENTITY,
        paymentIntentId: PAYMENT_INTENT,
        permissions: { uploadVault: true },
      })
    );
    await kvs.PUBLICATION_VERIFICATIONS!.put(
      `creator:publication:${LIFECYCLE}`,
      JSON.stringify({
        lifecycleId: LIFECYCLE,
        capsuleId: CAPSULE,
        creatorIdentityId: IDENTITY,
        state: "VERIFIED",
        expectedTxId: VAULT_TX,
        expectedVaultSha256: manifest.ext.vaultSha256,
        evidenceIds: [VAULT_TX],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        verifiedAt: Date.now(),
      })
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(null, {
          status: 200,
          headers: { "content-length": "1024" },
        })
      )
    );
  }

  it("KV null + authoritative CONSUMING → 200 and the manifest is persisted", async () => {
    const { env } = buildEnv();
    await reserveThroughCoordinator(env);
    await seedSealEnv(env);

    const res = await post(sealPost, env, body);
    expect(res.status).toBe(200);
    expect(
      await (env.CAPSULE_MANIFESTS as ReturnType<typeof createFakeKV>).get(CAPSULE)
    ).toBeTruthy();
  });

  it("identity mismatch → 402 PAYMENT_REQUIRED", async () => {
    const { env } = buildEnv();
    await reserveThroughCoordinator(env, { creatorIdentityId: OTHER_IDENTITY });
    await seedSealEnv(env);

    const res = await post(sealPost, env, body);
    expect(res.status).toBe(402);
  });

  it("capsule mismatch → 402", async () => {
    const { env } = buildEnv();
    await reserveThroughCoordinator(env, { capsuleId: OTHER_CAPSULE });
    await seedSealEnv(env);

    const res = await post(sealPost, env, body);
    expect(res.status).toBe(402);
  });

  it("payment intent mismatch → 402", async () => {
    const { env } = buildEnv();
    await reserveThroughCoordinator(env, { paymentIntentId: "intent-OTHER" });
    await seedSealEnv(env);

    const res = await post(sealPost, env, body);
    expect(res.status).toBe(402);
  });

  it("no address + KV null → existing 402 refusal (legacy)", async () => {
    const { env } = buildEnv();
    await reserveThroughCoordinator(env);
    await seedSealEnv(env);

    const { creatorCreditId: _omit, ...legacy } = body;
    const res = await post(sealPost, env, legacy);
    expect(res.status).toBe(402);
  });

  it("coordinator unavailable → 402", async () => {
    const { env } = buildEnv({ withCoordinator: false });
    await seedSealEnv(env);

    const res = await post(sealPost, env, body);
    expect(res.status).toBe(402);
  });
});
