/**
 * =========================================================
 * storage façade — bounded range read (Stage 1)
 * =========================================================
 *
 * Tests the public façade contract:
 *
 * • the primitive is exposed
 * • the size cap is re-scoped to the REQUESTED WINDOW
 *   (never the object size)
 * • there is no whole-object fallback
 * • the whole-object `download()` path is unchanged
 *
 * `fetch` is stubbed — no network.
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
  storage,
  download,
  downloadRange,
} from "@/lib/storage/storage";

const POINTER =
  "EFnj5s3hmYqXmoxVEQetK1vBrCpffsVu7nGWtEsstmPo" as StoragePointer;

/** Canonical 256 MiB whole-object / window cap. */
const CAP = 256 * 1024 * 1024;

function makeResponse(
  status: number,
  body: Uint8Array,
  headers: Record<string, string> = { "content-type": "application/octet-stream" }
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

describe("storage façade — range read is exposed", () => {
  it("exposes downloadRange as a function", () => {
    expect(typeof storage.downloadRange).toBe("function");
    expect(typeof downloadRange).toBe("function");
  });

  it("exposes the unchanged whole-object download", () => {
    expect(typeof storage.download).toBe("function");
    expect(typeof download).toBe("function");
  });

  it("returns exactly the requested window", async () => {
    const body = pattern(2048);
    fetchMock.mockResolvedValue(makeResponse(206, body));

    const out = await downloadRange(POINTER, 0, 2048);

    expect(out.byteLength).toBe(2048);
    expect(Array.from(out)).toEqual(Array.from(body));
  });
});

describe("storage façade — window bound, not object bound", () => {
  it("issues a single bounded request and never the whole object", async () => {
    // Stands in for a 20 GB object: the façade cannot see the object
    // size, so the only thing that can bound the read is the window.
    fetchMock.mockResolvedValue(makeResponse(206, pattern(1024 * 1024)));

    const out = await downloadRange(POINTER, 0, 1024 * 1024);

    expect(out.byteLength).toBe(1024 * 1024);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url] = firstCall();

    // Exactly one request, and it is a range request for the window.
    expect(firstHeaders()["Range"]).toBe("bytes=0-1048575");
    expect(url).toContain(`/tx/${POINTER}/data`);
  });

  it("succeeds for a window far below the whole-object cap", async () => {
    fetchMock.mockResolvedValue(makeResponse(206, pattern(64)));

    const out = await downloadRange(POINTER, 5_000_000_000, 64);

    expect(out.byteLength).toBe(64);

    // Offset far beyond the 256 MiB cap is still a legal window.
    expect(firstHeaders()["Range"]).toBe("bytes=5000000000-5000000063");
  });

  it("rejects a window larger than the cap WITHOUT any request", async () => {
    await expect(downloadRange(POINTER, 0, CAP + 1)).rejects.toThrow(
      "[AETERNA] Storage failure"
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a window exactly at the cap", async () => {
    // Only the header is exercised here; the body is not materialised.
    fetchMock.mockResolvedValue(makeResponse(206, new Uint8Array(0)));

    // A short body must still fail closed, proving the cap check
    // passed and the exact-length check is what rejected it.
    await expect(downloadRange(POINTER, 0, CAP)).rejects.toThrow(
      "[AETERNA] Storage failure"
    );

    expect(firstHeaders()["Range"]).toBe(`bytes=0-${CAP - 1}`);
  });
});

describe("storage façade — no whole-object fallback", () => {
  it("fails closed when the gateway answers 200 with the full object", async () => {
    fetchMock.mockResolvedValue(makeResponse(200, pattern(4096)));

    await expect(downloadRange(POINTER, 0, 32)).rejects.toThrow(
      "[AETERNA] Storage failure"
    );
  });

  it("fails closed on a short body", async () => {
    fetchMock.mockResolvedValue(makeResponse(206, pattern(31)));

    await expect(downloadRange(POINTER, 0, 32)).rejects.toThrow(
      "[AETERNA] Storage failure"
    );
  });

  it("fails closed on a long body", async () => {
    fetchMock.mockResolvedValue(makeResponse(206, pattern(33)));

    await expect(downloadRange(POINTER, 0, 32)).rejects.toThrow(
      "[AETERNA] Storage failure"
    );
  });

  it("fails closed on 416", async () => {
    fetchMock.mockResolvedValue(makeResponse(416, new Uint8Array(0)));

    await expect(downloadRange(POINTER, 0, 32)).rejects.toThrow(
      "[AETERNA] Storage failure"
    );
  });
});

describe("storage façade — range validation", () => {
  // Validation runs BEFORE the try/catch, mirroring the existing
  // whole-object download(): the precise reason surfaces rather than
  // being collapsed into the sealed error. Every case still fails
  // closed and still issues no request.

  it("fails closed on a negative offset without any request", async () => {
    await expect(downloadRange(POINTER, -1, 16)).rejects.toThrow(
      "[AETERNA] Invalid range offset"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed on a zero length without any request", async () => {
    await expect(downloadRange(POINTER, 0, 0)).rejects.toThrow(
      "[AETERNA] Invalid range length"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed on a non-integer length without any request", async () => {
    await expect(downloadRange(POINTER, 0, 1.5)).rejects.toThrow(
      "[AETERNA] Invalid range length"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed on an unsafe offset without any request", async () => {
    await expect(
      downloadRange(POINTER, Number.MAX_SAFE_INTEGER, 2)
    ).rejects.toThrow("[AETERNA] Range arithmetic overflow");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed on an invalid pointer without any request", async () => {
    await expect(
      downloadRange("nope" as StoragePointer, 0, 16)
    ).rejects.toThrow("[AETERNA] Invalid storage pointer");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("storage façade — whole-object path is unchanged", () => {
  it("download() issues a plain request with NO Range header", async () => {
    fetchMock.mockResolvedValue(makeResponse(200, pattern(256)));

    const out = await download(POINTER);

    expect(out.byteLength).toBe(256);

    expect(firstCall()[1].headers).toBeUndefined();
  });
});
