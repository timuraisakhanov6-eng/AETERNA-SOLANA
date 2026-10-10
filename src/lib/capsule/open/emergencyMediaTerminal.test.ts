/**
 * Terminal-state regression tests for the EMERGENCY media path and the
 * bounded whole-file read primitive.
 *
 * Covers task section 3:
 *  - #1  bounded Emergency fallback read
 *  - #2  bounded Emergency image read
 *  - #4  SourceBuffer `error` listener removal on every outcome
 *  - #5  MIME incompatibility vs genuine read failure reporting
 *
 * `MediaSource`, `URL` and a `MediaSession` are faked; no real media
 * bytes, no network, no capability secrets.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";

import type { MediaSession } from "./openTypes";

import {
  emergencyMediaSourceStream,
  readWholeFileBounded,
  EMERGENCY_MEDIA_READ_TIMEOUT_MS,
} from "./emergencyMediaSource";

import type {
  EmergencyMediaFailureKind,
} from "./emergencyMediaSource";

/* ───────────────────────── fakes ───────────────────────── */

let mseSupports: (m: string) => boolean = () => false;

class FakeSourceBuffer extends EventTarget {
  appendBuffer(_b: Uint8Array): void {
    queueMicrotask(() => this.dispatchEvent(new Event("updateend")));
  }
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
  (globalThis as unknown as { MediaSource?: unknown }).MediaSource =
    FakeMediaSource;
  (globalThis as unknown as { URL?: unknown }).URL = {
    createObjectURL: (obj: unknown) => {
      if (obj instanceof FakeMediaSource) {
        createdMediaSource = obj as FakeMediaSource;
      }
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
    read: () => readImpl(),
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
  vi.useRealTimers();
  (globalThis as unknown as { MediaSource?: unknown }).MediaSource = undefined;
  (globalThis as unknown as { URL?: unknown }).URL = undefined;
});

/* ─────────────── #1 / #2 bounded whole-file read ─────────────── */

describe("#1/#2: readWholeFileBounded always terminates", () => {
  it("resolves a normal read", async () => {
    const session = makeSession(() => Promise.resolve(bytes(16)));
    await expect(readWholeFileBounded(session, 16)).resolves.toBeInstanceOf(
      Uint8Array,
    );
  });

  it("#1/#2: a stalled read rejects with a bounded timeout (no hang)", async () => {
    vi.useFakeTimers();
    const session = makeSession(
      () => new Promise<Uint8Array<ArrayBuffer>>(() => {}),
    );
    const p = readWholeFileBounded(session, 64);
    const assertion = expect(p).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(EMERGENCY_MEDIA_READ_TIMEOUT_MS + 1_000);
    await assertion;
  });

  it("rejects an invalid size fail-closed", async () => {
    const session = makeSession(() => Promise.resolve(bytes()));
    await expect(readWholeFileBounded(session, -1)).rejects.toThrow();
    await expect(readWholeFileBounded(session, 1.5)).rejects.toThrow();
  });
});

/* ─────────────── #5 failure-kind reporting ─────────────── */

describe("#5: emergencyMediaSourceStream reports WHY it produced no URL", () => {
  it("reports 'not-streamable' and returns null for an unsupported type", async () => {
    mseSupports = () => false;
    const kinds: EmergencyMediaFailureKind[] = [];
    const result = await emergencyMediaSourceStream({
      session: makeSession(() => Promise.resolve(bytes())),
      mimeType: "application/octet-stream",
      size: 64,
      signal: new AbortController().signal,
      onError: () => {},
      onFailureKind: (k) => kinds.push(k),
    });
    expect(result).toBeNull();
    expect(kinds).toEqual(["not-streamable"]);
  });

  it("reports 'mse' when addSourceBuffer rejects the type", async () => {
    mseSupports = (m) => m === "video/webm;codecs=vp8";
    vi.spyOn(FakeMediaSource.prototype, "addSourceBuffer").mockImplementation(
      () => {
        throw new Error("NotSupportedError");
      },
    );
    const kinds: EmergencyMediaFailureKind[] = [];
    const p = emergencyMediaSourceStream({
      session: makeSession(() => Promise.resolve(bytes())),
      mimeType: "video/webm;codecs=vp8",
      size: 64,
      signal: new AbortController().signal,
      onError: () => {},
      onFailureKind: (k) => kinds.push(k),
    });
    createdMediaSource!.dispatchEvent(new Event("sourceopen"));
    await expect(p).resolves.toBeNull();
    expect(kinds).toEqual(["mse"]);
  });

  it("#1: reports 'read' when a chunk read stalls", async () => {
    mseSupports = (m) => m === "video/webm;codecs=vp8";
    vi.useFakeTimers();
    const kinds: EmergencyMediaFailureKind[] = [];
    const p = emergencyMediaSourceStream({
      session: makeSession(
        () => new Promise<Uint8Array<ArrayBuffer>>(() => {}),
      ),
      mimeType: "video/webm;codecs=vp8",
      size: 64,
      signal: new AbortController().signal,
      onError: () => {},
      onFailureKind: (k) => kinds.push(k),
    });
    createdMediaSource!.dispatchEvent(new Event("sourceopen"));
    const assertion = expect(p).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(31_000);
    await assertion;
    expect(kinds).toEqual(["read"]);
  });
});

/* ─────────────── #4 SourceBuffer listener cleanup ─────────────── */

describe("#4: the SourceBuffer error listener is removed on every outcome", () => {
  beforeEach(() => {
    mseSupports = (m) => m === "video/webm;codecs=vp8";
  });

  it("removes it on SUCCESS", async () => {
    const spy = vi.spyOn(FakeSourceBuffer.prototype, "removeEventListener");
    const p = emergencyMediaSourceStream({
      session: makeSession(() => Promise.resolve(bytes(32))),
      mimeType: "video/webm;codecs=vp8",
      size: 64,
      signal: new AbortController().signal,
      onError: () => {},
    });
    createdMediaSource!.dispatchEvent(new Event("sourceopen"));
    await expect(p).resolves.toMatch(/^blob:/);
    expect(spy).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("removes it on a SourceBuffer ERROR event", async () => {
    // Park the stream mid-append: appendBuffer never emits updateend, so
    // the code is awaiting it when the error fires.
    vi.spyOn(FakeSourceBuffer.prototype, "appendBuffer").mockImplementation(
      () => {
        /* never completes */
      },
    );
    const spy = vi.spyOn(FakeSourceBuffer.prototype, "removeEventListener");
    const p = emergencyMediaSourceStream({
      session: makeSession(() => Promise.resolve(bytes(32))),
      mimeType: "video/webm;codecs=vp8",
      size: 64,
      signal: new AbortController().signal,
      onError: () => {},
    });
    createdMediaSource!.dispatchEvent(new Event("sourceopen"));
    // Let the sourceopen handler run so the listener is attached.
    await new Promise((r) => setTimeout(r, 0));
    createdSourceBuffer!.dispatchEvent(new Event("error"));
    await expect(p).resolves.toBeNull();
    expect(spy).toHaveBeenCalledWith("error", expect.any(Function));
  });
});

/* ─────────────── #2 structural guard ─────────────── */

describe("#2: the emergency image + fallback reads are bounded", () => {
  const SRC = readFileSync(
    new URL("../../../emergency/emergencyRuntime.ts", import.meta.url),
    "utf8",
  );

  it("runImage and runFileFallback go through readWholeFileBounded", () => {
    const matches = SRC.match(/readWholeFileBounded\(session, args\.size\)/g);
    expect(matches?.length).toBe(2);
  });

  it("no unbounded whole-file read remains in the emergency runtime", () => {
    expect(SRC).not.toMatch(/session\.read\(0,\s*args\.size\)/);
  });

  it("runProgressiveMedia refuses to fall back after a READ failure", () => {
    expect(SRC).toMatch(/failureKind === "read"/);
  });
});
