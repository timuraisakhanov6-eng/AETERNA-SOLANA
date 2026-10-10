// @vitest-environment jsdom
/**
 * =========================================================
 * MediaSource attachment semantics — regression suite
 * =========================================================
 *
 * Models the REAL browser rule that caused the confirmed Production
 * defect (video appeared only after ~24 s):
 *
 *   A MediaSource becomes "open" — and fires `sourceopen` — ONLY once
 *   its object URL is assigned to a media element.
 *
 * The fakes below enforce that rule: `FakeMediaSource.readyState`
 * starts `closed`, and `sourceopen` is dispatched by the `src` setter
 * of an attachable element — never by the test directly. A regression
 * to "await sourceopen before attaching" therefore makes these tests
 * time out / fail rather than silently pass.
 *
 * Covered:
 *  - primary path (`sessionToMediaSource` / `openStreamableOrFallback`)
 *  - Emergency path (`emergencyMediaSourceStream`)
 *  - the Blob fallback still owns non-streamable MIME and real errors
 *  - cancellation detaches the element and revokes the object URL
 *
 * No real media bytes, no network, no capability secrets.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";

vi.mock("@/lib/capsule/open/openRuntime", () => ({
  openImage: vi.fn(),
  openVideo: vi.fn(),
  openAudio: vi.fn(),
  downloadFile: vi.fn(),
}));

import type { MediaSession } from "./openTypes";
import type { OpenableMediaItem } from "./openTypes";

import {
  sessionToMediaSource,
  openStreamableOrFallback,
} from "@/pages/capsule/VaultRenderer";

import {
  emergencyMediaSourceStream,
} from "./emergencyMediaSource";
import type {
  EmergencyMediaFailureKind,
} from "./emergencyMediaSource";

/** The production open-handshake budget (VaultRenderer.tsx). */
const MEDIA_SOURCE_OPEN_TIMEOUT_MS = 20_000;

const VP8_OPUS = "video/webm;codecs=vp8,opus";

/* ───────────────────────── fakes ───────────────────────── */

let mseSupports: (m: string) => boolean = () => true;

class FakeSourceBuffer extends EventTarget {
  appendBuffer(_b: Uint8Array): void {
    queueMicrotask(() => this.dispatchEvent(new Event("updateend")));
  }
  abort(): void {}
}

class FakeMediaSource extends EventTarget {
  static isTypeSupported(m: string): boolean {
    return mseSupports(m);
  }
  /** Browser semantics: a fresh MediaSource is CLOSED. */
  readyState: "closed" | "open" | "ended" = "closed";
  addSourceBuffer(_mime: string): FakeSourceBuffer {
    return new FakeSourceBuffer();
  }
  endOfStream(): void {
    this.readyState = "ended";
  }
}

/** object URL → the MediaSource it was minted for. */
let mediaSourcesByUrl: Map<string, FakeMediaSource>;
let revokedUrls: string[];
let urlSeq = 0;

function installGlobals(): void {
  (globalThis as unknown as { MediaSource?: unknown }).MediaSource =
    FakeMediaSource;

  (globalThis as unknown as { URL?: unknown }).URL = {
    createObjectURL: (obj: unknown) => {
      if (obj instanceof FakeMediaSource) {
        const url = `blob:mediasource-${++urlSeq}`;
        mediaSourcesByUrl.set(url, obj);
        return url;
      }
      // Anything else (e.g. a Blob from the whole-file fallback).
      return `blob:object-${++urlSeq}`;
    },
    revokeObjectURL: (url: string) => {
      revokedUrls.push(url);
    },
  };
}

/**
 * A media element that reproduces the browser's attachment rule:
 * assigning a MediaSource object URL OPENS that MediaSource and fires
 * `sourceopen` (asynchronously). Nothing else ever fires it.
 */
function attachableMediaElement(): HTMLMediaElement {
  const el = document.createElement("video");
  let currentSrc = "";

  Object.defineProperty(el, "src", {
    configurable: true,
    get: () => currentSrc,
    set: (value: string) => {
      currentSrc = String(value);

      const ms = mediaSourcesByUrl.get(currentSrc);
      if (!ms) return;

      ms.readyState = "open";
      queueMicrotask(() => ms.dispatchEvent(new Event("sourceopen")));
    },
  });

  Object.defineProperty(el, "removeAttribute", {
    configurable: true,
    value(name: string) {
      if (String(name).toLowerCase() === "src") currentSrc = "";
    },
  });

  return el as unknown as HTMLMediaElement;
}

