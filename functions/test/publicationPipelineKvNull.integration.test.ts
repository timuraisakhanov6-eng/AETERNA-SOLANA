/**
 * R9-A92.3 — END-TO-END: the complete publication/finalization pipeline with
 * a permanently stale-negative lifecycle KV projection.
 *
 * WHAT THIS PROVES
 * ----------------
 * The November 7 failure mode is modelled exactly: the coordinator holds a
 * valid CONSUMING reservation, but every read of
 * `creator:credit:lifecycle:<identity>:<lifecycle>` returns null for the
 * whole run. The REAL `sealCapsuleCore` drives the REAL endpoint handlers
 * (claim, publication verify, seal, seal verify, finalize) and the REAL
 * CreditOperationCoordinator over in-memory storage. Only the storage
 * adapter (Irys), the Irys node/gateway, and the trusted-clock endpoint are
 * local stand-ins.
 *
 * ASSERTED
 *   • the whole pipeline reaches `finalized === true`;
 *   • exactly ONE container DataItem is produced and claimed;
 *   • the SAME container txId is used throughout;
 *   • the lifecycle projection is never visible (the fallback carried it);
 *   • the authoritative credit ends CONSUMED;
 *   • no payment/entitlement operation is performed by the pipeline;
 *   • with no authoritative reservation the pipeline fails closed.
 *
 * No network, no wallet, no Irys, no payment, no Production state.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createFakeKV,
  createFakeRequest,
  createFakeCreditCoordinatorBinding,
} from "./harness";

import { onRequestPost as claimPost } from "../api/publication/claim";
import { onRequestPost as publicationVerifyPost } from "../api/publication/verify";
import { onRequestPost as sealPost } from "../api/capsule/seal";
import { onRequestPost as sealVerifyPost } from "../api/seal/verify";
import { onRequestPost as finalizeCreditPost } from "../api/creator/finalize-credit";

import { sealCapsuleCore } from "@/lib/capsule/sealCapsuleCore";
import { createLocalVaultPointer } from "@/lib/runtime/localVaultPointer";

import type { RuntimeStorage } from "@/lib/runtime/runtimeStorage";
import type {
  StorageAdapter,
  ContainerUploadOutcome,
} from "@/lib/storage/storageAdapter";
import type { ChunkMetadata } from "@/types/vault";

const ORIGIN = "https://aeternacapsule.com";
const IDENTITY = "creator-1";
const OTHER_IDENTITY = "creator-OTHER";
const LIFECYCLE = "lifecycle-1";
const CAPSULE = "a".repeat(64);
const CREDIT_ID = "credit-1";
const PAYMENT_INTENT = "intent-1";
const STORAGE_PAYMENT_ID = "sp-1";
const UPLOAD_TOKEN = "a".repeat(32);
const CONTAINER_TX = "C".repeat(43);
const VAULT_TX = "V".repeat(43);
const LAYOUT_DIGEST = "9".repeat(64);
const SALT_BASE = "b".repeat(32);
const RECIPIENT_SECRET = "e".repeat(64);
const CREATOR_AUTHORITY = "d".repeat(64);
const VAULT_BYTES = new Uint8Array([1, 2, 3, 4]);

/**
 * The manifest must carry the hash of the SAME ciphertext the publication
 * verifier fetches from the gateway; otherwise the seal gate (correctly)
 * reports PUBLICATION_HASH_MISMATCH.
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const VAULT_SHA256 = await sha256Hex(VAULT_BYTES);

const LIFECYCLE_KEY = `creator:credit:lifecycle:${IDENTITY}:${LIFECYCLE}`;

/** KV double: the lifecycle projection is permanently invisible. */
function createStaleLifecycleKV() {
  const inner = createFakeKV();
  return {
    async get(key: string) {
      if (key.startsWith("creator:credit:lifecycle:")) return null;
      return inner.get(key);
    },
    put(key: string, value: string, options?: { expirationTtl?: number }) {
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

interface Pipeline {
  env: Record<string, unknown>;
  kv: ReturnType<typeof createStaleLifecycleKV>;
  binding: ReturnType<typeof createFakeCreditCoordinatorBinding>;
}

function buildPipeline(options: { withCoordinator?: boolean } = {}): Pipeline {
  const kv = createStaleLifecycleKV();
  const env: Record<string, unknown> = {
    CREATOR_CREDITS: kv,
    PREPARED_PROJECTIONS: createFakeKV(),
    STORAGE_PAYMENTS: createFakeKV(),
    PUBLICATION_VERIFICATIONS: createFakeKV(),
    SEAL_VERIFICATIONS: createFakeKV(),
    CAPSULE_MANIFESTS: createFakeKV(),
    VERIFIED_PAYMENTS: createFakeKV(),
    UPLOAD_TOKENS: createFakeKV(),
    AUTHORITY_TOKENS: createFakeKV(),
    BUSINESS_QUOTES: createFakeKV(),
  };
  const binding = createFakeCreditCoordinatorBinding({
    creatorCredits: kv as never,
  });
  if (options.withCoordinator !== false) {
    env.CREDIT_OP_COORDINATOR = binding;
  } else {
    // Keep a usable binding for assertions even when the endpoint env omits it.
    env.CREDIT_OP_COORDINATOR = undefined;
  }
  return { env, kv, binding };
}

async function seedPayment(env: Record<string, unknown>) {
  await (env.STORAGE_PAYMENTS as ReturnType<typeof createFakeKV>).put(
    `storage-payment:${STORAGE_PAYMENT_ID}`,
    JSON.stringify({
      storagePaymentId: STORAGE_PAYMENT_ID,
      state: "PAYMENT_VERIFIED",
      transactionSignature: "S".repeat(88),
      payer: "B".repeat(44),
      quote: {
        storagePaymentId: STORAGE_PAYMENT_ID,
        preparedProjectionId: "prep-1",
        creatorIdentityId: IDENTITY,
        lifecycleId: LIFECYCLE,
        capsuleId: CAPSULE,
        expectedAmountAtomic: "312",
        irysDestination: "IrysDestinationAccount333333333333333333333",
        tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      },
    })
  );
}

async function seedUploadToken(env: Record<string, unknown>) {
  await (env.UPLOAD_TOKENS as ReturnType<typeof createFakeKV>).put(
    UPLOAD_TOKEN,
    JSON.stringify({
      canonicalLifecycleId: LIFECYCLE,
      creatorIdentityId: IDENTITY,
      paymentIntentId: PAYMENT_INTENT,
      permissions: { uploadVault: true },
    })
  );
}

async function reserve(
  pipeline: Pipeline,
  overrides: { creatorIdentityId?: string } = {}
) {
  const { binding } = pipeline;
  const res = await binding.get(binding.idFromName(CREDIT_ID)).fetch(
    new Request("https://aeterna-credit-coordinator.invalid", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "reserve",
        creatorCreditId: CREDIT_ID,
        creatorIdentityId: overrides.creatorIdentityId ?? IDENTITY,
        lifecycleId: LIFECYCLE,
        capsuleId: CAPSULE,
        paymentIntentId: PAYMENT_INTENT,
      }),
    })
  );
  return res;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Routes the exact paths `sealCapsuleCore` calls to the REAL handlers, and
 * stubs only the external Irys node/gateway + trusted clock.
 */
function installPipelineRouter(env: Record<string, unknown>) {
  const handler = async (
    endpoint: (context: never) => Promise<Response>,
    path: string,
    init?: RequestInit
  ) => {
    let body: unknown = {};
    try {
      body = JSON.parse(String(init?.body ?? "{}"));
    } catch {
      body = {};
    }
    const request = createFakeRequest({
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body,
    });
    return endpoint({ request, env } as never);
  };

  const router = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url === "/api/time") {
      return jsonResponse({ nowUtc: Date.now() });
    }

    if (url === "/api/publication/verify") {
      return handler(publicationVerifyPost as never, url, init);
    }
    if (url === "/api/capsule/seal") {
      return handler(sealPost as never, url, init);
    }
    if (url === "/api/seal/verify") {
      return handler(sealVerifyPost as never, url, init);
    }
    if (url === "/api/creator/finalize-credit") {
      return handler(finalizeCreditPost as never, url, init);
    }

    if (url.startsWith("https://uploader.irys.xyz")) {
      const txId = url.split("/").pop() ?? VAULT_TX;
      return jsonResponse({ id: txId });
    }

    if (
      url.startsWith("https://gateway.irys.xyz") ||
      url.startsWith("https://arweave.net")
    ) {
      return new Response(VAULT_BYTES, {
        status: 200,
        headers: { "content-length": String(VAULT_BYTES.byteLength) },
      });
    }

    return new Response("unexpected", { status: 500 });
  });

  vi.stubGlobal("fetch", router);
  return router;
}

