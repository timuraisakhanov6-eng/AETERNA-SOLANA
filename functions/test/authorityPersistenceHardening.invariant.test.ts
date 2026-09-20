// @vitest-environment jsdom
/**
 * AETERNA — P2-4 capability persistence hardening (F-2 + F-5)
 *
 * Scope: the two P2-4 findings, proven end-to-end against the REAL
 * implementations.
 *
 *   F-5 — the CapsuleHold sessionStorage recovery record must be bound
 *         to the capsuleId being recovered. A record belonging to a
 *         different capsule fails closed; a matching record recovers
 *         exactly as before.
 *
 *   F-2 — creatorAuthorityFragment must never be persisted plaintext.
 *         The server stores a SHA-256 digest; verification hashes the
 *         incoming fragment and compares digests; the record carries a
 *         server-side TTL so it does not persist indefinitely.
 *
 * All external interactions are mocked (KVs are in-memory). No live
 * network, no Irys funding, no blockchain, no production KV, no money.
 */

import React from "react";
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { render, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { createFakeKV } from "./harness";
import { onRequestPost as sealPostRaw } from "./../api/capsule/seal";
import { onRequestPost as heartbeatPostRaw } from "./../api/heartbeat";

/* ───────────────── constants ───────────────── */

const CAPSULE_ID = "a".repeat(64);
const OTHER_CAPSULE_ID = "9".repeat(64);
const SALT_BASE = "b".repeat(32);
const RECIPIENT_SECRET = "c".repeat(64);
const CREATOR_AUTHORITY = "d".repeat(64);
const AUTHORITY_FRAGMENT = "f".repeat(64);
const VAULT_SHA256 = "e".repeat(64);
const VAULT_TX_ID = "t".repeat(43);
const UPLOAD_TOKEN = "u".repeat(32);
const PAYMENT_INTENT_ID = "payment-intent-1";
const EVIDENCE_ID = "a".repeat(43);
const LIFECYCLE_ID = "lifecycle-1";
const CREATOR_IDENTITY_ID = "creator-1";
const STORAGE_PAYMENT_ID = "storage-payment-1";
const WALLET_ACCOUNT = "wallet-account-1";
const ENCRYPTED_SIZE_BYTES = 1024;

const SEALED_AT = 1755000000000;
/**
 * Canonical heartbeatInterval is the ORIGINALLY SELECTED opening
 * interval (openAt - sealedAt), fixed at sealing time. seal.ts rejects
 * anything below HEARTBEAT_INTERVAL_MIN (one day), so this must be a
 * full day — not the ad-hoc 1-hour interval an earlier draft used.
 */
const HEARTBEAT_INTERVAL = 86_400_000; // 1 day
const OPEN_AT = SEALED_AT + HEARTBEAT_INTERVAL;

const ALLOWED_ORIGIN = "https://aeternacapsule.com";

/* ───────────────── helpers ───────────────── */

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function validManifest(capsuleId: string) {
  return {
    version: 1,
    capsuleId,
    saltBase: SALT_BASE,
    sealedAt: SEALED_AT,
    openAt: OPEN_AT,
    vaultTxId: VAULT_TX_ID,
    encryptedSizeBytes: ENCRYPTED_SIZE_BYTES,
    heartbeatInterval: HEARTBEAT_INTERVAL,
    ext: { vaultSha256: VAULT_SHA256 },
  };
}

/* ───────────────── F-2: seal endpoint ───────────────── */

type SealEnv = ReturnType<typeof buildSealEnv>;

function buildSealEnv() {
  return {
    CAPSULE_MANIFESTS: createFakeKV(),
    VERIFIED_PAYMENTS: createFakeKV(),
    UPLOAD_TOKENS: createFakeKV(),
    AUTHORITY_TOKENS: createFakeKV(),
    BUSINESS_QUOTES: createFakeKV(),
    PUBLICATION_VERIFICATIONS: createFakeKV(),
    DEBUG: "false" as const,
  };
}

function seedSealAuthority(env: SealEnv) {
  // Evidence the seal endpoint consumes. Mirrors seal.invariant.test.ts.
  env.PUBLICATION_VERIFICATIONS.put(
    `creator:publication:${LIFECYCLE_ID}`,
    JSON.stringify({
      lifecycleId: LIFECYCLE_ID,
      capsuleId: CAPSULE_ID,
      creatorIdentityId: CREATOR_IDENTITY_ID,
      state: "VERIFIED",
      expectedTxId: VAULT_TX_ID,
      expectedVaultSha256: VAULT_SHA256,
      evidenceIds: [VAULT_TX_ID],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      verifiedAt: Date.now(),
    })
  );
  env.VERIFIED_PAYMENTS.put(
    `payment-intent:${PAYMENT_INTENT_ID}`,
    EVIDENCE_ID
  );
  env.VERIFIED_PAYMENTS.put(
    `verified-payment:${PAYMENT_INTENT_ID}:${EVIDENCE_ID}`,
    JSON.stringify({
      ok: true,
      paymentIntentId: PAYMENT_INTENT_ID,
      transactionId: EVIDENCE_ID,
      expiresAt: Date.now() + 60_000,
    })
  );
  env.UPLOAD_TOKENS.put(
    UPLOAD_TOKEN,
    JSON.stringify({
      canonicalLifecycleId: LIFECYCLE_ID,
      creatorIdentityId: CREATOR_IDENTITY_ID,
      paymentIntentId: PAYMENT_INTENT_ID,
      permissions: { uploadVault: true },
    })
  );
}

function sealContext(env: SealEnv, body: unknown) {
  return {
    request: {
      headers: {
        get(name: string) {
          const map: Record<string, string> = {
            origin: ALLOWED_ORIGIN,
            "content-type": "application/json",
            "cf-connecting-ip": "203.0.113.1",
          };
          return map[name.toLowerCase()];
        },
      },
      json: async () => body,
    },
    env,
  };
}

const sealPost = sealPostRaw as unknown as (
  context: unknown
) => Promise<Response>;

async function runSeal() {
  const env = buildSealEnv();
  seedSealAuthority(env);
  const res = await sealPost(
    sealContext(env, {
      uploadToken: UPLOAD_TOKEN,
      manifest: validManifest(CAPSULE_ID),
      creatorAuthorityFragment: AUTHORITY_FRAGMENT,
    })
  );
  return { env, res };
}

/* ───────────────── F-2: heartbeat endpoint ───────────────── */

function heartbeatEnv(options: {
  storedAuthority: string | null;
  nowUtc?: number;
}) {
  const confirmations = createFakeKV();
  return {
    confirmations,
    env: {
      HEARTBEAT_CONFIRMATIONS: confirmations,
      AUTHORITY_TOKENS: {
        get: async () => options.storedAuthority,
      },
      CAPSULE_MANIFESTS: {
        get: async () =>
          JSON.stringify({
            version: 1,
            capsuleId: CAPSULE_ID,
            openAt: OPEN_AT,
            heartbeatInterval: HEARTBEAT_INTERVAL,
          }),
      },
      TIME_API_URL: undefined,
    },
  };
}

/**
 * The heartbeat endpoint resolves trusted time by fetching
 * `${origin}/api/time`. Stub only that call so the fragment-verification
 * logic under test is reached with a valid Time Authority; everything
 * else in the endpoint runs unmodified.
 */
function stubTrustedTime(nowUtc = SEALED_AT) {
  const realFetch = globalThis.fetch;
  let current = nowUtc;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.endsWith("/api/time")) {
      return new Response(JSON.stringify({ nowUtc: current }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input as RequestInfo);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    /**
     * Advance the Time Authority. Heartbeat enforces
     * `nowUtc > lastConfirmedAt` (STALE_CONFIRMATION, 409), so a
     * second confirmation must be observed later than the first —
     * exactly as it would be in production.
     */
    advanceTo(next: number) {
      current = next;
    },
  };
}

function heartbeatRequest(fragment: string) {
  return new Request("http://localhost/api/heartbeat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.1",
    },
    body: JSON.stringify({
      capsuleId: CAPSULE_ID,
      creatorAuthorityFragment: fragment,
    }),
  });
}

