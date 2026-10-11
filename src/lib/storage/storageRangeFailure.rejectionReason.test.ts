/**
 * =========================================================
 * Phase F2.1 — the EXACT range-rejection reason survives the REAL path
 * =========================================================
 *
 * Phase F2 proved (from source) that `PREVIEW_RANGE_FAILED` means the
 * range reader exhausted every gateway without an accepted response,
 * but could NOT say WHICH rejection branch fired. This suite drives the
 * REAL layers —
 *
 *   storage.downloadRange
 *     → executorStorage.downloadRange  (real Range/status/length logic)
 *       → fetch (stubbed)
 *
 * — and asserts that the typed `StorageRangeError.reasons` set is
 * captured per rejection branch and preserved through the façade, with
 * the public message unchanged.
 *
 * Only `fetch` is stubbed; every status/content-type/Content-Range/
 * length gate, the gateway order, the deadline and the classification
 * are the REAL production code.
 *
 * NOTE ON FIDELITY: this proves the CLASSIFICATION, not the physical
 * device. It cannot prove which response an iPhone actually received;
 * it only proves that, given a response, the right reason is reported.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { StoragePointer } from "@/lib/storage/storageAdapter";
import { downloadRange } from "@/lib/storage/storage";
import { executorStorage } from "@/lib/storage/executorStorage";
import {
  StorageRangeError,
  isStorageRangeError,
  STORAGE_FAILURE_MESSAGE,
  normalizeRejectionReasons,
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

async function catchError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return err;
  }
}

describe("Phase F2.1 — each rejection branch is captured as its own reason", () => {
  it("non-206 from every gateway → reasons = [status-not-206]", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(response({ status: 200, bodyLength: 1024 })),
    );

    const err = await catchError(() =>
      downloadRange(POINTER, 64, 1024),
    );

    expect(isStorageRangeError(err)).toBe(true);
    const e = err as StorageRangeError;
    expect(e.code).toBe("range-rejected");
    expect(e.reasons).toEqual(["status-not-206"]);
    // Public façade contract unchanged.
    expect(e.message).toBe(STORAGE_FAILURE_MESSAGE);
  });

  it("a 206 text/html page from every gateway → reasons = [html-response]", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        response({
          status: 206,
          contentType: "text/html; charset=utf-8",
          bodyLength: 1024,
        }),
      ),
    );

    const err = await catchError(() => downloadRange(POINTER, 64, 1024));
    const e = err as StorageRangeError;

    expect(e.code).toBe("range-rejected");
    expect(e.reasons).toEqual(["html-response"]);
  });

  it("a 206 with a MISMATCHED readable Content-Range → [content-range-mismatch]", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        response({
          status: 206,
          contentRange: "bytes 0-1023/999999",
          bodyLength: 1024,
        }),
      ),
    );

    const err = await catchError(() => downloadRange(POINTER, 64, 1024));
    const e = err as StorageRangeError;

    expect(e.code).toBe("range-rejected");
    expect(e.reasons).toEqual(["content-range-mismatch"]);
  });

  it("a 206 with a MALFORMED readable Content-Range → [content-range-mismatch]", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        response({
          status: 206,
          contentRange: "not-a-content-range",
          bodyLength: 1024,
        }),
      ),
    );

    const err = await catchError(() => downloadRange(POINTER, 64, 1024));
    const e = err as StorageRangeError;

    expect(e.reasons).toEqual(["content-range-mismatch"]);
  });

  it("a SHORT 206 body from every gateway → reasons = [body-short]", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(response({ status: 206, bodyLength: 512 })),
    );

    const err = await catchError(() => downloadRange(POINTER, 64, 1024));
    const e = err as StorageRangeError;

    expect(e.code).toBe("range-rejected");
    expect(e.reasons).toEqual(["body-short"]);
  });

  it("a LONG 206 body from every gateway → reasons = [body-long]", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(response({ status: 206, bodyLength: 4096 })),
    );

    const err = await catchError(() => downloadRange(POINTER, 64, 1024));
    const e = err as StorageRangeError;

    expect(e.code).toBe("range-rejected");
    expect(e.reasons).toEqual(["body-long"]);
  });
});

describe("Phase F2.1 — ordering and mixed reasons", () => {
  it("a non-206 HTML response is reported as status-not-206, NOT html-response", async () => {
    // The status gate runs FIRST, so the HTML guard is never reached.
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        response({ status: 404, contentType: "text/html", bodyLength: 0 }),
      ),
    );

    const err = await catchError(() => downloadRange(POINTER, 64, 1024));
    const e = err as StorageRangeError;

    expect(e.reasons).toEqual(["status-not-206"]);
    expect(e.reasons).not.toContain("html-response");
  });

  it("two gateways with DIFFERENT reasons → the safe SET is preserved in canonical order", async () => {
    // gateway #1: non-206; gateway #2: short body.
    let call = 0;
    fetchMock.mockImplementation(() => {
      call += 1;
      return Promise.resolve(
        call === 1
          ? response({ status: 500, bodyLength: 0 })
          : response({ status: 206, bodyLength: 10 }),
      );
    });

    const err = await catchError(() => downloadRange(POINTER, 64, 1024));
    const e = err as StorageRangeError;

    expect(e.code).toBe("range-rejected");
    // Both reasons preserved, in the canonical (not arrival) order.
    expect(e.reasons).toEqual(["status-not-206", "body-short"]);
  });

  it("one gateway rejects but a LATER gateway succeeds → read SUCCEEDS", async () => {
    let call = 0;
    fetchMock.mockImplementation(() => {
      call += 1;
      return Promise.resolve(
        call === 1
          ? response({ status: 500, bodyLength: 0 })
          : response({ status: 206, bodyLength: 1024, contentRange: null }),
      );
    });

    const bytes = await downloadRange(POINTER, 64, 1024);

    expect(bytes.byteLength).toBe(1024);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("Phase F2.1 — accepted paths are UNCHANGED", () => {
  it("a missing/unreadable Content-Range (null) is still ACCEPTED", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        response({ status: 206, bodyLength: 1024, contentRange: null }),
      ),
    );

    const bytes = await downloadRange(POINTER, 64, 1024);
    expect(bytes.byteLength).toBe(1024);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a healthy 206 returns the EXACT bytes and short-circuits the loop", async () => {
    const start = 64;
    const length = 1024;

    fetchMock.mockImplementation(() =>
      Promise.resolve(response({ status: 206, bodyLength: length })),
    );

    const bytes = await downloadRange(POINTER, start, length);
    expect(bytes.byteLength).toBe(length);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("Phase F2.1 — safety of the typed reasons", () => {
  it("normalizeRejectionReasons dedupes and fixes canonical order", () => {
    expect(
      normalizeRejectionReasons([
        "body-long",
        "status-not-206",
        "body-long",
        "html-response",
      ]),
    ).toEqual(["status-not-206", "html-response", "body-long"]);
  });

  it("non-rejected codes carry an EMPTY reason set", async () => {
    // A network failure (fetch rejects on every gateway) → range-network,
    // which must never carry rejection reasons.
    fetchMock.mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")));

    const err = await catchError(() => downloadRange(POINTER, 64, 1024));
    const e = err as StorageRangeError;

    expect(e.code).toBe("range-network");
    expect(e.reasons).toEqual([]);
  });

  it("the typed error's rendered surface carries no pointer/URL/hex", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(response({ status: 200, bodyLength: 1024 })),
    );

    const err = await catchError(() => downloadRange(POINTER, 64, 1024));
    const e = err as StorageRangeError;

    expect(e.message).not.toContain(POINTER);
    expect(e.message).not.toMatch(/https?:|blob:|[0-9a-f]{20,}/i);
    // Reasons are fixed enum members only.
    for (const r of e.reasons) {
      expect(r).toMatch(
        /^(status-not-206|html-response|content-range-mismatch|body-short|body-long)$/,
      );
    }
  });

  it("the adapter itself throws the typed reason (façade only re-throws)", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(response({ status: 416, bodyLength: 0 })),
    );

    const err = await catchError(() =>
      executorStorage.downloadRange(POINTER, 64, 1024),
    );
    const e = err as StorageRangeError;

    expect(isStorageRangeError(e)).toBe(true);
    expect(e.reasons).toEqual(["status-not-206"]);
  });
});
