/**
 * AETERNA — sealCapsuleCore vault retry ORDER (Phase 3BM-R6).
 *
 * ROOT CAUSE (3BM-R5): the core read `runtime.readVault(capsuleId)`
 * unconditionally BEFORE the cached vault txId, so a resume after a
 * cleared runtime (`destroyRuntime` → `runtime.clear()` wipes the
 * IndexedDB vault record) failed with "Runtime vault not found" →
 * SEAL_UNKNOWN before the first HTTP call — the durable-credit seal
 * fix was never reached.
 *
 * THE FIX under test: the validated vault txId cache is read FIRST;
 * the runtime payload is read ONLY when a fresh upload can actually
 * run (no cache). The cache stays EVIDENCE ONLY — the server-side
 * publication verify / seal verify / finalize re-validate everything.
 *
 * Test A — cached vault resume: readVault must NOT be called, no Irys
 * upload / container upload / wallet signature may run, the cached
 * container outcome is claimed verbatim, and the seal request carries
 * the ORIGINAL capsule identity (capsuleId / vaultTxId / uploadToken).
 *
 * Test B — missing cached vault txId: the flow fails closed BEFORE any
 * upload / claim / seal request (fail-closed unchanged).
 *
 * Node environment. All network, time, storage and runtime boundaries
 * are mocked. No production services, no wallet, no payment.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const CAPSULE_ID = "a".repeat(64);
const SALT_BASE = "c".repeat(32);
const VAULT_SHA256 = "d".repeat(64);
const RECIPIENT_SECRET = "e".repeat(64);
const CREATOR_AUTHORITY = "f".repeat(64);
const UPLOAD_TOKEN = "t".repeat(40);
const VAULT_TX_ID = "v".repeat(43);
const CONTAINER_TX_ID = "C".repeat(43);
const LAYOUT_DIGEST = "b".repeat(64);
const NOW_UTC = 1_800_000_000_000;
const OPEN_AT = NOW_UTC + 2 * 24 * 60 * 60 * 1000;

vi.mock("@/shared/time/getTrustedTime", () => ({
  getTrustedTime: vi.fn(async () => ({ nowUtc: NOW_UTC })),
}));

import { sealCapsuleCore } from "./sealCapsuleCore";

const VAULT_CACHE_KEY = `aeterna-vault-txid:${CAPSULE_ID}`;
const CONTAINER_CACHE_KEY = `aeterna-container-upload:${CAPSULE_ID}`;

const store = new Map<string, string>();

const sessionStub = {
  getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
  setItem: (key: string, value: string) => {
    store.set(key, String(value));
  },
  removeItem: (key: string) => {
    store.delete(key);
  },
};

function makeRuntime() {
  return {
    readVault: vi.fn(async () => {
      throw new Error("[AETERNA] Runtime vault not found.");
    }),
    removeVault: vi.fn(async () => {}),
  };
}

function makeAdapter() {
  return {
    upload: vi.fn(async () => {
      throw new Error("vault upload must not run");
    }),
    uploadContainer: vi.fn(async () => {
      throw new Error("container upload must not run");
    }),
    claimContainerUpload: vi.fn(async () => {}),
  };
}

const fetchCalls: Array<{ url: string; body: Record<string, unknown> | null }> =
  [];

const fetchMock = vi.fn(async (input: unknown, init?: { body?: string }) => {
  const url = String(input);
  let body: Record<string, unknown> | null = null;
  try {
    body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  fetchCalls.push({ url, body });

  const jsonResponse = (payload: unknown) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  if (url.includes("/api/publication/verify")) {
    return jsonResponse({ ok: true, state: "VERIFIED" });
  }
  if (url.includes("/api/capsule/seal")) {
    // The seal endpoint response body is not consumed on success; the
    // authoritative verification happens through /api/seal/verify.
    return new Response("{}", { status: 200 });
  }
  if (url.includes("/api/seal/verify")) {
    return jsonResponse({ ok: true, state: "VERIFIED" });
  }
  if (url.includes("/api/creator/finalize-credit")) {
    return jsonResponse({ ok: true, outcome: "CONSUMED" });
  }
  throw new Error("UNEXPECTED_FETCH:" + url);
});

function coreParams() {
  return {
    capsuleId: CAPSULE_ID,
    encryptedVaultPointer: `aeterna-local-vault:${CAPSULE_ID}`,
    encryptedSizeBytes: 16,
    vaultSha256: VAULT_SHA256,
    saltBase: SALT_BASE,
    recipientSecret: RECIPIENT_SECRET,
    creatorAuthority: CREATOR_AUTHORITY,
    openAt: OPEN_AT,
    description: "",
    uploadToken: UPLOAD_TOKEN,
    canonicalLifecycleId: "lifecycle-1",
    creatorIdentityId: "creator-1",
    storage: makeAdapter(),
    runtime: makeRuntime(),
    chunkMetadata: [
      { chunkId: "chunk-1", mediaId: "media-1", index: 0, size: 16 },
    ],
  };
}

function seedCaches(options?: { withoutVaultTxId?: boolean }): void {
  if (!options?.withoutVaultTxId) {
    store.set(VAULT_CACHE_KEY, VAULT_TX_ID);
  }
  store.set(
    CONTAINER_CACHE_KEY,
    JSON.stringify({
      containerTxId: CONTAINER_TX_ID,
      chunkIds: ["chunk-1"],
      layoutDigest: LAYOUT_DIGEST,
    })
  );
}

describe("sealCapsuleCore vault retry order (3BM-R6)", () => {
  beforeEach(() => {
    store.clear();
    fetchCalls.length = 0;
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("sessionStorage", sessionStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Test A — cached vault resume skips readVault and all uploads, reaches the seal with the ORIGINAL identity", async () => {
    seedCaches();
    const params = coreParams();
    const runtime = params.runtime;
    const adapter = params.storage;

    const result = await sealCapsuleCore(params);

    // The previous failure point is gone: the runtime vault is NEVER read.
    expect(runtime.readVault).not.toHaveBeenCalled();

    // No new Irys upload / container build / signature is initiated:
    // the vault txId and the container outcome come from the caches.
    expect(adapter.upload).not.toHaveBeenCalled();
    expect(adapter.uploadContainer).not.toHaveBeenCalled();

    // The cached container outcome is claimed verbatim (idempotent claim).
    expect(adapter.claimContainerUpload).toHaveBeenCalledTimes(1);
    const claimArg = adapter.claimContainerUpload.mock.calls[0][0] as {
      containerTxId: string;
    };
    expect(claimArg.containerTxId).toBe(CONTAINER_TX_ID);

    // Exactly the four authoritative HTTP calls ran — nothing else.
    const urls = fetchCalls.map((call) => call.url);
    expect(urls.filter((u) => u.includes("/api/capsule/seal"))).toHaveLength(1);
    expect(urls.some((u) => u.includes("/api/publication/verify"))).toBe(true);
    expect(urls.some((u) => u.includes("/api/seal/verify"))).toBe(true);
    expect(urls.some((u) => u.includes("/api/creator/finalize-credit"))).toBe(
      true
    );

    // The seal request uses the ORIGINAL capsule identity: capsuleId,
    // the CACHED vault txId and the minted upload token.
    const sealCall = fetchCalls.find((call) =>
      call.url.includes("/api/capsule/seal")
    );
    expect(sealCall).toBeTruthy();
    const sealBody = sealCall!.body as {
      uploadToken: string;
      manifest: {
        capsuleId: string;
        vaultTxId: string;
        encryptedSizeBytes: number;
      };
      creatorAuthorityFragment: string;
    };
    expect(sealBody.uploadToken).toBe(UPLOAD_TOKEN);
    expect(sealBody.manifest.capsuleId).toBe(CAPSULE_ID);
    expect(sealBody.manifest.vaultTxId).toBe(VAULT_TX_ID);
    expect(sealBody.manifest.encryptedSizeBytes).toBe(16);
    expect(sealBody.creatorAuthorityFragment).toMatch(/^[a-f0-9]{64}$/);

    // The full finalization succeeded — no finalizationPending.
    expect(result.capsuleId).toBe(CAPSULE_ID);
    expect(result.finalized).toBe(true);
    expect(result.finalizationPending).toBe(false);
    expect(result.confirmationLink).toBe(
      `/capsule/${CAPSULE_ID}#${RECIPIENT_SECRET}&c=${sealBody.creatorAuthorityFragment}`
    );
  });

  it("Test B — missing cached vault txId fails closed before any upload, claim or seal request", async () => {
    seedCaches({ withoutVaultTxId: true });
    const params = coreParams();
    const runtime = params.runtime;
    const adapter = params.storage;

    await expect(sealCapsuleCore(params)).rejects.toThrow(
      /\[AETERNA\] Capsule sealing failed: SEAL_UNKNOWN/
    );

    // The payload is required for a fresh upload: readVault ran exactly
    // once per invocation and its failure is the authoritative refusal.
    expect(runtime.readVault).toHaveBeenCalledTimes(1);

    // No unsafe fallback: no upload, no claim, no seal, no verification.
    expect(adapter.upload).not.toHaveBeenCalled();
    expect(adapter.uploadContainer).not.toHaveBeenCalled();
    expect(adapter.claimContainerUpload).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
  });
});
