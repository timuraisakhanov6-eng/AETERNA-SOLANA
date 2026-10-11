// @vitest-environment jsdom
/**
 * =========================================================
 * Emergency A/V URL ownership — contract regression
 * =========================================================
 *
 * The progressive emergency stream attaches its object URL to the
 * already-mounted `<video>` BEFORE awaiting `sourceopen`. The
 * stream-ready handler must therefore NEVER treat that URL as a
 * previous resource:
 *
 *   • it must not be revoked  (that kills the stream that just opened);
 *   • it must not be detached / re-assigned (same effect).
 *
 * Genuinely previous URLs must still be released, and a Blob produced
 * by the bounded fallback must still be attached.
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

vi.mock("@/lib/storage/storage", () => ({
  storage: {
    downloadRange: vi.fn(),
    download: vi.fn(),
  },
  getChunkPointerReadout: vi.fn(),
}));

vi.mock("@/lib/crypto/decryptChunk", () => ({
  decryptChunk: vi.fn(),
}));

import type { ChunkMetadata, PublishedChunkMetadata } from "@/types/vault";

import { buildEmergencyMediaElement } from "@/emergency/emergencyRuntime";
import { storage } from "@/lib/storage/storage";
import { decryptChunk } from "@/lib/crypto/decryptChunk";

const PTR = "EFnj5s3hmYqXmoxVEQetK1vBrCpffsVu7nGWtEsstmPo";
const CAPSULE_ID = "cap-0000000000000000";
const VP8_OPUS = "video/webm;codecs=vp8,opus";

const SIZE = 16;
const CIPHER = SIZE + 28; // AES-GCM IV + tag

/* ───────── fakes ───────── */

let mseSupports: (m: string) => boolean = () => true;
let addSourceBufferThrows = false;

class FakeSourceBuffer extends EventTarget {
  appendBuffer(_b?: Uint8Array): void {
    queueMicrotask(() => this.dispatchEvent(new Event("updateend")));
  }
  abort(): void {}
}

class FakeMediaSource extends EventTarget {
  static isTypeSupported(m: string): boolean {
    return mseSupports(m);
  }
  readyState: "closed" | "open" | "ended" = "closed";
  addSourceBuffer(): FakeSourceBuffer {
    if (addSourceBufferThrows) throw new Error("mse rejected");
    return new FakeSourceBuffer();
  }
  endOfStream(): void {
    this.readyState = "ended";
  }
}

/**
 * NOTE: `MutationObserver` is intentionally NOT stubbed any more.
 *
 * `buildEmergencyMediaSession` used to call
 * `observe(root, { subtree: false })`, which throws a TypeError in every
 * spec-compliant engine (verified in a clean Chromium). The fix watches
 * `root.parentNode` with `{ childList: true }`, so the REAL observer runs
 * here — and the "does not throw" regression below fails on the old
 * configuration.
 */

let sourcesByUrl: Map<string, FakeMediaSource>;
let revoked: string[];
let urlSeq = 0;

/* ───────── instrumented media element ───────── */

type Instrumented = HTMLMediaElement & { __src?: string };

let originalSrcDescriptor: PropertyDescriptor | undefined;
let originalRemoveAttribute: typeof Element.prototype.removeAttribute;
let originalSetAttribute: typeof Element.prototype.setAttribute;

/**
 * Models the real rule the fix depends on: a MediaSource opens (and
 * fires `sourceopen`) only once its object URL is assigned to a media
 * element, and a second identical assignment CLOSES it again.
 */
function installMediaInstrumentation(): void {
  const proto = HTMLMediaElement.prototype;

  originalSrcDescriptor = Object.getOwnPropertyDescriptor(proto, "src");
  originalRemoveAttribute = Element.prototype.removeAttribute;
  originalSetAttribute = Element.prototype.setAttribute;

  Object.defineProperty(proto, "src", {
    configurable: true,
    get(this: Instrumented) {
      return this.__src ?? "";
    },
    set(this: Instrumented, value: string) {
      const url = String(value);
      this.__src = url;
      // Reflect to the real attribute so getAttribute/hasAttribute work.
      originalSetAttribute.call(this, "src", url);

      const ms = sourcesByUrl.get(url);
      if (!ms) return;

      if (ms.readyState !== "closed") {
        // Identical re-assignment: Chromium closes the MediaSource.
        ms.readyState = "closed";
        return;
      }

      ms.readyState = "open";
      queueMicrotask(() => ms.dispatchEvent(new Event("sourceopen")));
    },
  });

  Object.defineProperty(proto, "removeAttribute", {
    configurable: true,
    value(this: Instrumented, name: string) {
      if (String(name).toLowerCase() === "src") this.__src = "";
      return originalRemoveAttribute.call(this, name);
    },
  });

  Object.defineProperty(proto, "setAttribute", {
    configurable: true,
    value(this: Instrumented, name: string, value: string) {
      if (String(name).toLowerCase() === "src") {
        (this as HTMLMediaElement).src = String(value);
        return;
      }
      return originalSetAttribute.call(this, name, value);
    },
  });
}

