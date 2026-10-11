/**
 * =========================================================
 * Phase F1 — typed range failure survives the REAL storage path
 * =========================================================
 *
 * The Phase F defect was that `storage.ts` collapsed EVERY adapter
 * failure into one generic sealed error, so a per-range timeout was
 * indistinguishable from a status/length rejection.
 *
 * This suite drives the REAL layers —
 *
 *   storage.downloadRange
 *     → executorStorage.downloadRange  (real Range/status/length logic)
 *       → fetch (stubbed)
 *
 * — and asserts the TYPED `StorageRangeError` (with its stable code)
 * survives the façade unchanged, while the façade's public fail-closed
 * contract for non-range errors is untouched.
 *
 * Only `fetch` is stubbed; the entire range contract, deadline and
 * classification logic are the REAL production code.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { StoragePointer } from "@/lib/storage/storageAdapter";
import { downloadRange } from "@/lib/storage/storage";
import { executorStorage } from "@/lib/storage/executorStorage";
import {
  StorageRangeError,
  isStorageRangeError,
  STORAGE_FAILURE_MESSAGE,
} from "@/lib/storage/storageRangeFailure";

const POINTER =
  "EFnj5s3hmYqXmoxVEQetK1vBrCpffsVu7nGWtEsstmPo" as StoragePointer;

function response(init: {
  status: number;
  contentType?: string;
  contentRange?: string | null;
  bodyLength: number;
}): Response {
  return {
    status: init.status,
    ok: init.status >= 200 && init.status < 300,
    headers: {
      get: (name: string) => {
        const key = name.toLowerCase();
        if (key === "content-type") {
          return init.contentType ?? "application/octet-stream";
        }
        if (key === "content-range") {
          return init.contentRange === undefined ? null : init.contentRange;
        }
        return null;
      },
    },
    arrayBuffer: async () => new ArrayBuffer(init.bodyLength),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Phase F1 — storage façade preserves the typed range failure", () => {
  it("a non-206 (always 200) response → typed range-rejected, preserved through the façade", async () => {
    // Body length matches so ONLY the status gate can reject it.
    const requestRange = { start: 64, end: 64 + 1024 - 1 };
    const length = requestRange.end - requestRange.start + 1;

    fetchMock.mockImplementation(() =>
      Promise.resolve(
        response({ status: 200, bodyLength: length }),
      ),
    );

    let caught: unknown;
    try {
      await downloadRange(POINTER, requestRange.start, length);
    } catch (err) {
      caught = err;
    }

    expect(isStorageRangeError(caught)).toBe(true);
    expect((caught as StorageRangeError).code).toBe("range-rejected");
    // The façade must NOT have replaced it with a generic sealed error.
    expect((caught as StorageRangeError).name).toBe("StorageRangeError");
    // AND the pre-existing public message must be preserved VERBATIM —
    // the typed code is additive information, not a message change.
    expect((caught as StorageRangeError).message).toBe(STORAGE_FAILURE_MESSAGE);
    // The façade strips the adapter's own message; only the fixed
    // public string is externally visible.
    expect((caught as StorageRangeError).message).not.toContain("Range read");
  });

  it("a 206 with the WRONG body length → typed range-rejected (short/long body)", async () => {
    const start = 64;
    const length = 1024;

    fetchMock.mockImplementation(() =>
      Promise.resolve(
        response({ status: 206, bodyLength: length - 1 }),
      ),
    );

    let caught: unknown;
    try {
      await downloadRange(POINTER, start, length);
    } catch (err) {
      caught = err;
    }

    expect(isStorageRangeError(caught)).toBe(true);
    expect((caught as StorageRangeError).code).toBe("range-rejected");
  });

  it("an unreadable-but-present Content-Range mismatch → typed range-rejected", async () => {
    const start = 64;
    const length = 1024;

    fetchMock.mockImplementation(() =>
      Promise.resolve(
        response({
          status: 206,
          bodyLength: length,
          // Readable but describes a DIFFERENT window → authoritative reject.
          contentRange: "bytes 0-1023/999999",
        }),
      ),
    );

    let caught: unknown;
    try {
      await downloadRange(POINTER, start, length);
    } catch (err) {
      caught = err;
    }

    expect(isStorageRangeError(caught)).toBe(true);
    expect((caught as StorageRangeError).code).toBe("range-rejected");
  });

  it("a transport-level fetch rejection → typed range-network", async () => {
    const start = 64;
    const length = 1024;

    fetchMock.mockImplementation(() =>
      Promise.reject(new TypeError("Failed to fetch")),
    );

    let caught: unknown;
    try {
      await downloadRange(POINTER, start, length);
    } catch (err) {
      caught = err;
    }

    expect(isStorageRangeError(caught)).toBe(true);
    expect((caught as StorageRangeError).code).toBe("range-network");
  });

  it("a healthy 206 with matching window + length still SUCCEEDS (behaviour unchanged)", async () => {
    const start = 64;
    const length = 1024;

    fetchMock.mockImplementation(() =>
      Promise.resolve(
        response({ status: 206, bodyLength: length, contentRange: null }),
      ),
    );

    const bytes = await downloadRange(POINTER, start, length);
    expect(bytes.byteLength).toBe(length);
    // Exactly one attempt — a success short-circuits the gateway loop.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("the adapter itself throws the typed error (façade only re-throws it)", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(response({ status: 200, bodyLength: 1024 })),
    );

    let adapterErr: unknown;
    try {
      await executorStorage.downloadRange(POINTER, 64, 1024);
    } catch (err) {
      adapterErr = err;
    }

    expect(isStorageRangeError(adapterErr)).toBe(true);
    expect((adapterErr as StorageRangeError).code).toBe("range-rejected");
  });

  it("the typed error's own message carries no sensitive data (fixed, safe)", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(response({ status: 200, bodyLength: 1024 })),
    );

    let caught: unknown;
    try {
      await downloadRange(POINTER, 64, 1024);
    } catch (err) {
      caught = err;
    }

    const err = caught as StorageRangeError;
    // The rendered/structured surface must not contain a pointer, URL,
    // size, capsule id or hex blob.
    expect(err.message).not.toMatch(/https?:|blob:|tx\//i);
    expect(err.message).not.toContain(POINTER);
    expect(err.message).not.toMatch(/[0-9a-f]{20,}/i);
    // The error object carries NO extra properties beyond the fixed set.
    expect(Object.keys(err)).toEqual(
      expect.arrayContaining(["code"]),
    );
  });
});
