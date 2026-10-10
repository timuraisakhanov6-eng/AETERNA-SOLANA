/**
 * Integration harness for the media-session streaming helpers.
 *
 * Exercises the shared media mechanism used by BOTH the primary renderer
 * (`sessionToMediaSource` / `sessionToBoundedBlobUrl` in VaultRenderer)
 * and the Emergency Runtime (`emergencyMediaSourceStream`).
 *
 * Covers task section 7:
 *  - #1  never-resolving chunk read -> bounded rejection (no infinite Loading)
 *  - #6  `sourceopen` / `updateend` never arrive -> safe termination
 *  - #7  bare WebM legacy path (non-streamable -> caller falls back)
 *  - #9  fallback Blob never exceeds the configured byte limit
 *  - #11 primary vs Emergency Runtime share a consistent error/stream path
 *
 * `MediaSource`, `URL` and a `MediaSession` are faked; no real media bytes,
 * no real network, no capability secrets.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Keep the real openRuntime out of the import graph (it pulls ByteRuntime,
// crypto and storage). The functions under test only need the MediaSession
// contract, which we supply directly.
vi.mock("@/lib/capsule/open/openRuntime", () => ({
  openImage: vi.fn(),
  openVideo: vi.fn(),
  openAudio: vi.fn(),
  downloadFile: vi.fn(),
}));

import type { MediaSession } from "./openTypes";
import {
  sessionToMediaSource,
  sessionToBoundedBlobUrl,
  sessionToObjectUrl,
  openStreamableOrFallback,
} from "@/pages/capsule/VaultRenderer";
import { emergencyMediaSourceStream } from "./emergencyMediaSource";
import {
  MediaNotStreamableError,
  isMediaNotStreamableError,
} from "./mediaCompatibility";
import type { OpenableMediaItem } from "./openTypes";

/** Controllable browser capability probe. */
let mseSupports: (m: string) => boolean = () => false;

class FakeSourceBuffer extends EventTarget {
  appendBuffer(_b: Uint8Array): void {
    // Simulate the async append completing.
    queueMicrotask(() => this.dispatchEvent(new Event("updateend")));
  }
  abort(): void {}
}

class FakeMediaSource extends EventTarget {
  static isTypeSupported(m: string): boolean {
    return mseSupports(m);
  }
  readyState: "open" | "ended" = "open";
  addSourceBuffer(_mime: string): FakeSourceBuffer {
    createdSourceBuffer = new FakeSourceBuffer();
    return createdSourceBuffer;
  }
  endOfStream(): void {
    this.readyState = "ended";
  }
}

let createdMediaSource: FakeMediaSource | null = null;
let createdSourceBuffer: FakeSourceBuffer | null = null;

function installGlobals(): void {
  (globalThis as unknown as { MediaSource?: unknown }).MediaSource = FakeMediaSource;
  (globalThis as unknown as { URL?: unknown }).URL = {
    createObjectURL: (obj: unknown) => {
      if (obj instanceof FakeMediaSource) createdMediaSource = obj as FakeMediaSource;
      return "blob:fake:" + Math.random().toString(36).slice(2);
    },
    revokeObjectURL: () => {},
  };
}

function makeSession(
  readImpl: () => Promise<Uint8Array<ArrayBuffer>>,
  disposeImpl?: () => void,
): MediaSession {
  return {
    read: (_s: number, _e: number) => readImpl(),
    dispose: disposeImpl ?? (() => {}),
  };
}

function bytes(n = 32): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(n);
  b.fill(7);
  return b as Uint8Array<ArrayBuffer>;
}

beforeEach(() => {
  createdMediaSource = null;
  createdSourceBuffer = null;
  mseSupports = () => false;
  installGlobals();
});

afterEach(() => {
  vi.restoreAllMocks();
  (globalThis as unknown as { MediaSource?: unknown }).MediaSource = undefined;
  (globalThis as unknown as { URL?: unknown }).URL = undefined;
});

describe("sessionToBoundedBlobUrl (legacy WebM fallback)", () => {
  it("#9: rejects when size exceeds the in-memory fallback limit", async () => {
    const session = makeSession(() => Promise.resolve(bytes()));
    await expect(
      sessionToBoundedBlobUrl(session, 26 * 1024 * 1024, "video/webm"),
    ).rejects.toThrow(/too large/i);
  });

  it("#9: succeeds within the fallback limit and returns an object URL", async () => {
    const session = makeSession(() => Promise.resolve(bytes(64)));
    const url = await sessionToBoundedBlobUrl(session, 1000, "video/webm");
    expect(typeof url).toBe("string");
    expect(url).toMatch(/^blob:/);
  });

  it("#9: invalid size is rejected (fail-closed)", async () => {
    const session = makeSession(() => Promise.resolve(bytes()));
    await expect(sessionToBoundedBlobUrl(session, -5, "video/webm")).rejects.toThrow();
  });
});