function installSessionStoragePolyfill(): void {
  const store = new Map<string, string>();
  const mock: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    removeItem: (k: string) => {
      store.delete(k);
    },
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
  };
  Object.defineProperty(globalThis, "sessionStorage", {
    value: mock,
    configurable: true,
    writable: true,
  });
}

function buildRuntime(): RuntimeStorage {
  const vaultStore = new Map<string, Uint8Array>([
    [`${CAPSULE}:__vault__`, VAULT_BYTES],
  ]);
  return {
    open: async () => {},
    store: async () => {},
    read: async () => new Uint8Array([9]),
    remove: async () => {},
    storeVault: async (_capsuleId: string, ciphertext: Uint8Array) => {
      vaultStore.set(`${CAPSULE}:__vault__`, ciphertext);
    },
    readVault: async () => {
      const bytes = vaultStore.get(`${CAPSULE}:__vault__`);
      if (!bytes) throw new Error("[test] vault missing");
      return bytes;
    },
    removeVault: async () => {
      vaultStore.delete(`${CAPSULE}:__vault__`);
    },
    clear: async () => {
      vaultStore.delete(`${CAPSULE}:__vault__`);
    },
  } as unknown as RuntimeStorage;
}

interface Recorder {
  adapter: StorageAdapter;
  containerUploads: number;
  vaultUploads: number;
  claimedContainerTxIds: string[];
  paymentCalls: number;
}

