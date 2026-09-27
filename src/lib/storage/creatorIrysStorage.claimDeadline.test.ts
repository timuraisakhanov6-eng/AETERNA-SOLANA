/**
 * AETERNA — operation-level deadline for `POST /api/publication/claim`.
 *
 * TASK J3 (P1): the claim request is a discrete same-origin Function call
 * whose own outbound Irys-node confirmation is already internally bounded.
 * These tests prove the CLIENT-side deadline converts a genuinely
 * non-settling claim into a rejection (so the chunk/vault upload path fails
 * closed instead of hanging), while a healthy claim still resolves normally.
 *
 * The Irys SDK upload is mocked away (`uploadCreatorData`) so the test
 * exercises ONLY the claim boundary — no Irys, no wallet, no network.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  uploadCreatorData: vi.fn(async () => ({ dataTxId: "tx".padEnd(43, "Z") })),
}));

vi.mock("@/lib/storage/creatorIrys", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/storage/creatorIrys")>();
  return {
    ...actual,
    uploadCreatorData: hoisted.uploadCreatorData,
  };
});

import { createCreatorIrysStorage } from "./creatorIrysStorage";

const CLAIM_REQUEST_TIMEOUT_MS = 15_000;

function makeCtx() {
  return {
    wallet: {
      publicKey: {},
      signMessage: async () => new Uint8Array([1]),
    },
    creatorIdentityId: "creator-1",
    lifecycleId: "lifecycle-1",
    capsuleId: "a".repeat(64),
    storagePaymentId: "storage-payment-1",
  };
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

/** fetch double that honours `init.signal` for a hanging claim request. */
function installClaimFetch(
  behavior: "ok" | "hang" | "http500"
): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push(url);

    if (behavior === "ok") {
      return Promise.resolve(jsonResponse(200, { ok: true, claimed: true }));
    }

    if (behavior === "http500") {
      return Promise.resolve(jsonResponse(500, { error: "UPSTREAM" }));
    }

    // hang: never settles unless aborted.
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal ?? undefined;
      if (signal?.aborted) {
        reject(
          Object.assign(new Error("The operation was aborted."), {
            name: "AbortError",
          })
        );
        return;
      }
      signal?.addEventListener(
        "abort",
        () =>
          reject(
            Object.assign(new Error("The operation was aborted."), {
              name: "AbortError",
            })
          ),
        { once: true }
      );
    });
  }) as unknown as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe("creatorIrysStorage — claim request deadline", () => {
  let restoreFetch: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    hoisted.uploadCreatorData.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreFetch?.();
    restoreFetch = undefined;
  });

  it("NORMAL: a healthy claim resolves and the adapter returns the pointer", async () => {
    const router = installClaimFetch("ok");
    restoreFetch = router.restore;

    const storage = createCreatorIrysStorage(makeCtx());
    const result = await storage.uploadChunk(
      new Uint8Array([1, 2, 3]),
      "chunk-1" as never,
      "token" as never
    );

    expect(result.txId).toBe("tx".padEnd(43, "Z"));
    expect(router.calls.some((u) => u.includes("/api/publication/claim"))).toBe(
      true
    );
  });

  it("TIMEOUT: a never-settling claim rejects via the deadline", async () => {
    const router = installClaimFetch("hang");
    restoreFetch = router.restore;

    const storage = createCreatorIrysStorage(makeCtx());
    const promise = storage.uploadChunk(
      new Uint8Array([1, 2, 3]),
      "chunk-1" as never,
      "token" as never
    );

    const assertion = expect(promise).rejects.toThrow();

    await vi.advanceTimersByTimeAsync(CLAIM_REQUEST_TIMEOUT_MS + 1_000);

    await assertion;
  });

  it("MUTATION: without the deadline the never-settling claim stays pending", async () => {
    const router = installClaimFetch("hang");
    restoreFetch = router.restore;

    const storage = createCreatorIrysStorage(makeCtx());
    const promise = storage.uploadChunk(
      new Uint8Array([1, 2, 3]),
      "chunk-1" as never,
      "token" as never
    );

    let settled: "resolved" | "rejected" | "pending" = "pending";
    promise.then(
      () => {
        settled = "resolved";
      },
      () => {
        settled = "rejected";
      }
    );

    // If the AbortController deadline is removed, the claim never settles and
    // `settled` stays "pending" — the paired TIMEOUT test above then hangs.
    await vi.advanceTimersByTimeAsync(CLAIM_REQUEST_TIMEOUT_MS * 4);

    expect(settled).toBe("rejected");
  });

  it("HTTP ERROR: a 500 claim still rejects with the existing claim error (parsing preserved)", async () => {
    const router = installClaimFetch("http500");
    restoreFetch = router.restore;

    const storage = createCreatorIrysStorage(makeCtx());

    await expect(
      storage.uploadChunk(
        new Uint8Array([1, 2, 3]),
        "chunk-1" as never,
        "token" as never
      )
    ).rejects.toThrow(/publication claim failed/);
  });
});