describe("sessionToObjectUrl (whole-file image/thumbnail)", () => {
  it("reads the full range into a single object URL and disposes", async () => {
    const dispose = vi.fn();
    const session = makeSession(() => Promise.resolve(bytes(16)), dispose);
    const url = await sessionToObjectUrl(session, 16, "image/png");
    expect(url).toMatch(/^blob:/);
    expect(dispose).toHaveBeenCalled();
  });
});

describe("sessionToMediaSource streaming handshake", () => {
  beforeEach(() => {
    // The streaming path only proceeds past the MIME guard when the
    // concrete codec is actually supported by MSE.
    mseSupports = (m) => m === "video/webm;codecs=vp8";
  });

  it("streams chunks to a MediaSource object URL and resolves", async () => {
    const session = makeSession(() => Promise.resolve(bytes(32)));
    const p = sessionToMediaSource(session, "video/webm;codecs=vp8", 64, undefined);
    createdMediaSource!.dispatchEvent(new Event("sourceopen"));
    const url = await p;
    expect(typeof url).toBe("string");
    expect(url).toMatch(/^blob:/);
  });

  it("#6: sourceopen never fires -> safe rejection (no hang)", async () => {
    vi.useFakeTimers();
    const session = makeSession(() => Promise.resolve(bytes(32)));
    const p = sessionToMediaSource(session, "video/webm;codecs=vp8", 64, undefined);
    // Attach the rejection handler immediately so the timeout rejection
    // is never reported as unhandled while timers advance.
    const assertion = expect(p).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(21_000);
    await assertion;
    vi.useRealTimers();
  });

  it("#6: updateend never fires -> safe rejection (no hang)", async () => {
    vi.useFakeTimers();
    vi.spyOn(FakeSourceBuffer.prototype, "appendBuffer").mockImplementation(
      function () {
        /* never completes */
      },
    );
    const session = makeSession(() => Promise.resolve(bytes(32)));
    const p = sessionToMediaSource(session, "video/webm;codecs=vp8", 64, undefined);
    const assertion = expect(p).rejects.toBeDefined();
    createdMediaSource!.dispatchEvent(new Event("sourceopen"));
    await vi.advanceTimersByTimeAsync(51_000);
    await assertion;
    vi.useRealTimers();
  });

  it("#1: never-resolving chunk read -> bounded rejection (no hang)", async () => {
    vi.useFakeTimers();
    const session = makeSession(
      () => new Promise<Uint8Array<ArrayBuffer>>(() => {}),
    );
    const p = sessionToMediaSource(session, "video/webm;codecs=vp8", 64, undefined);
    const assertion = expect(p).rejects.toBeDefined();
    createdMediaSource!.dispatchEvent(new Event("sourceopen"));
    await vi.advanceTimersByTimeAsync(31_000);
    await assertion;
    vi.useRealTimers();
  });

  it("abort signal short-circuits to rejection", async () => {
    const controller = new AbortController();
    const session = makeSession(
      () => new Promise<Uint8Array<ArrayBuffer>>(() => {}),
    );
    const p = sessionToMediaSource(
      session,
      "video/webm;codecs=vp8",
      64,
      controller.signal,
    );
    controller.abort();
    await expect(p).rejects.toBeDefined();
  });
});

describe("#11: primary vs Emergency Runtime share a consistent media mechanism", () => {
  beforeEach(() => {
    mseSupports = (m) => m === "video/webm;codecs=vp8";
  });

  it("non-streamable input: primary throws, emergency returns null (both refuse to stream)", async () => {
    const session = makeSession(() => Promise.resolve(bytes(32)));
    await expect(
      sessionToMediaSource(session, "application/octet-stream", 64, undefined),
    ).rejects.toThrow(/Progressive playback unavailable/i);

    const eSession = makeSession(() => Promise.resolve(bytes(32)));
    const result = await emergencyMediaSourceStream({
      session: eSession,
      mimeType: "application/octet-stream",
      size: 64,
      signal: new AbortController().signal,
      onError: () => {},
    });
    expect(result).toBeNull();
  });

  it("streamable input: both produce an object URL via the same MSE path", async () => {
    const session = makeSession(() => Promise.resolve(bytes(32)));
    const p = sessionToMediaSource(session, "video/webm;codecs=vp8", 64, undefined);
    createdMediaSource!.dispatchEvent(new Event("sourceopen"));
    const primaryUrl = await p;
    expect(primaryUrl).toMatch(/^blob:/);

    createdMediaSource = null;
    const eSession = makeSession(() => Promise.resolve(bytes(32)));
    const ePromise = emergencyMediaSourceStream({
      session: eSession,
      mimeType: "video/webm;codecs=vp8",
      size: 64,
      signal: new AbortController().signal,
      onError: () => {},
    });
    createdMediaSource!.dispatchEvent(new Event("sourceopen"));
    const emergencyUrl = await ePromise;
    expect(emergencyUrl).toMatch(/^blob:/);
  });
});

/* ============================================================
   #4 — primary SourceBuffer error-listener cleanup
   ============================================================ */