function makeSession(
  readImpl: (start: number, end: number) => Promise<Uint8Array<ArrayBuffer>>,
  disposeImpl?: () => void
): MediaSession {
  return {
    read: readImpl,
    dispose: disposeImpl ?? (() => {}),
  };
}

function bytes(n = 16): Uint8Array<ArrayBuffer> {
  return new Uint8Array(n) as Uint8Array<ArrayBuffer>;
}

function media(mimeType: string, size = 16): OpenableMediaItem {
  return { mimeType, size } as unknown as OpenableMediaItem;
}

/** Advances fake time in steps until `p` settles; returns ms elapsed. */
async function advanceUntilSettled(
  p: Promise<unknown>,
  step = 50,
  max = 40_000
): Promise<number> {
  let settled = false;
  void p.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );

  let elapsed = 0;
  while (!settled && elapsed < max) {
    await vi.advanceTimersByTimeAsync(step);
    elapsed += step;
  }

  return elapsed;
}

beforeEach(() => {
  mediaSourcesByUrl = new Map();
  revokedUrls = [];
  urlSeq = 0;
  mseSupports = () => true;
  installGlobals();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  (globalThis as unknown as { MediaSource?: unknown }).MediaSource = undefined;
  (globalThis as unknown as { URL?: unknown }).URL = undefined;
});

/* ─────────────────── the modelled browser rule ─────────────────── */

