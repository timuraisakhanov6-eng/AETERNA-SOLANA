/**
 * =========================================================
 * Phase F2.2 — the rejected HTTP STATUS survives the REAL range path
 * =========================================================
 *
 * Phase F2.1 proved (from source) that `PREVIEW_RANGE_STATUS_REJECTED`
 * means a gateway answered with a status OTHER than 206 — but it could
 * NOT say WHICH status. This suite drives the REAL layers —
 *
 *   storage.downloadRange
 *     → executorStorage.downloadRange  (real Range/status/length logic)
 *       → fetch (stubbed)
 *
 * — and asserts that the NUMERIC statuses of responses rejected by the
 * status gate are captured per attempt and preserved (unique, sorted)
 * through the façade, with the public message unchanged.
 *
 * Only `fetch` is stubbed; every status/content-type/Content-Range/
 * length gate, the gateway order, the deadline and the classification
 * are the REAL production code.
 *
 * NOTE ON FIDELITY: this proves the CAPTURE and PROPAGATION, not the
 * physical device. It cannot prove which status an iPhone actually
 * received; it only proves that, given a response, the right status is
 * reported. The real iPhone status remains UNKNOWN until tested.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { StoragePointer } from "@/lib/storage/storageAdapter";
import { downloadRange } from "@/lib/storage/storage";
import { executorStorage } from "@/lib/storage/executorStorage";
import {
  StorageRangeError,
  isStorageRangeError,
  STORAGE_FAILURE_MESSAGE,
  normalizeRangeStatuses,
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

describe("Phase F2.2 — the rejected status is captured numerically", () => {
  it.each([
    [200, [200]],
    [403, [403]],
    [404, [404]],
    [416, [416]],
    [500, [500]],
    [503, [503]],
  ] as ReadonlyArray<[number, number[]]>)(
    "every gateway answers HTTP %i → statuses = %j",
    async (status, expected) => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(response({ status, bodyLength: 0 })),
      );

      const err = await catchError(() => downloadRange(POINTER, 64, 1024));

      expect(isStorageRangeError(err)).toBe(true);
      const e = err as StorageRangeError;
      expect(e.code).toBe("range-rejected");
      expect(e.reasons).toEqual(["status-not-206"]);
      expect(e.statuses).toEqual(expected);
      // Public façade contract unchanged.
      expect(e.message).toBe(STORAGE_FAILURE_MESSAGE);
    },
  );
});

describe("Phase F2.2 — mixed statuses across gateways", () => {
  it("gateway #1 = 200, gateway #2 = 403 → unique, ASCENDING [200, 403]", async () => {
    let call = 0;
    fetchMock.mockImplementation(() => {
      call += 1;
      return Promise.resolve(
        response({ status: call === 1 ? 200 : 403, bodyLength: 0 }),
      );
    });

    const err = await catchError(() => downloadRange(POINTER, 64, 1024));
    const e = err as StorageRangeError;

    expect(e.code).toBe("range-rejected");
    expect(e.reasons).toEqual(["status-not-206"]);
    // Both distinct statuses preserved, in ascending order — not an
    // arbitrary "last seen" status.
    expect(e.statuses).toEqual([200, 403]);
  });

  it("the same status from every gateway collapses to a unique set", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(response({ status: 500, bodyLength: 0 })),
    );

    const err = await catchError(() => downloadRange(POINTER, 64, 1024));
    const e = err as StorageRangeError;

    expect(e.statuses).toEqual([500]);
  });
});

describe("Phase F2.2 — accepted paths and rejection behaviour are UNCHANGED", () => {
  it("one gateway rejects (500) then a LATER gateway succeeds → read SUCCEEDS", async () => {
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

  it("a healthy 206 still short-circuits the loop", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(response({ status: 206, bodyLength: 1024 })),
    );

    const bytes = await downloadRange(POINTER, 64, 1024);
    expect(bytes.byteLength).toBe(1024);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a 206 with a WRONG body length is a body rejection, NOT a status one", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(response({ status: 206, bodyLength: 512 })),
    );

    const err = await catchError(() => downloadRange(POINTER, 64, 1024));
    const e = err as StorageRangeError;

    expect(e.reasons).toEqual(["body-short"]);
    // No status was rejected → the status set stays empty.
    expect(e.statuses).toEqual([]);
  });
});

describe("Phase F2.2 — facade contract + safety of the status set", () => {
  it("the façade retains the public [AETERNA] Storage failure message", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(response({ status: 403, bodyLength: 0 })),
    );

    const err = await catchError(() => downloadRange(POINTER, 64, 1024));
    const e = err as StorageRangeError;

    expect(e.message).toBe(STORAGE_FAILURE_MESSAGE);
    expect(e.message).not.toContain("Range read");
    // ...while the numeric status survives the façade.
    expect(e.statuses).toEqual([403]);
  });

  it("non-rejected codes carry an EMPTY status set", async () => {
    fetchMock.mockImplementation(() =>
      Promise.reject(new TypeError("Failed to fetch")),
    );

    const err = await catchError(() => downloadRange(POINTER, 64, 1024));
    const e = err as StorageRangeError;

    expect(e.code).toBe("range-network");
    expect(e.statuses).toEqual([]);
  });

  it("the typed error's rendered surface carries no pointer/URL/hex", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(response({ status: 403, bodyLength: 0 })),
    );

    const err = await catchError(() => downloadRange(POINTER, 64, 1024));
    const e = err as StorageRangeError;

    expect(e.message).not.toContain(POINTER);
    expect(e.message).not.toMatch(/https?:|blob:|[0-9a-f]{20,}/i);
    // Statuses are plain integers only.
    for (const s of e.statuses) {
      expect(Number.isInteger(s)).toBe(true);
    }
  });

  it("the adapter itself throws the typed statuses (façade only re-throws)", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(response({ status: 416, bodyLength: 0 })),
    );

    const err = await catchError(() =>
      executorStorage.downloadRange(POINTER, 64, 1024),
    );
    const e = err as StorageRangeError;

    expect(isStorageRangeError(e)).toBe(true);
    expect(e.statuses).toEqual([416]);
  });
});

describe("Phase F2.2 — normalizeRangeStatuses contract", () => {
  it("dedupes, sorts ascending and drops non-HTTP values", () => {
    expect(
      normalizeRangeStatuses([503, 200, 200, 403, 0, 1000, 3.5, -1, 99, 600]),
    ).toEqual([200, 403, 503]);
  });

  it("keeps the inclusive 100..599 HTTP bounds", () => {
    expect(normalizeRangeStatuses([100, 599])).toEqual([100, 599]);
  });

  it("an empty input yields an empty set", () => {
    expect(normalizeRangeStatuses([])).toEqual([]);
  });
});
