/**
 * sealCapsuleCore heartbeatInterval contract (blocker #2)
 *
 * Regression scope: the manifest POSTed to /api/capsule/seal must carry
 * `heartbeatInterval` as the RAW canonical difference
 * `openAt - sealedAt` in MILLISECONDS — no minute division, no rounding,
 * no Math.max(1, …) clamp, no other new semantic limit.
 *
 * Pre-fix the value was `Math.max(1, Math.floor((openAt - sealedAt) / 60000))`
 * (minutes, clamped to >= 1).
 *
 * These are real sealCapsuleCore behavior tests: the real module runs and
 * the produced seal request body is inspected. All external interactions
 * are mocked:
 *   - global fetch (time, publication verify, seal, seal verify, finalize),
 *   - runtime storage, creator storage adapter,
 *   - creator-authority HKDF derivation,
 *   - sessionStorage.
 *
 * No live network, no Irys funding, no blockchain, no production KV.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/heartbeat/deriveCreatorAuthorityFragment", () => ({
  deriveCreatorAuthorityFragment: vi.fn(async () => "f".repeat(64)),
}));

import { sealCapsuleCore } from "@/lib/capsule/sealCapsuleCore";

/* ───────────────── constants ───────────────── */

const CAPSULE_ID = "a".repeat(64);
const SALT_BASE = "b".repeat(32);
const RECIPIENT_SECRET = "c".repeat(64);
const CREATOR_AUTHORITY = "d".repeat(64);
const VAULT_SHA256 = "e".repeat(64);
const UPLOAD_TOKEN = "u".repeat(32);
const VAULT_TX_ID = "t".repeat(43);
const LIFECYCLE_ID = "lifecycle-1";
const CREATOR_IDENTITY_ID = "creator-1";
const ENCRYPTED_SIZE_BYTES = 1024;

const SEALED_AT = 1755000000000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/* ───────────────── harness ───────────────── */

type JsonResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
};

function jsonResponse(status: number, body: unknown): JsonResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function createMemoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
}

function createRuntime() {
  return {
    open: async () => {},
    store: async () => {},
    read: async () => ({
      chunkId: "",
      ciphertext: new Uint8Array(0),
    }),
    remove: async () => {},
    storeVault: async () => {},
    readVault: async () => new Uint8Array(ENCRYPTED_SIZE_BYTES),
    removeVault: async () => {},
    clear: async () => {},
  };
}

function createStorageAdapter() {
  return {
    name: "mock-storage",
    upload: vi.fn(async () => ({ txId: VAULT_TX_ID })),
    uploadChunk: vi.fn(async () => ({ txId: VAULT_TX_ID })),
    download: vi.fn(async () => new Uint8Array(0)),
  };
}

interface SealRequestBody {
  uploadToken: string;
  manifest: {
    sealedAt: number;
    openAt: number;
    heartbeatInterval: number;
    [key: string]: unknown;
  };
  creatorAuthorityFragment: string;
}

interface Harness {
  params: Record<string, unknown>;
  sealRequests: SealRequestBody[];
  fetchMock: ReturnType<typeof vi.fn>;
  storage: ReturnType<typeof createStorageAdapter>;
  openAt: number;
  sealedAt: number;
}

function buildHarness(openAtDelta: number): Harness {
  const openAt = SEALED_AT + openAtDelta;
  const sealRequests: SealRequestBody[] = [];
  const storage = createStorageAdapter();

  const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
    if (url === "/api/time") {
      return jsonResponse(200, { nowUtc: SEALED_AT });
    }
    if (url === "/api/publication/verify") {
      return jsonResponse(200, { ok: true, state: "VERIFIED" });
    }
    if (url === "/api/capsule/seal") {
      const parsed = init?.body
        ? (JSON.parse(init.body) as SealRequestBody)
        : null;
      if (parsed) sealRequests.push(parsed);
      return jsonResponse(200, { ok: true });
    }
    if (url === "/api/seal/verify") {
      return jsonResponse(200, { ok: true, state: "VERIFIED" });
    }
    if (url === "/api/creator/finalize-credit") {
      // Non-terminal outcome -> finalizationPending, so the persisted
      // manifest survives and a retry takes the reuse path.
      return jsonResponse(200, { ok: true, outcome: "PENDING" });
    }
    throw new Error("UNEXPECTED_FETCH:" + url);
  });

  vi.stubGlobal("fetch", fetchMock);

  const params = {
    capsuleId: CAPSULE_ID,
    saltBase: SALT_BASE,
    recipientSecret: RECIPIENT_SECRET,
    creatorAuthority: CREATOR_AUTHORITY,
    openAt,
    uploadToken: UPLOAD_TOKEN,
    canonicalLifecycleId: LIFECYCLE_ID,
    creatorIdentityId: CREATOR_IDENTITY_ID,
    storage,
    encryptedVaultPointer: `aeterna-local-vault:${CAPSULE_ID}`,
    encryptedSizeBytes: ENCRYPTED_SIZE_BYTES,
    vaultSha256: VAULT_SHA256,
    runtime: createRuntime(),
    chunkMetadata: [],
  };

  return { params, sealRequests, fetchMock, storage, openAt, sealedAt: SEALED_AT };
}

