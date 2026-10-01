/**
 * =========================================================
 * executorStorage — bounded range read (Stage 1)
 * =========================================================
 *
 * Unit tests for the `downloadRange(pointer, offset, length)`
 * transport primitive.
 *
 * Scope: validation, the Range header it issues, and every
 * fail-closed path. `fetch` is stubbed — no network.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";

import type { StoragePointer } from "@/lib/storage/storageAdapter";
import {
  executorStorage,
  assertRangeWindow,
} from "@/lib/storage/executorStorage";

const POINTER =
  "EFnj5s3hmYqXmoxVEQetK1vBrCpffsVu7nGWtEsstmPo" as StoragePointer;

const JSON_HEADERS = { "content-type": "application/octet-stream" };

function makeResponse(
  status: number,
  body: Uint8Array,
  headers: Record<string, string> = JSON_HEADERS
): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name: string) => {
        const key = name.toLowerCase();
        return key in headers ? headers[key] : null;
      },
    },
    arrayBuffer: async () => body.slice().buffer,
  } as unknown as Response;
}

/** Deterministic byte pattern so equality is meaningful. */
function pattern(length: number, seed = 0): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i + seed) & 0xff;
  return out;
}

let fetchMock: ReturnType<typeof vi.fn>;

function firstCall(): [string, RequestInit] {
  const call = fetchMock.mock.calls[0] as [string, RequestInit] | undefined;
  if (!call) throw new Error("fetch was not called");
  return call;
}

function firstHeaders(): Record<string, string> {
  return (firstCall()[1].headers ?? {}) as Record<string, string>;
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ *
 * assertRangeWindow — the validation boundary
 * ------------------------------------------------------------------ */

describe("assertRangeWindow", () => {
  it("returns the inclusive end offset", () => {
    expect(assertRangeWindow(0, 1)).toEqual({ offset: 0, length: 1, end: 0 });
    expect(assertRangeWindow(100, 50)).toEqual({
      offset: 100,
      length: 50,
      end: 149,
    });
  });

  it("rejects a negative offset", () => {
    expect(() => assertRangeWindow(-1, 10)).toThrow(
      "[AETERNA] Invalid range offset"
    );
  });

  it("rejects a non-integer offset", () => {
    expect(() => assertRangeWindow(1.5, 10)).toThrow(
      "[AETERNA] Invalid range offset"
    );
  });

  it("rejects a non-number offset", () => {
    expect(() => assertRangeWindow("0" as unknown, 10)).toThrow(
      "[AETERNA] Invalid range offset"
    );
  });

  it("rejects an unsafe integer offset", () => {
    expect(() => assertRangeWindow(Number.MAX_SAFE_INTEGER + 2, 1)).toThrow(
      "[AETERNA] Invalid range offset"
    );
  });

  it("rejects a zero length", () => {
    expect(() => assertRangeWindow(0, 0)).toThrow(
      "[AETERNA] Invalid range length"
    );
  });

  it("rejects a negative length", () => {
    expect(() => assertRangeWindow(0, -5)).toThrow(
      "[AETERNA] Invalid range length"
    );
  });

  it("rejects a non-integer length", () => {
    expect(() => assertRangeWindow(0, 2.5)).toThrow(
      "[AETERNA] Invalid range length"
    );
  });

  it("rejects a non-number length", () => {
    expect(() => assertRangeWindow(0, null as unknown)).toThrow(
      "[AETERNA] Invalid range length"
    );
  });

  it("rejects arithmetic that leaves the safe-integer domain", () => {
    expect(() => assertRangeWindow(Number.MAX_SAFE_INTEGER, 2)).toThrow(
      "[AETERNA] Range arithmetic overflow"
    );
  });

  it("rejects a window silently narrowed by IEEE-754 rounding", () => {
    // 2^53-1 + 2 - 1 rounds back to 2^53-1, so the span would be
    // 1 byte instead of the requested 2 — accepted by a naive
    // safe-integer check, rejected by the round-trip assertion.
    expect(() => assertRangeWindow(Number.MAX_SAFE_INTEGER, 2)).toThrow(
      "[AETERNA] Range arithmetic overflow"
    );

    // The same offset with a length that DOES round-trip is fine.
    expect(assertRangeWindow(Number.MAX_SAFE_INTEGER, 1).end).toBe(
      Number.MAX_SAFE_INTEGER
    );
  });

  it("accepts the largest representable single-byte window", () => {
    expect(assertRangeWindow(Number.MAX_SAFE_INTEGER - 1, 1).end).toBe(
      Number.MAX_SAFE_INTEGER - 1
    );
  });
});

/* ------------------------------------------------------------------ *
 * downloadRange — happy paths
 * ------------------------------------------------------------------ */

describe("executorStorage.downloadRange — success", () => {
  it("returns exactly the requested bytes for a valid 206", async () => {
    const body = pattern(4);
    fetchMock.mockResolvedValue(makeResponse(206, body));

    const out = await executorStorage.downloadRange(POINTER, 0, 4);

    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.byteLength).toBe(4);
    expect(Array.from(out)).toEqual(Array.from(body));
  });

  it("supports an exact single-byte range", async () => {
    fetchMock.mockResolvedValue(makeResponse(206, pattern(1, 7)));

    const out = await executorStorage.downloadRange(POINTER, 0, 1);

    expect(out.byteLength).toBe(1);
  });

  it("issues the correct Range header for a middle range", async () => {
    fetchMock.mockResolvedValue(makeResponse(206, pattern(1024)));

    await executorStorage.downloadRange(POINTER, 1_000_000, 1024);

    expect(firstHeaders()["Range"]).toBe("bytes=1000000-1001023");
  });

  it("issues the correct Range header for a tail range", async () => {
    fetchMock.mockResolvedValue(makeResponse(206, pattern(512)));

    await executorStorage.downloadRange(POINTER, 4096, 512);

    expect(firstHeaders()["Range"]).toBe("bytes=4096-4607");
  });

  it("targets the /tx/<id>/data range endpoint", async () => {
    fetchMock.mockResolvedValue(makeResponse(206, pattern(8)));

    await executorStorage.downloadRange(POINTER, 0, 8);

    expect(firstCall()[0]).toBe(
      `https://gateway.irys.xyz/tx/${POINTER}/data`
    );
  });

  it("accepts a 206 whose Content-Range is unreadable (null)", async () => {
    // Stage 0 proved the Irys gateway/CDN path returns no readable
    // Content-Range even on a correct 206, so it must not be a gate.
    fetchMock.mockResolvedValue(makeResponse(206, pattern(16)));

    const out = await executorStorage.downloadRange(POINTER, 0, 16);

    expect(out.byteLength).toBe(16);
  });
});