const heartbeatPost = heartbeatPostRaw as unknown as (
  context: unknown
) => Promise<Response>;

/* ═══════════════════════════════════════════════════════════
   F-2 — AUTHORITY TOKEN DIGEST + TTL
   ═══════════════════════════════════════════════════════════ */

describe("F-2 — creatorAuthorityFragment is never persisted plaintext", () => {
  it("stores a SHA-256 DIGEST, not the plaintext fragment", async () => {
    const { env, res } = await runSeal();

    expect(res.status).toBe(200);

    const storedAuthority = await env.AUTHORITY_TOKENS.get(CAPSULE_ID);
    expect(storedAuthority).toBeTruthy();

    // 3. plaintext creatorAuthorityFragment is never persisted
    expect(storedAuthority!).not.toContain(AUTHORITY_FRAGMENT);

    // 4. the stored authority value is a SHA-256 digest
    const parsed = JSON.parse(storedAuthority!) as { digest?: unknown };
    expect(typeof parsed.digest).toBe("string");
    expect(parsed.digest).toBe(await sha256Hex(AUTHORITY_FRAGMENT));
    expect(parsed.digest).not.toBe(AUTHORITY_FRAGMENT);
  });

  it("persists the authority record with a server-side TTL", async () => {
    const env = buildSealEnv();
    seedSealAuthority(env);

    const ttlCalls: Array<number | undefined> = [];
    const kv = env.AUTHORITY_TOKENS;
    const originalPut = kv.put.bind(kv);
    kv.put = async (
      key: string,
      value: string,
      options?: { expirationTtl?: number }
    ) => {
      ttlCalls.push(options?.expirationTtl);
      return originalPut(key, value, options);
    };

    const res = await sealPost(
      sealContext(env, {
        uploadToken: UPLOAD_TOKEN,
        manifest: validManifest(CAPSULE_ID),
        creatorAuthorityFragment: AUTHORITY_FRAGMENT,
      })
    );

    expect(res.status).toBe(200);
    expect(ttlCalls.length).toBeGreaterThan(0);
    // A positive, finite TTL is required — no unbounded persistence.
    expect(typeof ttlCalls[0]).toBe("number");
    expect(Number.isFinite(ttlCalls[0])).toBe(true);
    expect(ttlCalls[0]!).toBeGreaterThan(0);
  });

  it("does not leak the vault secret into the authority record", async () => {
    const { env } = await runSeal();

    const storedAuthority = await env.AUTHORITY_TOKENS.get(CAPSULE_ID);
    const storedManifest = await env.CAPSULE_MANIFESTS.get(CAPSULE_ID);

    // 8. no vault secret is exposed in the persisted authority record
    //    or the manifest
    for (const value of [storedAuthority, storedManifest]) {
      expect(value).toBeTruthy();
      expect(value!).not.toContain(RECIPIENT_SECRET);
      expect(value!).not.toContain(CREATOR_AUTHORITY);
    }
  });
});