function restoreMediaInstrumentation(): void {
  const proto = HTMLMediaElement.prototype;
  if (originalSrcDescriptor) {
    Object.defineProperty(proto, "src", originalSrcDescriptor);
  }
  Object.defineProperty(proto, "removeAttribute", {
    configurable: true,
    value: originalRemoveAttribute,
  });
  Object.defineProperty(proto, "setAttribute", {
    configurable: true,
    value: originalSetAttribute,
  });
}

function installGlobals(): void {
  (globalThis as unknown as { MediaSource?: unknown }).MediaSource =
    FakeMediaSource;

  (globalThis as unknown as { URL?: unknown }).URL = {
    createObjectURL: (obj: unknown) => {
      if (obj instanceof FakeMediaSource) {
        const url = `blob:mediasource-${++urlSeq}`;
        sourcesByUrl.set(url, obj);
        return url;
      }
      return `blob:object-${++urlSeq}`;
    },
    revokeObjectURL: (url: string) => {
      revoked.push(url);
    },
  };
}

function makeChunk(): ChunkMetadata {
  return {
    chunkId: "c0",
    mediaId: "m0",
    index: 0,
    size: CIPHER,
    pointer: PTR,
  } as unknown as ChunkMetadata;
}

function makePublished(): PublishedChunkMetadata {
  return {
    chunkId: "c0",
    mediaId: "m0",
    index: 0,
    size: CIPHER,
    pointer: PTR,
    container: {
      containerTxId: PTR,
      globalIndex: 0,
      offset: 64,
      length: CIPHER,
    },
  } as unknown as PublishedChunkMetadata;
}

function build(mimeType: string) {
  const root = document.createElement("div");
  const status = document.createElement("div");
  document.body.appendChild(root);
  document.body.appendChild(status);

  buildEmergencyMediaElement({
    root,
    status,
    item: {
      mediaType: "video",
      filename: "v.webm",
      mimeType,
      size: SIZE,
      createdAt: "2026-01-01T00:00:00.000Z",
    } as never,
    capsuleId: CAPSULE_ID,
    chunks: [makeChunk()],
    resolvedChunks: [makePublished()],
    cryptoKey: {} as CryptoKey,
    mediaType: "video",
    mimeType,
    size: SIZE,
  });

  return { root, status };
}

/** Polls until `check()` is true (real timers). */
async function waitUntil(check: () => boolean, ms = 1000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitUntil: condition not met in time");
}

beforeEach(() => {
  sourcesByUrl = new Map();
  revoked = [];
  urlSeq = 0;
  mseSupports = () => true;
  addSourceBufferThrows = false;

  document.body.innerHTML = "";
  installGlobals();
  installMediaInstrumentation();

  vi.mocked(storage.downloadRange).mockResolvedValue(
    new Uint8Array(CIPHER) as Uint8Array<ArrayBuffer>
  );
  vi.mocked(decryptChunk).mockResolvedValue(new Uint8Array(SIZE));
});

afterEach(async () => {
  // Let each test's detach watchdog run to completion INSIDE the jsdom
  // environment: emptying the body detaches `root`, the observer fires
  // and cleanup disconnects it. Without this, a surviving observer would
  // fire during environment teardown and touch a `window` that no longer
  // exists.
  document.body.innerHTML = "";
  await new Promise((r) => setTimeout(r, 10));

  restoreMediaInstrumentation();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  (globalThis as unknown as { MediaSource?: unknown }).MediaSource = undefined;
  (globalThis as unknown as { URL?: unknown }).URL = undefined;
});

/* ───────── tests ───────── */