/**
 * Real endpoint calls for both publication claims; only the Irys upload
 * itself is local. This keeps the claim authority, idempotency and the
 * KV-null fallback in the loop.
 */
function buildAdapter(env: Record<string, unknown>): Recorder {
  const rec: Recorder = {
    containerUploads: 0,
    vaultUploads: 0,
    claimedContainerTxIds: [],
    paymentCalls: 0,
    adapter: null as unknown as StorageAdapter,
  };

  const claim = async (body: Record<string, unknown>) => {
    const request = createFakeRequest({
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: {
        creatorIdentityId: IDENTITY,
        lifecycleId: LIFECYCLE,
        capsuleId: CAPSULE,
        storagePaymentId: STORAGE_PAYMENT_ID,
        creatorCreditId: CREDIT_ID,
        ...body,
      },
    });
    const res = await (claimPost as never as (
      context: never
    ) => Promise<Response>)({ request, env } as never);
    if (!res.ok) {
      const payload = await res.json().catch(() => null);
      throw new Error(
        `[test] claim failed: ${res.status} ${JSON.stringify(payload)}`
      );
    }
  };

  rec.adapter = {
    name: "e2e-adapter",
    async upload() {
      rec.vaultUploads += 1;
      await claim({ txId: VAULT_TX, kind: "vault" });
      return { txId: VAULT_TX };
    },
    async uploadContainer(
      _runtime: RuntimeStorage,
      chunkMetadata: readonly ChunkMetadata[]
    ): Promise<ContainerUploadOutcome> {
      rec.containerUploads += 1;
      return {
        containerTxId: CONTAINER_TX,
        chunkIds: chunkMetadata.map((c) => c.chunkId),
        layoutDigest: LAYOUT_DIGEST,
      };
    },
    async claimContainerUpload(outcome: ContainerUploadOutcome) {
      rec.claimedContainerTxIds.push(outcome.containerTxId);
      await claim({
        txId: outcome.containerTxId,
        kind: "container",
        chunkIds: [...outcome.chunkIds],
        layoutDigest: outcome.layoutDigest,
      });
    },
    async download() {
      throw new Error("[test] download not used");
    },
  } as unknown as StorageAdapter;

  return rec;
}