describe("sealCapsuleCore heartbeatInterval contract", () => {
  beforeEach(() => {
    vi.stubGlobal("sessionStorage", createMemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fresh seal manifest.heartbeatInterval equals raw (openAt - sealedAt) milliseconds", async () => {
    const h = buildHarness(SEVEN_DAYS_MS);

    const result = await sealCapsuleCore(h.params as never);

    expect(h.sealRequests).toHaveLength(1);
    const manifest = h.sealRequests[0]!.manifest;

    expect(manifest.sealedAt).toBe(h.sealedAt);
    expect(manifest.openAt).toBe(h.openAt);
    expect(manifest.heartbeatInterval).toBe(h.openAt - h.sealedAt);
    expect(result.manifest.heartbeatInterval).toBe(h.openAt - h.sealedAt);
  });

  it("retry reuses the persisted manifest with identical canonical milliseconds", async () => {
    const h = buildHarness(SEVEN_DAYS_MS);

    await sealCapsuleCore(h.params as never);
    expect(h.sealRequests).toHaveLength(1);
    const fresh = h.sealRequests[0]!.manifest;

    await sealCapsuleCore(h.params as never);
    expect(h.sealRequests).toHaveLength(2);
    const retried = h.sealRequests[1]!.manifest;

    // The retry must resubmit the canonical manifest verbatim.
    expect(retried).toEqual(fresh);
    expect(retried.sealedAt).toBe(fresh.sealedAt);
    expect(retried.heartbeatInterval).toBe(fresh.heartbeatInterval);
    expect(retried.heartbeatInterval).toBe(h.openAt - h.sealedAt);

    // No second upload / publication on the reuse path.
    expect(h.storage.upload).toHaveBeenCalledTimes(1);
    const publicationCalls = h.fetchMock.mock.calls.filter(
      ([url]) => url === "/api/publication/verify"
    );
    expect(publicationCalls).toHaveLength(1);
  });

  it("does not clamp or round sub-minute open windows", async () => {
    const ninetySeconds = 90_000;
    const h = buildHarness(ninetySeconds);

    await sealCapsuleCore(h.params as never);

    expect(h.sealRequests).toHaveLength(1);
    expect(h.sealRequests[0]!.manifest.heartbeatInterval).toBe(
      ninetySeconds
    );
  });

  it("emits canonical millisecond intervals for 1 / 30 / 365 day windows", async () => {
    const ONE_DAY = 24 * 60 * 60 * 1000;
    const windows = [ONE_DAY, 30 * ONE_DAY, 365 * ONE_DAY];

    for (const delta of windows) {
      // A fresh retry-cache per window: the persisted-manifest reuse path is
      // intentionally bypassed so each window exercises the fresh seal path.
      sessionStorage.clear();

      const h = buildHarness(delta);
      const result = await sealCapsuleCore(h.params as never);

      expect(h.sealRequests).toHaveLength(1);
      const emitted = h.sealRequests[0]!.manifest.heartbeatInterval;

      // Raw canonical difference in UTC milliseconds — no minutes division.
      expect(emitted).toBe(delta);
      expect(result.manifest.heartbeatInterval).toBe(delta);

      // The generated value must satisfy the existing server-enforced
      // canonical bounds (1 day .. 100 years).
      expect(emitted).toBeGreaterThanOrEqual(86_400_000);
      expect(emitted).toBeLessThanOrEqual(3_153_600_000_000);
    }
  });
});