describe("#4: sessionToMediaSource removes the SourceBuffer error listener", () => {
  beforeEach(() => {
    mseSupports = (m) => m === "video/webm;codecs=vp8";
  });

  it("removes it on SUCCESS", async () => {
    const spy = vi.spyOn(FakeSourceBuffer.prototype, "removeEventListener");
    const session = makeSession(() => Promise.resolve(bytes(32)));
    const p = sessionToMediaSource(session, "video/webm;codecs=vp8", 64, undefined);
    createdMediaSource!.dispatchEvent(new Event("sourceopen"));
    await p;
    expect(spy).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("removes it when the SourceBuffer errors", async () => {
    // Park the stream mid-append so the error is the settling event.
    vi.spyOn(FakeSourceBuffer.prototype, "appendBuffer").mockImplementation(
      () => {
        /* never completes */
      },
    );
    const spy = vi.spyOn(FakeSourceBuffer.prototype, "removeEventListener");
    const session = makeSession(() => Promise.resolve(bytes(32)));
    const p = sessionToMediaSource(session, "video/webm;codecs=vp8", 64, undefined);
    createdMediaSource!.dispatchEvent(new Event("sourceopen"));
    await new Promise((r) => setTimeout(r, 0));
    createdSourceBuffer!.dispatchEvent(new Event("error"));
    await expect(p).rejects.toBeInstanceOf(MediaNotStreamableError);
    expect(spy).toHaveBeenCalledWith("error", expect.any(Function));
  });
});

/* ============================================================
   #5 — MSE incompatibility vs genuine read failure
   ============================================================ */

describe("#5: MSE incompatibility is distinguishable from a read failure", () => {
  it("an unsupported type rejects with MediaNotStreamableError", async () => {
    mseSupports = () => false;
    const session = makeSession(() => Promise.resolve(bytes()));
    await expect(
      sessionToMediaSource(session, "application/octet-stream", 64, undefined),
    ).rejects.toBeInstanceOf(MediaNotStreamableError);
  });

  it("a stalled sourceopen handshake is classified as an MSE failure", async () => {
    mseSupports = (m) => m === "video/webm;codecs=vp8";
    vi.useFakeTimers();
    const session = makeSession(() => Promise.resolve(bytes()));
    const p = sessionToMediaSource(session, "video/webm;codecs=vp8", 64, undefined);
    const assertion = expect(p).rejects.toBeInstanceOf(MediaNotStreamableError);
    await vi.advanceTimersByTimeAsync(21_000);
    await assertion;
    vi.useRealTimers();
  });

  it("a READ failure is NOT a MediaNotStreamableError", async () => {
    mseSupports = (m) => m === "video/webm;codecs=vp8";
    const session = makeSession(() =>
      Promise.reject(new Error("range fetch failed")),
    );
    const p = sessionToMediaSource(session, "video/webm;codecs=vp8", 64, undefined);
    createdMediaSource!.dispatchEvent(new Event("sourceopen"));
    const err: unknown = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(isMediaNotStreamableError(err)).toBe(false);
    expect((err as Error).message).toMatch(/range fetch failed/);
  });
});

/* ============================================================
   #6 / #8 — fallback classification and the 25 MiB bound
   ============================================================ */

describe("#6/#8: openStreamableOrFallback never retries a READ failure", () => {
  it("#6: does NOT fall back after a genuine read failure (one read attempt only)", async () => {
    mseSupports = (m) => m === "video/webm;codecs=vp8";
    let readCalls = 0;
    const session = makeSession(() => {
      readCalls++;
      return Promise.reject(new Error("decrypt failed"));
    });
    const media = {
      mimeType: "video/webm;codecs=vp8",
      size: 64,
    } as unknown as OpenableMediaItem;

    const p = openStreamableOrFallback(
      session,
      media,
      new AbortController().signal,
    );
    createdMediaSource!.dispatchEvent(new Event("sourceopen"));

    await expect(p).rejects.toThrow(/decrypt failed/);
    // The failed read was NOT repeated as a whole-file read.
    expect(readCalls).toBe(1);
  });

  it("#6: falls back to a bounded Blob on MSE/MIME incompatibility", async () => {
    mseSupports = () => false;
    let readCalls = 0;
    const session = makeSession(() => {
      readCalls++;
      return Promise.resolve(bytes(16));
    });
    const media = {
      mimeType: "video/webm",
      size: 64,
    } as unknown as OpenableMediaItem;

    const url = await openStreamableOrFallback(
      session,
      media,
      new AbortController().signal,
    );
    expect(url).toMatch(/^blob:/);
    expect(readCalls).toBe(1);
  });

  it("#8: a non-streamable item above the 25 MiB bound terminates", async () => {
    mseSupports = () => false;
    const session = makeSession(() => Promise.resolve(bytes(16)));
    const media = {
      mimeType: "video/webm",
      size: 26 * 1024 * 1024,
    } as unknown as OpenableMediaItem;

    await expect(
      openStreamableOrFallback(session, media, new AbortController().signal),
    ).rejects.toThrow(/too large/i);
  });
});