describe("harness models the real attachment rule", () => {
  it("does NOT fire sourceopen when the object URL is never attached", async () => {
    const ms = new FakeMediaSource();
    const url = URL.createObjectURL(ms as unknown as MediaSource);

    let fired = false;
    ms.addEventListener("sourceopen", () => {
      fired = true;
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(url).toMatch(/^blob:mediasource-/);
    expect(fired).toBe(false);
    expect(ms.readyState).toBe("closed");
  });

  it("fires sourceopen once the object URL is attached to a media element", async () => {
    const ms = new FakeMediaSource();
    const url = URL.createObjectURL(ms as unknown as MediaSource);

    let fired = false;
    ms.addEventListener("sourceopen", () => {
      fired = true;
    });

    const el = attachableMediaElement();
    el.src = url;

    await new Promise((r) => setTimeout(r, 20));

    expect(fired).toBe(true);
    expect(ms.readyState).toBe("open");
  });
});

/* ─────────────────── primary path: early attachment ─────────────────── */

describe("sessionToMediaSource — attaches before awaiting sourceopen", () => {
  it("opens via the attached element, far inside the 20 s budget", async () => {
    vi.useFakeTimers();

    const el = attachableMediaElement();
    const session = makeSession(async () => bytes(16));

    const p = sessionToMediaSource(
      session,
      VP8_OPUS,
      16,
      undefined,
      el
    );

    const elapsed = await advanceUntilSettled(p);

    await expect(p).resolves.toMatch(/^blob:mediasource-/);
    expect(el.src).toMatch(/^blob:mediasource-/);

    // The whole point: NOT the open timeout.
    expect(elapsed).toBeLessThan(1_000);
    expect(elapsed).toBeLessThan(MEDIA_SOURCE_OPEN_TIMEOUT_MS);
  });

  it("without an element to attach to it can only time out (the old bug)", async () => {
    vi.useFakeTimers();

    const session = makeSession(async () => bytes(16));

    const p = sessionToMediaSource(session, VP8_OPUS, 16);

    const assertion = expect(p).rejects.toThrow(
      /MediaSource sourceopen timed out/
    );

    await vi.advanceTimersByTimeAsync(MEDIA_SOURCE_OPEN_TIMEOUT_MS);
    await assertion;
  });
});

describe("openStreamableOrFallback — MediaSource wins, Blob is NOT used", () => {
  it("returns the MediaSource URL and reads in bounded MSE windows", async () => {
    const el = attachableMediaElement();
    const reads: Array<[number, number]> = [];
    const size = 1_000_000;

    const session = makeSession(async (start, end) => {
      reads.push([start, end]);
      return bytes(end - start);
    });

    const url = await openStreamableOrFallback(
      session,
      media(VP8_OPUS, size),
      new AbortController().signal,
      el
    );

    // The MediaSource URL — NOT the Blob minted by the fallback.
    expect(url).toMatch(/^blob:mediasource-/);

    // The MSE path reads the FIRST 256 KiB window, never the whole
    // file in one read (which is what the Blob fallback would do).
    expect(reads[0]).toEqual([0, 262_144]);
    expect(reads).not.toContainEqual([0, size]);
  });

  it("still falls back to a Blob for a genuinely non-streamable MIME", async () => {
    mseSupports = () => false;

    const el = attachableMediaElement();
    const reads: Array<[number, number]> = [];

    const session = makeSession(async (start, end) => {
      reads.push([start, end]);
      return bytes(end - start);
    });

    const url = await openStreamableOrFallback(
      session,
      media("video/webm", 16),
      new AbortController().signal,
      el
    );

    expect(url).toMatch(/^blob:object-/);
    // The element was never attached: the MSE path was never entered.
    expect(el.src).toBe("");
    // The bounded whole-file read ran exactly once.
    expect(reads).toEqual([[0, 16]]);
  });

  it("propagates a genuine READ failure without a whole-file retry", async () => {
    const el = attachableMediaElement();
    let calls = 0;

    const session = makeSession(async () => {
      calls++;
      throw new Error("[AETERNA] Range read failed");
    });

    await expect(
      openStreamableOrFallback(
        session,
        media(VP8_OPUS, 16),
        new AbortController().signal,
        el
      )
    ).rejects.toThrow(/Range read failed/);

    // A failed read is never retried as a whole-file download.
    expect(calls).toBe(1);
  });
});

/* ─────────────────── cancellation / teardown ─────────────────── */

describe("cancellation releases the element and the object URL", () => {
  it("abort detaches the element and revokes the MediaSource URL", async () => {
    const el = attachableMediaElement();
    const controller = new AbortController();

    const session = makeSession(
      () => new Promise<Uint8Array<ArrayBuffer>>(() => {})
    );

    const p = sessionToMediaSource(
      session,
      VP8_OPUS,
      16,
      controller.signal,
      el
    );

    // Let the attempt reach the attached state.
    await new Promise((r) => setTimeout(r, 10));
    expect(el.src).toMatch(/^blob:mediasource-/);

    const attachedUrl = el.src;
    controller.abort();

    await expect(p).rejects.toThrow(/MediaSource stream cancelled/);

    // Element released BEFORE the URL was revoked, so it never holds a
    // dead object URL.
    expect(el.src).toBe("");
    expect(revokedUrls).toContain(attachedUrl);
  });

  it("a stalled handshake that is aborted does not stay pending", async () => {
    vi.useFakeTimers();

    const el = attachableMediaElement();
    const controller = new AbortController();

    const session = makeSession(
      () => new Promise<Uint8Array<ArrayBuffer>>(() => {})
    );

    const p = sessionToMediaSource(
      session,
      VP8_OPUS,
      16,
      controller.signal,
      el
    );

    const assertion = expect(p).rejects.toBeDefined();

    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(100);

    await assertion;
  });
});

/* ─────────────────── emergency path ─────────────────── */

describe("emergencyMediaSourceStream — same attachment contract", () => {
  it("opens via the attached element and returns the object URL", async () => {
    const el = attachableMediaElement();

    const url = await emergencyMediaSourceStream({
      session: makeSession(async (s, e) => bytes(e - s)),
      mimeType: VP8_OPUS,
      size: 16,
      signal: new AbortController().signal,
      onError: () => {},
      attachTo: el,
    });

    expect(url).toMatch(/^blob:mediasource-/);
    expect(el.src).toMatch(/^blob:mediasource-/);
  });

  it("without an element it reports an MSE failure instead of opening", async () => {
    vi.useFakeTimers();

    const kinds: EmergencyMediaFailureKind[] = [];

    const p = emergencyMediaSourceStream({
      session: makeSession(async (s, e) => bytes(e - s)),
      mimeType: VP8_OPUS,
      size: 16,
      signal: new AbortController().signal,
      onError: () => {},
      onFailureKind: (k) => kinds.push(k),
    });

    await vi.advanceTimersByTimeAsync(MEDIA_SOURCE_OPEN_TIMEOUT_MS);

    await expect(p).resolves.toBeNull();
    expect(kinds).toEqual(["mse"]);
  });

  it("abort detaches the emergency element too", async () => {
    const el = attachableMediaElement();
    const controller = new AbortController();

    const p = emergencyMediaSourceStream({
      session: makeSession(
        () => new Promise<Uint8Array<ArrayBuffer>>(() => {})
      ),
      mimeType: VP8_OPUS,
      size: 16,
      signal: controller.signal,
      onError: () => {},
      attachTo: el,
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(el.src).toMatch(/^blob:mediasource-/);

    controller.abort();

    await expect(p).resolves.toBeNull();
    expect(el.src).toBe("");
  });
});
