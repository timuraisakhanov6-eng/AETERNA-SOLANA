/**
 * =========================================================
 * executorStorage — range-download deadline policy
 * =========================================================
 *
 * Regression tests for the confirmed Production defect: the range
 * read of a Container V1 chunk (10 MiB, i.e. 10,485,788 encrypted
 * bytes) was bound by the whole-object `GATEWAY_TIMEOUT` (8 s), which
 * aborts a HEALTHY transfer on an ordinary connection and surfaced as
 * "Failed to load preview".
 *
 * What is under test:
 *   • `rangeDownloadDeadlineMs` — the derived, clamped budget;
 *   • ONE budget for the whole operation (headers + redirects + body)
 *     that is never re-granted per gateway attempt;
 *   • unchanged Range / 206 / exact-length semantics;
 *   • bounded failover over the configured endpoints only.
 *
 * `fetch` is stubbed and timers are faked — no network, no real media
 * bytes, no capability secrets.
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
  rangeDownloadDeadlineMs,
  contentRangeMatches,
  assertRangeWindow,
} from "@/lib/storage/executorStorage";

const POINTER =
  "EFnj5s3hmYqXmoxVEQetK1vBrCpffsVu7nGWtEsstmPo" as StoragePointer;

/** The confirmed Container V1 first-chunk window: offset 64. */
const CONTAINER_HEADER_BYTES = 64;
const CHUNK0_RANGE_LENGTH = 10_485_788;

/** The second chunk of the same container (10,485,852..13,613,785). */
const CHUNK1_RANGE_LENGTH = 3_127_934;

/** The old, broken budget this patch replaces. */
const OLD_GATEWAY_TIMEOUT_MS = 8_000;

/** The caller's outer media-read deadline. */
const MEDIA_READ_TIMEOUT_MS = 30_000;

const OCTET_STREAM = { "content-type": "application/octet-stream" };

/** A Response stand-in with a caller-controlled body promise. */
function makeResponse(
  status: number,
  body: () => Promise<ArrayBuffer>,
  headers: Record<string, string> = OCTET_STREAM
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
    arrayBuffer: body,
  } as unknown as Response;
}

function bodyOf(length: number, seed = 3): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i + seed) & 0xff;
  return out;
}

/** A 206 whose body resolves immediately. */
function ok206(length: number, headers?: Record<string, string>): Response {
  const bytes = bodyOf(length);
  return makeResponse(206, async () => bytes.slice().buffer, headers);
}

/** A 206 whose body only settles when the request is aborted. */
function stallingBody(): Response {
  return makeResponse(
    206,
    () =>
      new Promise<ArrayBuffer>((_resolve, reject) => {
        // The real AbortSignal rejects the body read; the stub is
        // wired to the signal by the fetch mock below.
        rejectOnAbort.push(reject);
      })
  );
}

let rejectOnAbort: Array<(reason: unknown) => void> = [];

let fetchMock: ReturnType<typeof vi.fn>;

/**
 * fetch stub that honours the AbortSignal exactly like a real
 * `fetch()`: aborting rejects an in-flight headers OR body read.
 */
function installFetch(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response
): void {
  fetchMock = vi.fn();

  fetchMock.mockImplementation((url: string, init: RequestInit) => {
    const signal = init.signal as AbortSignal | undefined;

    return new Promise<Response>((resolve, reject) => {
      let settled = false;

      const onAbort = () => {
        // Reject a parked body read (if the headers already landed)...
        for (const rejectBody of rejectOnAbort) {
          rejectBody(new DOMException("Aborted", "AbortError"));
        }
        rejectOnAbort = [];

        // ...and a parked headers read.
        if (!settled) {
          settled = true;
          reject(new DOMException("Aborted", "AbortError"));
        }
      };

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      Promise.resolve(handler(url, init)).then(
        (res) => {
          if (settled) return;
          settled = true;
          resolve(res);
        },
        (err) => {
          if (settled) return;
          settled = true;
          reject(err);
        }
      );
    });
  });

  vi.stubGlobal("fetch", fetchMock);
}