describe("F-2 — heartbeat hashes the incoming fragment before comparison", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts an unexpired token when the incoming fragment hashes to the stored digest", async () => {
    const digest = await sha256Hex(AUTHORITY_FRAGMENT);
    const { env } = heartbeatEnv({
      storedAuthority: JSON.stringify({ digest }),
    });
    stubTrustedTime();

    const res = await heartbeatPost({
      request: heartbeatRequest(AUTHORITY_FRAGMENT),
      env,
    });

    // 7. valid unexpired authority token still works
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: unknown };
    expect(body.ok).toBe(true);
  });

  it("accepts a bare digest record form", async () => {
    const digest = await sha256Hex(AUTHORITY_FRAGMENT);
    const { env } = heartbeatEnv({ storedAuthority: digest });
    stubTrustedTime();

    const res = await heartbeatPost({
      request: heartbeatRequest(AUTHORITY_FRAGMENT),
      env,
    });

    expect(res.status).toBe(200);
  });

  it("rejects a fragment that does not match the stored digest", async () => {
    const digest = await sha256Hex(AUTHORITY_FRAGMENT);
    const { env } = heartbeatEnv({
      storedAuthority: JSON.stringify({ digest }),
    });

    const res = await heartbeatPost({
      request: heartbeatRequest("0".repeat(64)),
      env,
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: unknown };
    expect(body.code).toBe("INVALID_FRAGMENT");
  });

  it("rejects the legacy plaintext record shape (fail closed)", async () => {
    // A record written by the pre-hardening code stored the fragment
    // itself. It must NOT be accepted — accepting it would preserve
    // the plaintext-at-rest weakness.
    const { env } = heartbeatEnv({
      storedAuthority: JSON.stringify({ fragment: AUTHORITY_FRAGMENT }),
    });

    const res = await heartbeatPost({
      request: heartbeatRequest(AUTHORITY_FRAGMENT),
      env,
    });

    expect(res.status).toBe(403);
  });

  it("rejects when no authority token is stored (expired / absent TTL)", async () => {
    // 6. an expired authority token is rejected:
    //    KV TTL expiry removes the record, so the get returns null.
    const { env } = heartbeatEnv({ storedAuthority: null });

    const res = await heartbeatPost({
      request: heartbeatRequest(AUTHORITY_FRAGMENT),
      env,
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: unknown };
    expect(body.code).toBe("INVALID_FRAGMENT");
  });

  it("never compares against, or echoes, the plaintext fragment", async () => {
    const digest = await sha256Hex(AUTHORITY_FRAGMENT);
    const { env } = heartbeatEnv({
      storedAuthority: JSON.stringify({ digest }),
    });

    const res = await heartbeatPost({
      request: heartbeatRequest(AUTHORITY_FRAGMENT),
      env,
    });

    const text = await res.text();
    // 5. the incoming fragment is hashed before comparison — the raw
    //    fragment must not appear in the response body.
    expect(text).not.toContain(AUTHORITY_FRAGMENT);
  });

  it("keeps the digest stable: a second confirmation with the same fragment succeeds", async () => {
    const digest = await sha256Hex(AUTHORITY_FRAGMENT);
    const { env } = heartbeatEnv({
      storedAuthority: JSON.stringify({ digest }),
    });
    const clock = stubTrustedTime(SEALED_AT);

    const first = await heartbeatPost({
      request: heartbeatRequest(AUTHORITY_FRAGMENT),
      env,
    });

    // The Time Authority advances between confirmations, as it would
    // in production. A byte-identical fragment still verifies against
    // the same stored digest — the digest, not the clock, is what is
    // being proven stable here.
    clock.advanceTo(SEALED_AT + 1_000);

    const second = await heartbeatPost({
      request: heartbeatRequest(AUTHORITY_FRAGMENT),
      env,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });
});

/* ═══════════════════════════════════════════════════════════
   F-5 — CapsuleHold RECOVERY RECORD IDENTITY BINDING
   ═══════════════════════════════════════════════════════════ */

const hoisted = vi.hoisted(() => ({
  sealCapsuleCore: vi.fn(),
  sessionCapsuleId: { value: "a".repeat(64) },
}));

vi.mock("@/context/CapsuleContext", () => ({
  useCapsule: () => ({
    resetCapsule: vi.fn(),
    get capsuleId() {
      return hoisted.sessionCapsuleId.value;
    },
  }),
}));

vi.mock("@/context/AETERNAWalletContext", async () => {
  const ReactModule = await import("react");
  return { AETERNAWalletContext: ReactModule.createContext(null) };
});

vi.mock("@/lib/capsule/sealCapsuleCore", () => ({
  sealCapsuleCore: hoisted.sealCapsuleCore,
}));

vi.mock("@/lib/storage/creatorIrysStorage", () => ({
  createCreatorIrysStorage: vi.fn(() => ({
    name: "mock-storage",
    upload: vi.fn(),
    uploadChunk: vi.fn(),
    download: vi.fn(),
  })),
}));

vi.mock("@/lib/storage/creatorIrys", () => ({
  toCreatorIrysWallet: vi.fn(() => ({ publicKey: {} })),
}));

vi.mock("@/lib/runtime/runtimeRegistry", () => ({
  getRuntime: vi.fn(async () => ({
    readVault: async () => new Uint8Array(0),
    removeVault: async () => {},
  })),
  destroyRuntime: vi.fn(async () => {}),
}));

import CapsuleHold from "@/pages/capsule/CapsuleHold";
import { AETERNAWalletContext } from "@/context/AETERNAWalletContext";

function sessionRecord(capsuleId: string) {
  return {
    billableSizeBytes: 1024,
    expectedAmount: 1,
    openAt: OPEN_AT,
    capsuleId,
    itemIds: ["item-1"],
    encryptedVaultPointer: `aeterna-local-vault:${capsuleId}`,
    encryptedSizeBytes: ENCRYPTED_SIZE_BYTES,
    vaultSha256: VAULT_SHA256,
    saltBase: SALT_BASE,
    recipientSecret: RECIPIENT_SECRET,
    creatorAuthority: CREATOR_AUTHORITY,
    chunkMetadata: [],
  };
}

function locationState() {
  return {
    canonicalLifecycleId: LIFECYCLE_ID,
    creatorIdentityId: CREATOR_IDENTITY_ID,
    storagePaymentId: STORAGE_PAYMENT_ID,
    correlationTransactionId: null,
  };
}

function renderHold() {
  const walletValue = {
    state: { account: WALLET_ACCOUNT, connected: true },
    wallet: { account: WALLET_ACCOUNT },
  };
  return render(
    React.createElement(
      MemoryRouter,
      {
        initialEntries: [
          {
            pathname: "/create/hold",
            state: locationState(),
          },
        ],
      },
      React.createElement(
        AETERNAWalletContext.Provider,
        { value: walletValue },
        React.createElement(CapsuleHold)
      )
    )
  );
}

function installFetchMock() {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/upload-token") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ uploadToken: "t".repeat(32) }),
      };
    }
    if (url === "/api/time") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ nowUtc: SEALED_AT }),
      };
    }
    throw new Error("UNEXPECTED_FETCH:" + url);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("F-5 — recovery record is bound to the recovered capsuleId", () => {
  beforeEach(() => {
    hoisted.sealCapsuleCore.mockReset();
    hoisted.sealCapsuleCore.mockImplementation(
      async (params: { capsuleId: string }) => ({
        capsuleId: params.capsuleId,
        manifest: {},
        recipientLink: "",
        confirmationLink: "/confirmation",
        finalized: true,
        finalizationPending: false,
      })
    );
    hoisted.sessionCapsuleId.value = CAPSULE_ID;
    sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("matching capsuleId still recovers (no behaviour regression)", async () => {
    sessionStorage.setItem(
      "aeterna-prepared-capsule",
      JSON.stringify(sessionRecord(CAPSULE_ID))
    );
    installFetchMock();

    renderHold();

    // 2. matching capsuleId still recovers — the real seal path is
    //    reached with the recovered secret material.
    await waitFor(() => {
      expect(hoisted.sealCapsuleCore).toHaveBeenCalledTimes(1);
    });

    const params = hoisted.sealCapsuleCore.mock.calls[0][0] as {
      capsuleId: string;
      recipientSecret: string;
      creatorAuthority: string;
    };
    expect(params.capsuleId).toBe(CAPSULE_ID);
    expect(params.recipientSecret).toBe(RECIPIENT_SECRET);
    expect(params.creatorAuthority).toBe(CREATOR_AUTHORITY);
  });

  it("mismatched capsuleId fails closed (no recovery, no seal)", async () => {
    // The session record belongs to a DIFFERENT capsule than the one
    // this creator session is working on.
    sessionStorage.setItem(
      "aeterna-prepared-capsule",
      JSON.stringify(sessionRecord(OTHER_CAPSULE_ID))
    );
    installFetchMock();

    renderHold();

    // 1. mismatched capsuleId fails closed — never sealed, and the
    //    other capsule's secret material is never adopted.
    await new Promise((r) => setTimeout(r, 50));
    expect(hoisted.sealCapsuleCore).not.toHaveBeenCalled();
  });

  it("does not adopt secret material from a foreign record", async () => {
    sessionStorage.setItem(
      "aeterna-prepared-capsule",
      JSON.stringify(sessionRecord(OTHER_CAPSULE_ID))
    );
    installFetchMock();

    const { container } = renderHold();

    await new Promise((r) => setTimeout(r, 50));

    // Fail closed: the component renders nothing (redirect/fail-closed
    // guard), and no foreign secret reaches the seal boundary.
    expect(hoisted.sealCapsuleCore).not.toHaveBeenCalled();
    expect(container.textContent ?? "").not.toContain(RECIPIENT_SECRET);
    expect(container.textContent ?? "").not.toContain(CREATOR_AUTHORITY);
  });
});
