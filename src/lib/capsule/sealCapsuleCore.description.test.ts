import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * CAPSULE DESCRIPTION — seal-level wire proof.
 *
 * WHAT THESE TESTS PIN
 * --------------------
 * `description` is an OPTIONAL public field of the persisted ManifestV1.
 * A production capsule sealed with a description showed NO description
 * after opening because `sealCapsuleCore` accepted the param but never
 * destructured it and never wrote it into the manifest literal — the
 * value was silently dropped BEFORE publication. These tests pin the
 * fix at the WIRE boundary: they capture the JSON body actually POSTed
 * to `/api/capsule/seal` and assert on the manifest it carries.
 *
 *   A. non-empty description → the POSTed manifest CONTAINS `description`
 *      with the exact value.
 *   B. no description        → the POSTed manifest has NO `description`
 *      key at all (specifically NOT `description: ""`).
 *   C. empty-string description → treated as absent (no `description`
 *      key, NOT `description: ""`).
 *   D. length contract        → a per-UI-limit (140) description is
 *      carried verbatim and stays within the server cap of 500.
 *   E. identity parity        → the manifest persisted/emitted at
 *      `/api/capsule/seal` and the manifest submitted to
 *      `/api/seal/verify` carry the SAME `description`. (The canonical
 *      serializer itself is owned and type-checked by
 *      functions/test/canonicalManifest.invariant.test.ts; here we only
 *      prove the seal core feeds the identical value to both endpoints.)
 *
 * NON-VACUOUS: test A verifies the captured body is the REAL seal body
 * (it carries `uploadToken` + `manifest`), so a broken body-capture spy
 * cannot make the assertions pass.
 *
 * No live network, no wallet, no Irys, no payment, no KV.
 */

import { sealCapsuleCore } from "./sealCapsuleCore";

import { createLocalVaultPointer } from "@/lib/runtime/localVaultPointer";

import type { RuntimeStorage } from "@/lib/runtime/runtimeStorage";

import type { StorageAdapter } from "@/lib/storage/storageAdapter";

import type { ChunkMetadata } from "@/types/vault";

const CAPSULE_ID = "a".repeat(64);
const SALT_BASE = "b".repeat(32);
const VAULT_SHA256 = "c".repeat(64);
const CREATOR_AUTHORITY = "d".repeat(64);
const RECIPIENT_SECRET = "e".repeat(64);
const UPLOAD_TOKEN = "f".repeat(43);
const LIFECYCLE_ID = "lifecycle-" + "1".repeat(20);
const IDENTITY_ID = "0".repeat(32);

/** UI cap (CapsuleBuilder.MAX_DESCRIPTION) — the client-side contract. */
const UI_MAX_DESCRIPTION = 140;

/** Server/validator cap (functions/api/capsule/seal.ts) — fixed contract. */
const SERVER_MAX_DESCRIPTION = 500;

const VAULT_BYTES = new Uint8Array([1, 2, 3, 4]);

function buildRuntime(): RuntimeStorage {
  return {
    open: async () => {},
    store: async () => {},
    read: async () => new Uint8Array([9, 8, 7, 6]),
    remove: async () => {},
    storeVault: async () => {},
    readVault: async () => VAULT_BYTES,
    removeVault: async () => {},
    clear: async () => {},
  } as unknown as RuntimeStorage;
}

/**
 * A StorageAdapter that resolves with well-formed values so the flow can
 * reach the post-upload POSTs. The Vault channel is the only content
 * channel exercised here (text-only capsules).
 */
function buildStorage(): StorageAdapter {
  return {
    name: "description-test-adapter",
    async upload() {
      return { txId: "tx".padEnd(43, "Z") };
    },
    async uploadContainer(
      _runtime: unknown,
      chunkMetadata: readonly { chunkId: string }[]
    ) {
      return {
        containerTxId: "ch".padEnd(43, "Z"),
        chunkIds: chunkMetadata.map((c) => c.chunkId),
        layoutDigest: "a".repeat(64),
      };
    },
    async download() {
      throw new Error("[test] download not used");
    },
  } as unknown as StorageAdapter;
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  } as unknown as Response;
}

interface CapturedCall {
  url: string;
  body: Record<string, unknown> | undefined;
}

/**
 * Fetch router that records BOTH the URL and the parsed JSON body of
 * every request, so tests can assert on the exact manifest that reached
 * `/api/capsule/seal` and `/api/seal/verify`.
 */
function installFetchRouter(
  handlers: Record<string, () => Promise<Response>>
): { calls: CapturedCall[]; restore: () => void } {
  const calls: CapturedCall[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = vi.fn(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      let body: Record<string, unknown> | undefined = undefined;
      const raw = init?.body;
      if (typeof raw === "string") {
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = undefined;
        }
      }

      calls.push({ url, body });

      const key = Object.keys(handlers).find((k) => url.includes(k));
      if (!key) {
        return Promise.resolve(jsonResponse(404, { error: "NO_HANDLER" }));
      }
      return handlers[key]!();
    }
  ) as unknown as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const OK_HANDLERS = {
  "/api/time": async () => jsonResponse(200, { nowUtc: Date.now() }),
  "/api/publication/verify": async () =>
    jsonResponse(200, { ok: true, state: "VERIFIED" }),
  "/api/capsule/seal": async () => jsonResponse(200, { ok: true }),
  "/api/seal/verify": async () =>
    jsonResponse(200, { ok: true, state: "VERIFIED" }),
  "/api/creator/finalize-credit": async () =>
    jsonResponse(200, { ok: true, outcome: "CONSUMED" }),
};