beforeEach(() => {
  rejectOnAbort = [];
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function calledUrls(): string[] {
  return fetchMock.mock.calls.map((c) => c[0] as string);
}

/* ------------------------------------------------------------------ *
 * The derived deadline
 * ------------------------------------------------------------------ */

describe("rangeDownloadDeadlineMs — derived, clamped budget", () => {
  it("floors a small window so a tiny read still has a usable budget", () => {
    expect(rangeDownloadDeadlineMs(1)).toBe(5_000);
    expect(rangeDownloadDeadlineMs(64)).toBe(5_000);
  });

  it("EXCEEDS the old broken 8 s budget for a 10 MiB container chunk", () => {
    const d = rangeDownloadDeadlineMs(CHUNK0_RANGE_LENGTH);
    expect(d).toBeGreaterThan(OLD_GATEWAY_TIMEOUT_MS);
  });

  it("covers the measured slow-link requirement (~13.8 s for 10 MiB)", () => {
    expect(rangeDownloadDeadlineMs(CHUNK0_RANGE_LENGTH)).toBeGreaterThan(13_800);
  });

  it("stays strictly below the caller's 30 s media-read deadline", () => {
    expect(rangeDownloadDeadlineMs(CHUNK0_RANGE_LENGTH)).toBeLessThan(
      MEDIA_READ_TIMEOUT_MS
    );
    expect(rangeDownloadDeadlineMs(Number.MAX_SAFE_INTEGER)).toBeLessThan(
      MEDIA_READ_TIMEOUT_MS
    );
  });

  it("caps at the ceiling for an arbitrarily large window", () => {
    expect(rangeDownloadDeadlineMs(256 * 1024 * 1024)).toBe(24_000);
  });

  it("is deterministic", () => {
    expect(rangeDownloadDeadlineMs(CHUNK0_RANGE_LENGTH)).toBe(
      rangeDownloadDeadlineMs(CHUNK0_RANGE_LENGTH)
    );
  });
});

/* ------------------------------------------------------------------ *
 * ADDITIVITY — a multi-chunk plan is read SEQUENTIALLY, so the
 * per-call budgets sum and must still fit the caller's 30 s deadline.
 * ------------------------------------------------------------------ */

describe("rangeDownloadDeadlineMs — multi-chunk additivity", () => {
  it("keeps the SUM of the real two-chunk plan inside the media deadline", () => {
    const sum =
      rangeDownloadDeadlineMs(CHUNK0_RANGE_LENGTH) +
      rangeDownloadDeadlineMs(CHUNK1_RANGE_LENGTH);

    expect(sum).toBeLessThan(MEDIA_READ_TIMEOUT_MS);
  });

  it("leaves headroom for redirects and decryption overheads", () => {
    const sum =
      rangeDownloadDeadlineMs(CHUNK0_RANGE_LENGTH) +
      rangeDownloadDeadlineMs(CHUNK1_RANGE_LENGTH);

    // At least 3 s for 2x redirect + 2x AES-GCM over 13.6 MB.
    expect(MEDIA_READ_TIMEOUT_MS - sum).toBeGreaterThanOrEqual(3_000);
  });

  it("does NOT inflate the small window with a flat floor", () => {
    // chunk1's own need at the floor throughput (5,967 ms) must win
    // over the floor, otherwise the sum overshoots the caller budget.
    expect(rangeDownloadDeadlineMs(CHUNK1_RANGE_LENGTH)).toBe(5_967);
  });

  it("sums to the whole-file transfer time at the floor throughput", () => {
    const sum =
      rangeDownloadDeadlineMs(CHUNK0_RANGE_LENGTH) +
      rangeDownloadDeadlineMs(CHUNK1_RANGE_LENGTH);

    // 13,613,666 encrypted bytes at 512 KiB/s ~= 25.97 s.
    expect(sum).toBe(25_968);
  });
});

/* ------------------------------------------------------------------ *
 * Content-Range policy (measured against Production)
 * ------------------------------------------------------------------ */

describe("contentRangeMatches — null is the only non-gate", () => {
  const window = assertRangeWindow(CONTAINER_HEADER_BYTES, 16);

  it("treats `null` as NOT a gate (header unavailable to the browser)", () => {
    // Production: the Irys CDN 206 does not expose content-range
    // through CORS, so the browser reads null on a CORRECT response.
    expect(contentRangeMatches(null, window)).toBe(true);
  });

  it("REJECTS an empty readable header", () => {
    expect(contentRangeMatches("", window)).toBe(false);
    expect(contentRangeMatches("   ", window)).toBe(false);
  });

  it("REJECTS a malformed readable header", () => {
    expect(contentRangeMatches("garbage", window)).toBe(false);
    expect(contentRangeMatches("chunk 64-79/13613786", window)).toBe(false);
    expect(contentRangeMatches("bytes=64-79", window)).toBe(false);
    expect(contentRangeMatches("bytes 64-79-80/13613786", window)).toBe(false);
    expect(contentRangeMatches("bytes ", window)).toBe(false);
  });

  it("accepts a matching Content-Range (with a numeric total)", () => {
    expect(contentRangeMatches("bytes 64-79/13613786", window)).toBe(true);
  });

  it("accepts a matching Content-Range with an unknown total", () => {
    expect(contentRangeMatches("bytes 64-79/*", window)).toBe(true);
  });

  it("accepts a matching Content-Range without a total", () => {
    expect(contentRangeMatches("bytes 64-79", window)).toBe(true);
  });

  it("accepts a matching Content-Range regardless of casing/padding", () => {
    expect(contentRangeMatches("  BYTES 64-79/13613786  ", window)).toBe(true);
  });

  it("REJECTS a readable Content-Range that disagrees with the window", () => {
    // A full-object range masquerading as partial content.
    expect(contentRangeMatches("bytes 0-13613785/13613786", window)).toBe(
      false
    );
    expect(contentRangeMatches("bytes 64-80/13613786", window)).toBe(false);
    expect(contentRangeMatches("bytes 65-79/13613786", window)).toBe(false);
    expect(contentRangeMatches("bytes 0-15/16", window)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Content-Range enforcement inside downloadRange
 * ------------------------------------------------------------------ */

describe("downloadRange — Content-Range enforcement", () => {
  it("still succeeds when the header is unreadable (Production case)", async () => {
    // `null` = unavailable to the browser (CORS) — must stay compatible.
    installFetch(() => ok206(16));

    const out = await executorStorage.downloadRange(POINTER, 0, 16);

    expect(out.byteLength).toBe(16);
  });

  it("succeeds when a readable header matches", async () => {
    installFetch(() =>
      ok206(16, {
        "content-type": "application/octet-stream",
        "content-range": "bytes 0-15/16",
      })
    );

    const out = await executorStorage.downloadRange(POINTER, 0, 16);

    expect(out.byteLength).toBe(16);
  });

  it("rejects an EMPTY readable header", async () => {
    installFetch(() =>
      ok206(16, {
        "content-type": "application/octet-stream",
        "content-range": "",
      })
    );

    await expect(
      executorStorage.downloadRange(POINTER, 0, 16)
    ).rejects.toThrow("[AETERNA] Range read failed");
  });

  it("rejects a MALFORMED readable header", async () => {
    installFetch(() =>
      ok206(16, {
        "content-type": "application/octet-stream",
        "content-range": "bytes=0-15",
      })
    );

    await expect(
      executorStorage.downloadRange(POINTER, 0, 16)
    ).rejects.toThrow("[AETERNA] Range read failed");
  });

  it("rejects a readable header that disagrees with the request", async () => {
    installFetch(() =>
      ok206(16, {
        "content-type": "application/octet-stream",
        "content-range": "bytes 0-13613785/13613786",
      })
    );

    await expect(
      executorStorage.downloadRange(POINTER, 0, 16)
    ).rejects.toThrow("[AETERNA] Range read failed");
  });

  it("skips the gateway and still succeeds on the next one (same deadline)", async () => {
    installFetch((url) =>
      url.startsWith("https://gateway.irys.xyz/")
        ? ok206(16, {
            "content-type": "application/octet-stream",
            "content-range": "bytes 0-13613785/13613786",
          })
        : ok206(16, {
            "content-type": "application/octet-stream",
            "content-range": "bytes 0-15/16",
          })
    );

    const out = await executorStorage.downloadRange(POINTER, 0, 16);

    expect(out.byteLength).toBe(16);
    // First gateway rejected on Content-Range, second served the read.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/* ------------------------------------------------------------------ *
 * #1 — a slow-but-healthy body now succeeds
 * ------------------------------------------------------------------ */

describe("downloadRange — slow but healthy body", () => {
  it("succeeds when the body takes longer than the old 8 s budget", async () => {
    vi.useFakeTimers();

    const bytes = bodyOf(CHUNK0_RANGE_LENGTH);

    installFetch(() =>
      makeResponse(
        206,
        () =>
          new Promise<ArrayBuffer>((resolve) => {
            // 10 s: longer than the old 8 s limit, well inside the
            // derived deadline for this window.
            setTimeout(() => resolve(bytes.slice().buffer), 10_000);
          })
      )
    );

    const p = executorStorage.downloadRange(
      POINTER,
      CONTAINER_HEADER_BYTES,
      CHUNK0_RANGE_LENGTH
    );

    let settled = false;
    void p.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    // Past the OLD limit the read must still be in flight...
    await vi.advanceTimersByTimeAsync(OLD_GATEWAY_TIMEOUT_MS + 1_000);
    expect(settled).toBe(false);

    // ...and must complete once the body lands.
    await vi.advanceTimersByTimeAsync(2_000);

    const out = await p;
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.byteLength).toBe(CHUNK0_RANGE_LENGTH);
  });

  it("issues the container Range window for that read", async () => {
    installFetch(() => ok206(16));

    await executorStorage.downloadRange(POINTER, CONTAINER_HEADER_BYTES, 16);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Range"]).toBe(
      `bytes=${CONTAINER_HEADER_BYTES}-${CONTAINER_HEADER_BYTES + 15}`
    );
  });
});

/* ------------------------------------------------------------------ *
 * #2/#3 — ONE shared budget; a stall is terminal
 * ------------------------------------------------------------------ */

describe("downloadRange — one shared, non-resetting budget", () => {
  it("aborts a stalled BODY at the deadline and fails terminally", async () => {
    vi.useFakeTimers();
    const deadline = rangeDownloadDeadlineMs(4096);

    installFetch(() => stallingBody());

    const p = executorStorage.downloadRange(POINTER, 0, 4096);
    const assertion = expect(p).rejects.toThrow(/Range read timed out/);

    await vi.advanceTimersByTimeAsync(deadline);
    await assertion;

    // The spent budget was NOT re-granted to a later gateway.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts a stalled HEADER read at the same deadline", async () => {
    vi.useFakeTimers();
    const deadline = rangeDownloadDeadlineMs(4096);

    installFetch(
      () =>
        new Promise<Response>(() => {
          // Headers never arrive; the abort listener installed by
          // installFetch is what settles this call.
        })
    );

    const p = executorStorage.downloadRange(POINTER, 0, 4096);
    const assertion = expect(p).rejects.toThrow(/Range read timed out/);

    await vi.advanceTimersByTimeAsync(deadline);
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bounds headers + body by ONE deadline, not one per phase", async () => {
    vi.useFakeTimers();
    const deadline = rangeDownloadDeadlineMs(4096);

    // Headers resolve instantly, then the body never completes.
    installFetch(() => stallingBody());

    const p = executorStorage.downloadRange(POINTER, 0, 4096);
    const assertion = expect(p).rejects.toThrow(/Range read timed out/);

    // Half the budget elapses with the body parked...
    await vi.advanceTimersByTimeAsync(Math.floor(deadline / 2));

    // ...and the whole call still terminates at the single deadline.
    await vi.advanceTimersByTimeAsync(deadline);
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lets fetch follow redirects under the same signal (no manual mode)", async () => {
    installFetch(() => ok206(8));

    await executorStorage.downloadRange(POINTER, 0, 8);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.redirect).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("a deadline abort is a terminal failure, never a hang", async () => {
    vi.useFakeTimers();
    const deadline = rangeDownloadDeadlineMs(4096);

    installFetch(() => stallingBody());

    const p = executorStorage.downloadRange(POINTER, 0, 4096);
    const assertion = expect(p).rejects.toThrow("[AETERNA] Range read timed out");

    await vi.advanceTimersByTimeAsync(deadline);
    await assertion;
  });
});

/* ------------------------------------------------------------------ *
 * #4/#5 — Range / 206 / exact-length semantics unchanged
 * ------------------------------------------------------------------ */

describe("downloadRange — response validation preserved", () => {
  it("accepts a 206 whose Content-Range is unreadable (null)", async () => {
    installFetch(() => ok206(16));

    const out = await executorStorage.downloadRange(POINTER, 0, 16);

    expect(out.byteLength).toBe(16);
  });

  it("accepts a 206 that carries a correct Content-Range", async () => {
    installFetch(() =>
      ok206(16, {
        "content-type": "application/octet-stream",
        "content-range": "bytes 0-15/16",
      })
    );

    const out = await executorStorage.downloadRange(POINTER, 0, 16);

    expect(out.byteLength).toBe(16);
  });

  it("rejects a SHORT body", async () => {
    installFetch(() => ok206(100));

    await expect(
      executorStorage.downloadRange(POINTER, 0, 1024)
    ).rejects.toThrow("[AETERNA] Range read failed");
  });

  it("rejects a LONG body", async () => {
    installFetch(() => ok206(2048));

    await expect(
      executorStorage.downloadRange(POINTER, 0, 1024)
    ).rejects.toThrow("[AETERNA] Range read failed");
  });

  it("rejects a 200 full-object response", async () => {
    installFetch(() => makeResponse(200, async () => bodyOf(64).slice().buffer));

    await expect(
      executorStorage.downloadRange(POINTER, 0, 64)
    ).rejects.toThrow("[AETERNA] Range read failed");
  });

  it("rejects an HTML error page served with 206", async () => {
    installFetch(() => ok206(16, { "content-type": "text/html" }));

    await expect(
      executorStorage.downloadRange(POINTER, 0, 16)
    ).rejects.toThrow("[AETERNA] Range read failed");
  });
});

/* ------------------------------------------------------------------ *
 * #6 — bounded failover over supported endpoints only
 * ------------------------------------------------------------------ */

describe("downloadRange — bounded failover", () => {
  it("only ever attempts the configured, supported endpoints", async () => {
    installFetch(() => makeResponse(404, async () => new ArrayBuffer(0)));

    await expect(
      executorStorage.downloadRange(POINTER, 0, 16)
    ).rejects.toThrow("[AETERNA] Range read failed");

    expect(calledUrls()).toEqual([
      `https://gateway.irys.xyz/tx/${POINTER}/data`,
      `https://arweave.net/tx/${POINTER}/data`,
    ]);
  });

  it("never attempts the removed dead gateways", async () => {
    installFetch(() => makeResponse(404, async () => new ArrayBuffer(0)));

    await expect(
      executorStorage.downloadRange(POINTER, 0, 16)
    ).rejects.toThrow("[AETERNA] Range read failed");

    for (const url of calledUrls()) {
      expect(url).not.toContain("permaweb.eu");
      expect(url).not.toContain("arweave.live");
    }
  });

  it("fails over to the next gateway when the first cannot serve a 206", async () => {
    installFetch((url) =>
      url.startsWith("https://gateway.irys.xyz/")
        ? makeResponse(404, async () => new ArrayBuffer(0))
        : ok206(16)
    );

    const out = await executorStorage.downloadRange(POINTER, 0, 16);

    expect(out.byteLength).toBe(16);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not start a further attempt once the budget is spent", async () => {
    vi.useFakeTimers();
    const deadline = rangeDownloadDeadlineMs(4096);

    installFetch(() => stallingBody());

    const p = executorStorage.downloadRange(POINTER, 0, 4096);
    const assertion = expect(p).rejects.toThrow(/Range read timed out/);

    await vi.advanceTimersByTimeAsync(deadline);
    await assertion;

    // Two gateways are configured; a spent budget must stop after one.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