describe("emergency progressive stream — URL ownership", () => {
  it("keeps the ACTIVE stream URL: it is never revoked, detached or re-assigned", async () => {
    build(VP8_OPUS);

    const video = document.querySelector("video") as HTMLVideoElement;
    await waitUntil(() => (video.src ?? "").startsWith("blob:mediasource-"));

    const activeUrl = video.src;

    // Give the ready handler every chance to run.
    await new Promise((r) => setTimeout(r, 60));

    // The URL the stream attached is still there…
    expect(video.src).toBe(activeUrl);
    // …it was NEVER revoked…
    expect(revoked).not.toContain(activeUrl);
    // …and its MediaSource was not closed.
    const ms = sourcesByUrl.get(activeUrl);
    expect(ms?.readyState).not.toBe("closed");
  });

  it("does not detach the element when the stream reports ready", async () => {
    build(VP8_OPUS);

    const video = document.querySelector("video") as HTMLVideoElement;
    await waitUntil(() => (video.src ?? "").startsWith("blob:mediasource-"));

    const activeUrl = video.src;
    await new Promise((r) => setTimeout(r, 60));

    expect(video.hasAttribute("src")).toBe(true);
    expect(video.getAttribute("src")).toBe(activeUrl);
  });
});

describe("emergency fallback — previous released, current kept", () => {
  it("revokes the failed MediaSource URL but keeps the Blob it falls back to", async () => {
    // The MSE layer rejects the type → the bounded Blob fallback runs.
    addSourceBufferThrows = true;

    build(VP8_OPUS);

    const video = document.querySelector("video") as HTMLVideoElement;

    await waitUntil(() => (video.src ?? "").startsWith("blob:object-"));

    const blobUrl = video.src;

    // The failed MediaSource URL was released by the stream…
    expect(revoked.some((u) => u.startsWith("blob:mediasource-"))).toBe(true);
    // …the Blob the fallback produced is attached and still live…
    expect(blobUrl.startsWith("blob:object-")).toBe(true);
    expect(revoked).not.toContain(blobUrl);
    // …and the element carries it.
    expect(video.getAttribute("src")).toBe(blobUrl);
  });

  it("a non-streamable MIME attaches the Blob exactly once", async () => {
    mseSupports = () => false;

    build("video/webm");

    const video = document.querySelector("video") as HTMLVideoElement;
    await waitUntil(() => (video.src ?? "").startsWith("blob:object-"));

    const blobUrl = video.src;
    await new Promise((r) => setTimeout(r, 60));

    expect(video.src).toBe(blobUrl);
    expect(revoked).not.toContain(blobUrl);
    expect(revoked.some((u) => u.startsWith("blob:mediasource-"))).toBe(false);
  });
});

describe("emergency failure path — no leaks, no double cleanup", () => {
  it("a read failure terminates without revoking a URL twice", async () => {
    vi.mocked(storage.downloadRange).mockRejectedValue(
      new Error("[AETERNA] Range read failed")
    );

    const { status } = build(VP8_OPUS);

    await waitUntil(() => status.textContent.length > 0);

    // Every revoked URL is revoked at most once.
    const counts = new Map<string, number>();
    for (const u of revoked) counts.set(u, (counts.get(u) ?? 0) + 1);
    for (const [, n] of counts) expect(n).toBe(1);

    const video = document.querySelector("video") as HTMLVideoElement;
    // The element is not left pointing at a revoked URL.
    if (video.src) expect(revoked).not.toContain(video.src);
  });
});

describe("detach watchdog — MutationObserver configuration", () => {
  it("builds the A/V surface without throwing (the old config threw a TypeError)", () => {
    // `observe(root, { subtree: false })` threw here, which escaped
    // renderEmergencyVault and surfaced as "Capsule unavailable.".
    expect(() => build(VP8_OPUS)).not.toThrow();
  });

  it("detects `root` being detached and runs cleanup", async () => {
    const disconnectSpy = vi.spyOn(MutationObserver.prototype, "disconnect");

    const { root } = build(VP8_OPUS);

    const video = document.querySelector("video") as HTMLVideoElement;
    await waitUntil(() => (video.src ?? "").startsWith("blob:mediasource-"));

    // The surface is live and the observer watches the PARENT.
    expect(root.isConnected).toBe(true);
    expect(root.parentNode).toBe(document.body);

    // Detaching `root` is recorded on the parent's childList — the
    // observer must notice it and tear down.
    root.remove();
    await new Promise((r) => setTimeout(r, 30));

    expect(disconnectSpy).toHaveBeenCalled();

    disconnectSpy.mockRestore();
  });

  it("does NOT tear down while root stays connected", async () => {
    const disconnectSpy = vi.spyOn(MutationObserver.prototype, "disconnect");

    const { root } = build(VP8_OPUS);

    await waitUntil(() =>
      (document.querySelector("video")?.src ?? "").startsWith(
        "blob:mediasource-"
      )
    );

    // A child mutation that leaves `root` connected must not tear down.
    root.appendChild(document.createElement("span"));
    await new Promise((r) => setTimeout(r, 30));

    expect(root.isConnected).toBe(true);
    expect(disconnectSpy).not.toHaveBeenCalled();

    disconnectSpy.mockRestore();
  });
});