function baseParams(
  runtime: RuntimeStorage,
  storage: StorageAdapter,
  chunkMetadata: readonly ChunkMetadata[],
  description?: string
): Parameters<typeof sealCapsuleCore>[0] {
  return {
    capsuleId: CAPSULE_ID,
    saltBase: SALT_BASE,
    ...(description !== undefined ? { description } : {}),
    recipientSecret: RECIPIENT_SECRET,
    creatorAuthority: CREATOR_AUTHORITY,
    openAt: Date.now() + 86_400_000,
    uploadToken: UPLOAD_TOKEN,
    canonicalLifecycleId: LIFECYCLE_ID,
    creatorIdentityId: IDENTITY_ID,
    storage,
    encryptedVaultPointer: createLocalVaultPointer(CAPSULE_ID),
    encryptedSizeBytes: VAULT_BYTES.byteLength,
    vaultSha256: VAULT_SHA256,
    runtime,
    chunkMetadata,
  };
}

/** Extract the parsed body of the LAST POST whose URL contains the fragment. */
function lastBodyFor(
  calls: CapturedCall[],
  urlFragment: string
): Record<string, unknown> | undefined {
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i];
    if (call && call.url.includes(urlFragment)) {
      return call.body;
    }
  }
  return undefined;
}

/** The manifest carried by the LAST POST to `urlFragment`. */
function lastManifestFor(
  calls: CapturedCall[],
  urlFragment: string
): Record<string, unknown> | undefined {
  return lastBodyFor(calls, urlFragment)?.["manifest"] as
    | Record<string, unknown>
    | undefined;
}

describe("sealCapsuleCore — capsule description on the seal wire", () => {
  let restoreFetch: (() => void) | undefined;

  beforeEach(() => {
    try {
      sessionStorage.clear();
    } catch {
      // sessionStorage may be absent in node env; the flow tolerates it.
    }
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
  });

  it("A. non-empty description → POSTed manifest CONTAINS description verbatim", async () => {
    const router = installFetchRouter(OK_HANDLERS);
    restoreFetch = router.restore;

    const DESCRIPTION = "A sealed letter to my future self.";

    const result = await sealCapsuleCore(
      baseParams(buildRuntime(), buildStorage(), [], DESCRIPTION)
    );

    expect(result.finalized).toBe(true);

    const sealBody = lastBodyFor(router.calls, "/api/capsule/seal");
    // NON-VACUOUS: prove we captured the real seal payload.
    expect(sealBody).toBeDefined();
    expect(sealBody?.["uploadToken"]).toBe(UPLOAD_TOKEN);

    const manifest = lastManifestFor(router.calls, "/api/capsule/seal");
    expect(manifest).toBeDefined();
    expect(manifest?.["description"]).toBe(DESCRIPTION);
  });

  it("B. no description → POSTed manifest has NO description key (not '')", async () => {
    const router = installFetchRouter(OK_HANDLERS);
    restoreFetch = router.restore;

    const result = await sealCapsuleCore(
      baseParams(buildRuntime(), buildStorage(), [])
    );

    expect(result.finalized).toBe(true);

    const manifest = lastManifestFor(router.calls, "/api/capsule/seal");
    expect(manifest).toBeDefined();

    expect(Object.prototype.hasOwnProperty.call(manifest, "description")).toBe(
      false
    );
  });

  it("C. empty-string description → treated as absent (NO description key)", async () => {
    const router = installFetchRouter(OK_HANDLERS);
    restoreFetch = router.restore;

    const result = await sealCapsuleCore(
      baseParams(buildRuntime(), buildStorage(), [], "")
    );

    expect(result.finalized).toBe(true);

    const manifest = lastManifestFor(router.calls, "/api/capsule/seal");
    expect(manifest).toBeDefined();

    expect(Object.prototype.hasOwnProperty.call(manifest, "description")).toBe(
      false
    );
  });

  it("D. length contract: a UI-max (140) description is carried verbatim", async () => {
    const router = installFetchRouter(OK_HANDLERS);
    restoreFetch = router.restore;

    const DESCRIPTION = "x".repeat(UI_MAX_DESCRIPTION);
    expect(DESCRIPTION.length).toBe(140);

    const result = await sealCapsuleCore(
      baseParams(buildRuntime(), buildStorage(), [], DESCRIPTION)
    );

    expect(result.finalized).toBe(true);

    const manifest = lastManifestFor(router.calls, "/api/capsule/seal");
    expect(manifest?.["description"]).toBe(DESCRIPTION);

    const described = manifest?.["description"];
    expect(typeof described).toBe("string");
    expect((described as string).length).toBeLessThanOrEqual(
      SERVER_MAX_DESCRIPTION
    );
  });

  it("E. identity parity: seal payload and seal/verify payload carry the SAME description", async () => {
    const router = installFetchRouter(OK_HANDLERS);
    restoreFetch = router.restore;

    const DESCRIPTION = "Boundary description within 140 chars.";

    const result = await sealCapsuleCore(
      baseParams(buildRuntime(), buildStorage(), [], DESCRIPTION)
    );

    expect(result.finalized).toBe(true);

    const sealManifest = lastManifestFor(router.calls, "/api/capsule/seal");
    const verifyManifest = lastManifestFor(router.calls, "/api/seal/verify");

    expect(sealManifest).toBeDefined();
    expect(verifyManifest).toBeDefined();

    // The seal core must feed the IDENTICAL description to both endpoints;
    // a divergence here would re-open the 409 MANIFEST_MISMATCH class of bug.
    expect(sealManifest?.["description"]).toBe(DESCRIPTION);
    expect(verifyManifest?.["description"]).toBe(DESCRIPTION);

    // And the two manifests must be structurally identical (all keys).
    expect(Object.keys(verifyManifest ?? {}).sort()).toEqual(
      Object.keys(sealManifest ?? {}).sort()
    );
    expect(verifyManifest).toEqual(sealManifest);
  });
});