/* ------------------------------------------------------------------ *
 * downloadRange — fail-closed paths
 * ------------------------------------------------------------------ */

describe("executorStorage.downloadRange — fail closed", () => {
  it("rejects a 200 full-object response", async () => {
    fetchMock.mockResolvedValue(makeResponse(200, pattern(64)));

    await expect(
      executorStorage.downloadRange(POINTER, 0, 64)
    ).rejects.toThrow("[AETERNA] Range read failed");
  });

  it("rejects a 416 (unsatisfiable range)", async () => {
    fetchMock.mockResolvedValue(makeResponse(416, new Uint8Array(13)));

    await expect(
      executorStorage.downloadRange(POINTER, 999_999_999, 100)
    ).rejects.toThrow("[AETERNA] Range read failed");
  });

  it("rejects a 4xx", async () => {
    fetchMock.mockResolvedValue(makeResponse(404, new Uint8Array(0)));

    await expect(
      executorStorage.downloadRange(POINTER, 0, 10)
    ).rejects.toThrow("[AETERNA] Range read failed");
  });

  it("rejects a 5xx", async () => {
    fetchMock.mockResolvedValue(makeResponse(503, new Uint8Array(0)));

    await expect(
      executorStorage.downloadRange(POINTER, 0, 10)
    ).rejects.toThrow("[AETERNA] Range read failed");
  });

  it("rejects a SHORT body on an otherwise valid 206", async () => {
    fetchMock.mockResolvedValue(makeResponse(206, pattern(100)));

    await expect(
      executorStorage.downloadRange(POINTER, 0, 1024)
    ).rejects.toThrow("[AETERNA] Range read failed");
  });

  it("rejects a LONG body on an otherwise valid 206", async () => {
    fetchMock.mockResolvedValue(makeResponse(206, pattern(2048)));

    await expect(
      executorStorage.downloadRange(POINTER, 0, 1024)
    ).rejects.toThrow("[AETERNA] Range read failed");
  });

  it("rejects an HTML error page served with 206", async () => {
    fetchMock.mockResolvedValue(
      makeResponse(206, pattern(16), { "content-type": "text/html" })
    );

    await expect(
      executorStorage.downloadRange(POINTER, 0, 16)
    ).rejects.toThrow("[AETERNA] Range read failed");
  });

  it("rejects a network error", async () => {
    fetchMock.mockRejectedValue(new Error("socket hang up"));

    await expect(
      executorStorage.downloadRange(POINTER, 0, 16)
    ).rejects.toThrow("[AETERNA] Range read failed");
  });

  it("rejects an invalid pointer without issuing any request", async () => {
    await expect(
      executorStorage.downloadRange("too-short" as StoragePointer, 0, 10)
    ).rejects.toThrow("[AETERNA] Invalid storage pointer");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a negative offset without issuing any request", async () => {
    await expect(
      executorStorage.downloadRange(POINTER, -1, 10)
    ).rejects.toThrow("[AETERNA] Invalid range offset");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a zero length without issuing any request", async () => {
    await expect(
      executorStorage.downloadRange(POINTER, 0, 0)
    ).rejects.toThrow("[AETERNA] Invalid range length");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unsafe offset arithmetic without issuing any request", async () => {
    await expect(
      executorStorage.downloadRange(POINTER, Number.MAX_SAFE_INTEGER, 2)
    ).rejects.toThrow("[AETERNA] Range arithmetic overflow");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never returns a full-object body in place of a window", async () => {
    // Every gateway answers 200 with the whole object. The primitive
    // must fail closed rather than hand back the full payload.
    fetchMock.mockResolvedValue(makeResponse(200, pattern(4096)));

    await expect(
      executorStorage.downloadRange(POINTER, 0, 32)
    ).rejects.toThrow("[AETERNA] Range read failed");
  });
});