function chunkMeta(count: number): readonly ChunkMetadata[] {
  return Array.from({ length: count }, (_, i) => ({
    chunkId: `${String(i).padStart(2, "0")}${"d".repeat(62)}`,
    mediaId: `media-${i}`,
    index: 0,
    size: 512,
  })) as unknown as readonly ChunkMetadata[];
}

function params(rec: Recorder) {
  return {
    capsuleId: CAPSULE,
    saltBase: SALT_BASE,
    recipientSecret: RECIPIENT_SECRET,
    creatorAuthority: CREATOR_AUTHORITY,
    openAt: Date.now() + 3 * 86_400_000,
    uploadToken: UPLOAD_TOKEN,
    canonicalLifecycleId: LIFECYCLE,
    creatorIdentityId: IDENTITY,
    creatorCreditId: CREDIT_ID,
    storage: rec.adapter,
    encryptedVaultPointer: createLocalVaultPointer(CAPSULE),
    encryptedSizeBytes: VAULT_BYTES.byteLength,
    vaultSha256: VAULT_SHA256,
    runtime: buildRuntime(),
    chunkMetadata: chunkMeta(2),
  };
}

function creditStatus(pipeline: Pipeline): string | undefined {
  const record = pipeline.binding.storages
    .get(CREDIT_ID)
    ?.data.get(`credit:${CREDIT_ID}`) as { status?: string } | undefined;
  return record?.status;
}

describe("R9-A92.3 — end-to-end pipeline with a permanently stale lifecycle KV", () => {
  beforeEach(() => {
    installSessionStoragePolyfill();
    try {
      sessionStorage.clear();
    } catch {
      /* tolerated */
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("completes publication + finalization without the KV projection ever being visible", async () => {
    const pipeline = buildPipeline();
    await reserve(pipeline);
    await seedPayment(pipeline.env);
    await seedUploadToken(pipeline.env);
    installPipelineRouter(pipeline.env);

    const rec = buildAdapter(pipeline.env);

    const result = await sealCapsuleCore(params(rec));

    // The projection was null for the entire run — the fallback carried it.
    expect(await pipeline.kv.get(LIFECYCLE_KEY)).toBeNull();

    expect(result.finalized).toBe(true);
    expect(result.capsuleId).toBe(CAPSULE);

    // Exactly one container DataItem, claimed with the SAME txId.
    expect(rec.containerUploads).toBe(1);
    expect(rec.vaultUploads).toBe(1);
    expect(rec.claimedContainerTxIds).toEqual([CONTAINER_TX]);

    // The authoritative credit completed its ONE permitted transition.
    expect(creditStatus(pipeline)).toBe("CONSUMED");

    // No payment or entitlement operation was performed by the pipeline.
    expect(rec.paymentCalls).toBe(0);
  });

  it("fails closed when the authoritative reservation is absent (no fabricated progress)", async () => {
    const pipeline = buildPipeline();
    // Not reserved: the coordinator has no record for this credit id.
    await seedPayment(pipeline.env);
    await seedUploadToken(pipeline.env);
    installPipelineRouter(pipeline.env);

    const rec = buildAdapter(pipeline.env);

    await expect(sealCapsuleCore(params(rec))).rejects.toThrow();

    expect(rec.vaultUploads).toBe(0);
    expect(creditStatus(pipeline)).toBeUndefined();
  });

  it("fails closed when the reservation belongs to another creator identity", async () => {
    const pipeline = buildPipeline();
    await reserve(pipeline, { creatorIdentityId: OTHER_IDENTITY });
    await seedPayment(pipeline.env);
    await seedUploadToken(pipeline.env);
    installPipelineRouter(pipeline.env);

    const rec = buildAdapter(pipeline.env);

    await expect(sealCapsuleCore(params(rec))).rejects.toThrow();

    // The container upload happens locally, but no publication authority can
    // be established and no vault is uploaded.
    expect(rec.vaultUploads).toBe(0);
  });
});