/* =========================================================
 * cryptoKey passthrough — regression
 *
 * The Emergency Runtime used to pass `null as unknown as CryptoKey`
 * to `createEmergencyMediaSession`, so `decryptChunk` rejected
 * every read with SEALED_ERROR before `sourceopen` was reached.
 * These tests verify the real key reaches the session.
 * ========================================================= */
describe("cryptoKey passthrough — real key reaches the media session", () => {
  it("passes the cryptoKey to decryptChunk (not null/undefined)", async () => {
    build(VP8_OPUS);

    await waitUntil(() =>
      (document.querySelector("video")?.src ?? "").startsWith("blob:mediasource-")
    );

    // decryptChunk is called inside the streaming loop AFTER
    // sourceopen; give the stream a moment to start reading.
    await new Promise((r) => setTimeout(r, 60));

    // decryptChunk was called with a truthy key — not null.
    const calls = vi.mocked(decryptChunk).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const keyArg = calls[0]?.[1];
    expect(keyArg).toBeTruthy();
    expect(keyArg).not.toBeNull();
  });

  it("a read failure leaves the unavailable message visible and does not report success", async () => {
    vi.mocked(decryptChunk).mockRejectedValue(
      new Error("[AETERNA] Capsule sealed.")
    );

    const { status } = build(VP8_OPUS);

    await waitUntil(() => status.textContent.length > 0);

    const video = document.querySelector("video") as HTMLVideoElement;
    // No object URL was assigned.
    expect((video.src ?? "")).not.toMatch(/^blob:mediasource-/);
    // Status shows a failure, not "opened".
    expect(status.textContent).not.toContain("opened");
  });

  it("hides the 'Preview unavailable' element when the stream succeeds", async () => {
    const root = document.createElement("div");
    const status = document.createElement("div");
    document.body.appendChild(root);
    document.body.appendChild(status);

    const unavailable = document.createElement("div");
    unavailable.className = "media-unavail";
    unavailable.textContent = "Preview unavailable — media recovery coming in next layer";
    unavailable.style.display = "";
    document.body.appendChild(unavailable);

    buildEmergencyMediaElement({
      root,
      status,
      item: {
        mediaType: "video",
        filename: "v.webm",
        mimeType: VP8_OPUS,
        size: SIZE,
        createdAt: "2026-01-01T00:00:00.000Z",
      } as never,
      capsuleId: CAPSULE_ID,
      chunks: [makeChunk()],
      resolvedChunks: [makePublished()],
      cryptoKey: {} as CryptoKey,
      mediaType: "video",
      mimeType: VP8_OPUS,
      size: SIZE,
      unavailableEl: unavailable,
    });

    const video = document.querySelector("video") as HTMLVideoElement;
    await waitUntil(() => (video.src ?? "").startsWith("blob:mediasource-"));

    // Give the onStreamReady callback a chance.
    await new Promise((r) => setTimeout(r, 60));

    expect(unavailable.style.display).toBe("none");
  });

  it("keeps the 'Preview unavailable' element visible on a read failure", async () => {
    vi.mocked(decryptChunk).mockRejectedValue(
      new Error("[AETERNA] Capsule sealed.")
    );

    const root = document.createElement("div");
    const status = document.createElement("div");
    document.body.appendChild(root);
    document.body.appendChild(status);

    const unavailable = document.createElement("div");
    unavailable.className = "media-unavail";
    unavailable.textContent = "Preview unavailable — media recovery coming in next layer";
    unavailable.style.display = "";
    document.body.appendChild(unavailable);

    buildEmergencyMediaElement({
      root,
      status,
      item: {
        mediaType: "video",
        filename: "v.webm",
        mimeType: VP8_OPUS,
        size: SIZE,
        createdAt: "2026-01-01T00:00:00.000Z",
      } as never,
      capsuleId: CAPSULE_ID,
      chunks: [makeChunk()],
      resolvedChunks: [makePublished()],
      cryptoKey: {} as CryptoKey,
      mediaType: "video",
      mimeType: VP8_OPUS,
      size: SIZE,
      unavailableEl: unavailable,
    });

    await waitUntil(() => status.textContent.length > 0, 2000);

    // Still visible — no success to hide it.
    expect(unavailable.style.display).not.toBe("none");
  });
});
