// @vitest-environment jsdom
/**
 * R9-A86.2 — multi-video lazy initialization and single-active-video
 * ownership.
 *
 * These tests exercise the ACTUAL asynchronous lifecycle — session open,
 * byte reads, dispose, URL creation and revocation — through the event
 * log, not just rendered button visibility:
 *
 *   1.  Opening a two-video capsule creates zero video sessions.
 *   2.  Opening creates zero video byte reads.
 *   3.  Opening creates zero media buffers or Blob URLs.
 *   4.  Selecting video 1 initializes only video 1.
 *   5.  Video 2 remains idle while video 1 plays.
 *   6.  Switching to video 2 disposes video 1 BEFORE initializing video 2.
 *   7.  Rapid switching cannot leave multiple active sessions.
 *   8.  A stale async initialization cannot reactivate a disposed player.
 *   9.  Closing the capsule releases all active sessions.
 *   10. Reopening a capsule starts with both videos idle.
 *   11. One-video capsules still work.
 *   12. Both videos in a two-video capsule can be played individually.
 *   13. Existing image, audio, text and ZIP behaviour remains unchanged.
 *   14. iOS fallback remains compatible with its existing supported limits
 *       (≤ 25 MiB Blob fallback still loads; > 25 MiB still fails closed
 *       with an explicit retry).
 *
 * The openRuntime layer is mocked; URL.createObjectURL is stubbed with a
 * counting implementation. jsdom has no MediaSource, so lifecycle tests
 * exercise the bounded whole-file Blob fallback path — the same
 * component-level open → read → settle → dispose lifecycle as the MSE
 * path. One MSE-path switching test installs the same MediaSource
 * instrumentation as VaultRenderer.media.test.tsx to prove the
 * dispose-before-open ordering on the progressive path too.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, act, fireEvent } from "@testing-library/react";

vi.mock("@/lib/capsule/open/openRuntime", () => ({
  openImage: vi.fn(),
  openVideo: vi.fn(),
  openAudio: vi.fn(),
  downloadFile: vi.fn(),
}));

import VaultRenderer from "@/pages/capsule/VaultRenderer";
import * as openRuntime from "@/lib/capsule/open/openRuntime";

/* ------------------------------------------------------------------ */
/* Event log + fakes                                                    */
/* ------------------------------------------------------------------ */

let events: string[];
let urlSeq: number;
let createdUrls: string[];
let revokedUrls: string[];
let mediaSourceConstructions: number;

function recordingUrlStub(): void {
  vi.stubGlobal("URL", {
    createObjectURL: (obj: unknown) => {
      // MediaSource instances get a distinguishable prefix when a test
      // stubs the MediaSource global; anything else is an object/Blob URL.
      const isMs =
        typeof obj === "object" &&
        obj !== null &&
        "addSourceBuffer" in (obj as Record<string, unknown>);
      const url = isMs
        ? `blob:mediasource-${++urlSeq}`
        : `blob:object-${++urlSeq}`;
      createdUrls.push(url);
      events.push(`create:${url}`);
      return url;
    },
    revokeObjectURL: (url: string) => {
      revokedUrls.push(url);
      events.push(`revoke:${url}`);
    },
  });
}

function recordingMediaSourceStub(supports = true): void {
  class RecordingMediaSource extends EventTarget {
    static isTypeSupported(): boolean {
      return supports;
    }
    addSourceBuffer(): EventTarget {
      return new EventTarget();
    }
    endOfStream(): void {}
    constructor() {
      super();
      mediaSourceConstructions += 1;
    }
  }
  vi.stubGlobal("MediaSource", RecordingMediaSource);
}

function makeSession(name: string) {
  return {
    read: vi.fn(() => {
      events.push(`read:${name}`);
      return Promise.resolve(new Uint8Array(8));
    }),
    dispose: vi.fn(() => {
      events.push(`dispose:${name}`);
    }),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
} {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                             */
/* ------------------------------------------------------------------ */

function makeVault(mediaItems: unknown[]): unknown {
  return {
    version: 2,
    capsule: { capsuleId: "cap-multi", items: mediaItems },
  };
}

function videoItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "media",
    mediaType: "video",
    filename: "one.webm",
    mimeType: "video/webm",
    size: 1000,
    // Empty chunks: these tests mock openRuntime, isolating component
    // lifecycle (the same isolation VaultRenderer.media.test.tsx uses).
    chunks: [],
    ...overrides,
  };
}

function audioItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "media",
    mediaType: "audio",
    filename: "clip.webm",
    mimeType: "audio/webm",
    size: 1000,
    chunks: [],
    ...overrides,
  };
}

function imageItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "media",
    mediaType: "image",
    filename: "photo.png",
    mimeType: "image/png",
    size: 1024,
    chunks: [],
    ...overrides,
  };
}

function zipItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "media",
    mediaType: "file",
    filename: "album.zip",
    mimeType: "application/x-zip-compressed",
    size: 42596,
    chunks: [],
    ...overrides,
  };
}

const fakeKey = ({} as unknown) as CryptoKey;

/** The two cards' Play controls, in vault order. */
function playButtons(): HTMLElement[] {
  return screen.getAllByRole("button", { name: "Play video" });
}

async function clickPlayAt(index: number): Promise<void> {
  const button = playButtons()[index];
  if (!button) {
    throw new Error(`no Play video control at index ${index}`);
  }
  await act(async () => {
    fireEvent.click(button);
  });
}

beforeEach(() => {
  events = [];
  createdUrls = [];
  revokedUrls = [];
  urlSeq = 0;
  mediaSourceConstructions = 0;
  recordingUrlStub();
  // reset (not clear) so a previous test's unconsumed mockReturnValueOnce
  // entries can never leak into the next test's call sequence.
  vi.resetAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

/* ------------------------------------------------------------------ */
/* 1–3: opening does nothing                                            */
/* ------------------------------------------------------------------ */

describe("R9-A86.2 — opening a two-video capsule is fully lazy", () => {
  it("1/2/3: zero sessions, zero byte reads, zero Blob URLs / MediaSources on mount", async () => {
    recordingMediaSourceStub();

    render(
      <VaultRenderer
        vault={makeVault([videoItem(), videoItem({ filename: "two.webm" })]) as never}
        cryptoKey={fakeKey}
      />,
    );

    // Both items render their lazy cards…
    expect(screen.getByText("one.webm")).toBeTruthy();
    expect(screen.getByText("two.webm")).toBeTruthy();
    expect(playButtons().length).toBe(2);

    // …and NOTHING was initialized: no session, no byte read, no buffer,
    // no object URL, no MediaSource.
    expect(openRuntime.openVideo).not.toHaveBeenCalled();
    expect(events.some((e) => e.startsWith("read:"))).toBe(false);
    expect(createdUrls).toHaveLength(0);
    expect(mediaSourceConstructions).toBe(0);
    expect(document.querySelectorAll("video")).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* 4–5: selection initializes only the selected video                   */
/* ------------------------------------------------------------------ */

describe("R9-A86.2 — explicit activation initializes only the selected video", () => {
  it("4: selecting video 1 opens exactly one session for video 1", async () => {
    vi.mocked(openRuntime.openVideo).mockImplementation((request: unknown) => {
      const name = (request as { media: { filename: string } }).media.filename;
      return Promise.resolve(makeSession(name) as never);
    });

    render(
      <VaultRenderer
        vault={makeVault([videoItem(), videoItem({ filename: "two.webm" })]) as never}
        cryptoKey={fakeKey}
      />,
    );
    await clickPlayAt(0);

    expect(openRuntime.openVideo).toHaveBeenCalledTimes(1);
    expect(openRuntime.openVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        media: expect.objectContaining({ filename: "one.webm" }),
      }),
    );

    await waitFor(() => expect(document.querySelectorAll("video")).toHaveLength(1));
  });

  it("5: video 2 remains idle — no session, read or URL — while video 1 plays", async () => {
    vi.mocked(openRuntime.openVideo).mockImplementation((request: unknown) => {
      const name = (request as { media: { filename: string } }).media.filename;
      return Promise.resolve(makeSession(name) as never);
    });

    render(
      <VaultRenderer
        vault={makeVault([videoItem(), videoItem({ filename: "two.webm" })]) as never}
        cryptoKey={fakeKey}
      />,
    );
    await clickPlayAt(0);

    await waitFor(() => expect(document.querySelectorAll("video")).toHaveLength(1));
    // Let every pending microtask flush.
    await act(async () => {});

    // …video 1 read bytes; video 2 was never touched.
    expect(events.filter((e) => e.startsWith("read:one.webm")).length).toBeGreaterThan(0);
    expect(events.some((e) => e.includes("two.webm"))).toBe(false);

    // Video 2 still renders its lazy card with its Play control.
    expect(screen.getByText("two.webm")).toBeTruthy();
    expect(playButtons()).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* 6–8: switching, races, stale attempts                                */
/* ------------------------------------------------------------------ */

/**
 * R9-A86.2 — single-active ownership and disposal ordering.
 */

/** openVideo mock that logs `open:<filename>` in real call order. */
function stubOpenVideoByCall(promises: Promise<unknown>[]): void {
  vi.mocked(openRuntime.openVideo).mockImplementation((request: unknown) => {
    const name = (request as { media: { filename: string } }).media.filename;
    events.push(`open:${name}`);
    const next = promises.shift();
    if (!next) throw new Error("unexpected additional openVideo call");
    return next as never;
  });
}

describe("R9-A86.2 — single-active ownership and disposal ordering", () => {
  it("6: switching to video 2 disposes video 1 BEFORE initializing video 2", async () => {
    stubOpenVideoByCall([
      Promise.resolve(makeSession("one.webm") as never),
      Promise.resolve(makeSession("two.webm") as never),
    ]);

    render(
      <VaultRenderer
        vault={makeVault([videoItem(), videoItem({ filename: "two.webm" })]) as never}
        cryptoKey={fakeKey}
      />,
    );
    await clickPlayAt(0);
    await waitFor(() => expect(document.querySelectorAll("video")).toHaveLength(1));

    events = [];
    await clickPlayAt(0); // now the only Play button is video 2's

    await waitFor(() => expect(document.querySelectorAll("video")).toHaveLength(1));

    const disposeIdx = events.indexOf("dispose:one.webm");
    const openTwoIdx = events.indexOf("open:two.webm");
    expect(disposeIdx).toBeGreaterThanOrEqual(0);
    expect(openTwoIdx).toBeGreaterThan(disposeIdx);

    // Exactly one player: video 2's. Video 1 is back to a card.
    expect(screen.getByText("one.webm")).toBeTruthy();
    expect(playButtons()).toHaveLength(1);
    expect(events.filter((e) => e === "dispose:one.webm")).toHaveLength(1);
  });

  it("7: rapid switching leaves exactly ONE active session and disposes the losers", async () => {
    const p1 = deferred<unknown>();
    const p2 = deferred<unknown>();
    const p3 = deferred<unknown>();
    const s1 = makeSession("one.webm");
    const s2 = makeSession("two.webm");
    const s3 = makeSession("one.webm");

    // Selection order: video 1 → video 2 → video 1.
    stubOpenVideoByCall([p1.promise, p2.promise, p3.promise]);

    render(
      <VaultRenderer
        vault={makeVault([videoItem(), videoItem({ filename: "two.webm" })]) as never}
        cryptoKey={fakeKey}
      />,
    );

    // Three back-to-back selections with NO waiting between them — each in
    // its own act so every state transition commits (one batched act would
    // coalesce them into a single render). Final authority: video 1.
    await clickPlayAt(0); // select video 1  (attempt 1 hangs on openVideo)
    await clickPlayAt(0); // select video 2  (attempt 2 hangs on openVideo)
    await clickPlayAt(0); // select video 1  (attempt 3 hangs on openVideo)

    expect(vi.mocked(openRuntime.openVideo)).toHaveBeenCalledTimes(3);

    // Every attempt now resolves — including stale ones.
    await act(async () => {
      p1.resolve(s1);
      p2.resolve(s2);
      p3.resolve(s3);
    });
    await act(async () => {});

    await waitFor(() => expect(document.querySelectorAll("video")).toHaveLength(1));

    // The two superseded attempts were disposed exactly once each…
    expect(s1.dispose).toHaveBeenCalledTimes(1);
    expect(s2.dispose).toHaveBeenCalledTimes(1);
    // …and the winning attempt is still alive (it owns the player).
    expect(s3.dispose).not.toHaveBeenCalled();

    // Video 1 is the active player; video 2 shows the only Play control.
    expect(playButtons()).toHaveLength(1);
    expect(screen.getByText("two.webm")).toBeTruthy();
  });

  it("8: a stale async initialization cannot reactivate a disposed player", async () => {
    const p1 = deferred<unknown>();
    const s1 = makeSession("one.webm");
    const s2 = makeSession("two.webm");

    // Selection order: video 1 (hangs) → video 2 (instant).
    stubOpenVideoByCall([p1.promise, Promise.resolve(s2 as never)]);

    render(
      <VaultRenderer
        vault={makeVault([videoItem(), videoItem({ filename: "two.webm" })]) as never}
        cryptoKey={fakeKey}
      />,
    );

    await clickPlayAt(0); // video 1 attempt starts and hangs on openVideo
    await waitFor(() => expect(openRuntime.openVideo).toHaveBeenCalledTimes(1));

    // Switch to video 2 while video 1's attempt is still in flight.
    await clickPlayAt(0);
    await waitFor(() => expect(document.querySelectorAll("video")).toHaveLength(1));
    expect(openRuntime.openVideo).toHaveBeenCalledTimes(2);

    // NOW video 1's hanging openVideo resolves with a live session. The
    // stale-attempt guard must dispose it and write NOTHING to the UI.
    await act(async () => {
      p1.resolve(s1);
    });
    await act(async () => {});

    expect(s1.dispose).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.startsWith("read:one.webm"))).toHaveLength(0);

    // Video 2 is still the ONE active player; video 1 shows its idle card
    // (its Play control), not a resurrected player and not an error card.
    expect(document.querySelectorAll("video")).toHaveLength(1);
    expect(playButtons()).toHaveLength(1);
    expect(screen.getByText("one.webm")).toBeTruthy();
    expect(screen.queryByText(/Media preview unavailable/i)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 9–10: close/reopen                                                   */
/* ------------------------------------------------------------------ */

describe("R9-A86.2 — closing and reopening the capsule", () => {
  it("9: unmount disposes the active session and revokes its URL", async () => {
    vi.mocked(openRuntime.openVideo).mockImplementation((request: unknown) => {
      const name = (request as { media: { filename: string } }).media.filename;
      return Promise.resolve(makeSession(name) as never);
    });

    const { unmount } = render(
      <VaultRenderer
        vault={makeVault([videoItem(), videoItem({ filename: "two.webm" })]) as never}
        cryptoKey={fakeKey}
      />,
    );
    await clickPlayAt(0);
    await waitFor(() => expect(document.querySelectorAll("video")).toHaveLength(1));

    const attached = (document.querySelector("video") as HTMLVideoElement).src;
    const firstResult = vi.mocked(openRuntime.openVideo).mock.results[0];
    if (!firstResult) throw new Error("openVideo was never called");
    const session = firstResult.value as unknown as {
      dispose: ReturnType<typeof vi.fn>;
    };

    events = [];
    unmount();

    // The session is disposed and the attached object URL revoked.
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(revokedUrls).toContain(attached);
  });

  it("10: reopening the capsule starts with both videos idle", async () => {
    vi.mocked(openRuntime.openVideo).mockImplementation((request: unknown) => {
      const name = (request as { media: { filename: string } }).media.filename;
      return Promise.resolve(makeSession(name) as never);
    });

    const first = render(
      <VaultRenderer
        vault={makeVault([videoItem(), videoItem({ filename: "two.webm" })]) as never}
        cryptoKey={fakeKey}
      />,
    );
    await clickPlayAt(0);
    await waitFor(() => expect(document.querySelectorAll("video")).toHaveLength(1));
    first.unmount();

    const callsAfterFirstLife = vi.mocked(openRuntime.openVideo).mock.calls.length;
    render(
      <VaultRenderer
        vault={makeVault([videoItem(), videoItem({ filename: "two.webm" })]) as never}
        cryptoKey={fakeKey}
      />,
    );

    // Fresh mount: both cards, no player, no new session.
    expect(playButtons()).toHaveLength(2);
    expect(document.querySelectorAll("video")).toHaveLength(0);
    expect(vi.mocked(openRuntime.openVideo).mock.calls.length).toBe(callsAfterFirstLife);
  });
});

/* ------------------------------------------------------------------ */
/* 11–12: one-video and individual play                                 */
/* ------------------------------------------------------------------ */

describe("R9-A86.2 — one-video capsules and individual play", () => {
  it("11: a one-video capsule still plays after activation", async () => {
    vi.mocked(openRuntime.openVideo).mockImplementation((request: unknown) => {
      const name = (request as { media: { filename: string } }).media.filename;
      return Promise.resolve(makeSession(name) as never);
    });

    render(
      <VaultRenderer vault={makeVault([videoItem()]) as never} cryptoKey={fakeKey} />,
    );
    await clickPlayAt(0);

    await waitFor(() => expect(document.querySelectorAll("video")).toHaveLength(1));
    const vid = document.querySelector("video") as HTMLVideoElement;
    expect(vid.src).toContain("blob:object-");
  });

  it("12: both videos of a two-video capsule can be played individually", async () => {
    vi.mocked(openRuntime.openVideo).mockImplementation((request: unknown) => {
      const name = (request as { media: { filename: string } }).media.filename;
      return Promise.resolve(makeSession(name) as never);
    });

    render(
      <VaultRenderer
        vault={makeVault([videoItem(), videoItem({ filename: "two.webm" })]) as never}
        cryptoKey={fakeKey}
      />,
    );

    // Play video 1 to completion.
    await clickPlayAt(0);
    await waitFor(() => expect(document.querySelectorAll("video")).toHaveLength(1));
    expect(events.filter((e) => e === "read:one.webm").length).toBeGreaterThan(0);

    // Switch to video 2: video 1 is disposed, video 2 plays.
    await clickPlayAt(0);
    await waitFor(() => {
      expect(events).toContain("dispose:one.webm");
      expect(events).toContain("read:two.webm");
    });
    expect(document.querySelectorAll("video")).toHaveLength(1);

    // Switch back to video 1: video 2 is disposed, video 1 replays with a
    // FRESH attempt (a disposed session never resumes; it re-opens).
    const opensBefore = vi.mocked(openRuntime.openVideo).mock.calls.length;
    await clickPlayAt(0);
    await waitFor(() => {
      expect(events).toContain("dispose:two.webm");
      expect(vi.mocked(openRuntime.openVideo).mock.calls.length).toBe(opensBefore + 1);
    });
    expect(events.filter((e) => e === "read:one.webm").length).toBeGreaterThan(0);
    expect(document.querySelectorAll("video")).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* 13: non-video behaviour unchanged                                    */
/* ------------------------------------------------------------------ */

describe("R9-A86.2 — non-video items keep their mount-time behaviour", () => {
  it("13: image + audio still auto-initialize on mount; text renders; ZIP stays manual", async () => {
    vi.mocked(openRuntime.openImage).mockResolvedValue({
      objectUrl: "blob:img",
    } as never);
    vi.mocked(openRuntime.openAudio).mockImplementation((request: unknown) => {
      const name = (request as { media: { filename: string } }).media.filename;
      return Promise.resolve(makeSession(name) as never);
    });

    render(
      <VaultRenderer
        vault={
          makeVault([
            { type: "text", text: "Hello capsule" },
            imageItem(),
            audioItem(),
            zipItem(),
          ]) as never
        }
        cryptoKey={fakeKey}
      />,
    );

    // Text is immediate.
    expect(screen.getByText("Hello capsule")).toBeTruthy();

    // Image and audio AUTO-initialize on mount (unchanged).
    await waitFor(() => expect(document.querySelector("img")).not.toBeNull());
    await waitFor(() => expect(document.querySelector("audio")).not.toBeNull());
    expect(openRuntime.openImage).toHaveBeenCalledTimes(1);
    expect(openRuntime.openAudio).toHaveBeenCalledTimes(1);

    // The ZIP card is metadata-only and downloads nothing.
    expect(screen.getByText("album.zip")).toBeTruthy();
    expect(openRuntime.downloadFile).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /Download file/i }),
    ).toBeTruthy();

    // And no video item exists to activate — the zero-video invariant.
    expect(openRuntime.openVideo).not.toHaveBeenCalled();
    expect(screen.queryAllByRole("button", { name: "Play video" })).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* 14: iOS fallback limits preserved                                    */
/* ------------------------------------------------------------------ */

describe("R9-A86.2 — the bounded Blob fallback keeps its existing limits", () => {
  it("14a: a fallback-eligible video (≤ 25 MiB) still loads through the fallback on activation", async () => {
    recordingMediaSourceStub(false); // capability rejection → Blob fallback
    vi.mocked(openRuntime.openVideo).mockImplementation((request: unknown) => {
      const name = (request as { media: { filename: string } }).media.filename;
      return Promise.resolve(makeSession(name) as never);
    });

    render(
      <VaultRenderer vault={makeVault([videoItem()]) as never} cryptoKey={fakeKey} />,
    );

    // Lazy until activation…
    expect(mediaSourceConstructions).toBe(0);

    await clickPlayAt(0);
    await waitFor(() => expect(document.querySelectorAll("video")).toHaveLength(1));

    // …then the capability probe rejected the type (so NO MediaSource was
    // ever constructed) and exactly ONE bounded fallback Blob was made.
    expect(mediaSourceConstructions).toBe(0);
    expect(createdUrls.filter((u) => u.startsWith("blob:object-"))).toHaveLength(1);
  });

  it("14b: a > 25 MiB non-streamable video fails closed with an explicit retry", async () => {
    const size = 26 * 1024 * 1024;
    vi.mocked(openRuntime.openVideo).mockImplementation(() =>
      Promise.resolve(makeSession("big.webm") as never),
    );

    render(
      <VaultRenderer
        vault={makeVault([videoItem({ size })]) as never}
        cryptoKey={fakeKey}
      />,
    );
    await clickPlayAt(0);

    // Terminal, visible, and actionable — never an infinite Loading. The
    // classifier renders its safe diagnostic code plus the fallback
    // trigger; the raw oversize text is never leaked.
    await waitFor(() => expect(screen.queryByText(/Loading/i)).toBeNull());
    expect(screen.getByText(/PREVIEW_READ_FAILED/)).toBeTruthy();
    expect(screen.getByText(/Fallback reason/i)).toBeTruthy();
    expect(screen.queryByText(/Media too large/)).toBeNull();
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry).toBeTruthy();

    // Retry re-runs the attempt through the normal lifecycle.
    await act(async () => {
      fireEvent.click(retry);
    });
    await waitFor(() => expect(openRuntime.openVideo).toHaveBeenCalledTimes(2));
  });

  it("14c: switching on the MSE path also disposes before opening", async () => {
    /**
     * Same instrumentation as VaultRenderer.media.test.tsx: a stubbed
     * MediaSource whose object URL opens on element attachment. This
     * proves the dispose-before-open ordering holds on the progressive
     * path, not only on the fallback path.
     */
    class FakeSourceBuffer extends EventTarget {
      appendBuffer(): void {
        queueMicrotask(() => this.dispatchEvent(new Event("updateend")));
      }
    }
    class FakeMediaSource extends EventTarget {
      static isTypeSupported(): boolean {
        return true;
      }
      readyState: "closed" | "open" | "ended" = "closed";
      addSourceBuffer(): FakeSourceBuffer {
        return new FakeSourceBuffer();
      }
      endOfStream(): void {
        this.readyState = "ended";
      }
    }

    const sourcesByUrl = new Map<string, FakeMediaSource>();
    const proto = HTMLMediaElement.prototype;
    const originalSrc = Object.getOwnPropertyDescriptor(proto, "src");
    Object.defineProperty(proto, "src", {
      configurable: true,
      get(this: HTMLMediaElement & { __src?: string }) {
        return this.__src ?? "";
      },
      set(this: HTMLMediaElement & { __src?: string }, value: string) {
        this.__src = String(value);
        const ms = sourcesByUrl.get(String(value));
        if (ms && ms.readyState === "closed") {
          ms.readyState = "open";
          queueMicrotask(() => ms.dispatchEvent(new Event("sourceopen")));
        }
      },
    });

    try {
      vi.stubGlobal("MediaSource", FakeMediaSource);
      vi.stubGlobal("URL", {
        createObjectURL: (obj: unknown) => {
          const url = `blob:u${++urlSeq}`;
          createdUrls.push(url);
          events.push(`create:${url}`);
          if (obj instanceof FakeMediaSource) sourcesByUrl.set(url, obj);
          return url;
        },
        revokeObjectURL: (url: string) => {
          revokedUrls.push(url);
          events.push(`revoke:${url}`);
        },
      });

      vi.mocked(openRuntime.openVideo).mockImplementation((request: unknown) => {
        const name = (request as { media: { filename: string } }).media.filename;
        events.push(`open:${name}`);
        return Promise.resolve(makeSession(name) as never);
      });

      render(
        <VaultRenderer
          vault={
            makeVault([
              videoItem({
                mimeType: "video/webm;codecs=vp8,opus",
                size: 32,
              }),
              videoItem({
                filename: "two.webm",
                mimeType: "video/webm;codecs=vp8,opus",
                size: 32,
              }),
            ]) as never
          }
          cryptoKey={fakeKey}
        />,
      );

      await clickPlayAt(0);
      await waitFor(() => {
        const v = document.querySelector("video") as HTMLVideoElement | null;
        expect(v?.src ?? "").toMatch(/^blob:u/);
      });

      events = [];
      await clickPlayAt(0); // switch to video 2

      await waitFor(() => expect(events).toContain("read:two.webm"));

      // Dispose of video 1 strictly before video 2's session opened.
      const disposeIdx = events.indexOf("dispose:one.webm");
      const openTwoIdx = events.indexOf("open:two.webm");
      expect(disposeIdx).toBeGreaterThanOrEqual(0);
      expect(openTwoIdx).toBeGreaterThan(disposeIdx);

      // The abandoned MediaSource URL was revoked during teardown.
      expect(events.some((e) => e.startsWith("revoke:"))).toBe(true);
      expect(document.querySelectorAll("video")).toHaveLength(1);
    } finally {
      if (originalSrc) {
        Object.defineProperty(proto, "src", originalSrc);
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* R9-A89.1 — prominent video card presentation and controls            */
/* ------------------------------------------------------------------ */

describe("R9-A89.1 — prominent video card presentation", () => {
  function renderVideos(items: unknown[] = [videoItem(), videoItem({ filename: "two.webm" })]) {
    return render(
      <VaultRenderer vault={makeVault(items) as never} cryptoKey={fakeKey} />,
    );
  }

  it("1: renders a visible gold VIDEO badge for every video item", () => {
    renderVideos();

    const badges = screen.getAllByText("VIDEO");
    expect(badges).toHaveLength(2);

    for (const badge of badges) {
      expect(badge.className).toContain("border-accent/40");
      expect(badge.className).toContain("bg-accent/10");
      expect(badge.className).toContain("text-amber-700");
      expect(badge.className).toContain("dark:text-amber-300");
    }
  });

  it("2: renders Play video as a semantic button, not a text link", () => {
    renderVideos();

    const buttons = playButtons();
    expect(buttons).toHaveLength(2);

    for (const button of buttons) {
      expect(button.tagName).toBe("BUTTON");
      expect(button.getAttribute("type")).toBe("button");
    }

    expect(screen.queryByRole("link", { name: "Play video" })).toBeNull();
  });

  it("3: Play video uses the gold capsule styling and visible hover/focus states", () => {
    renderVideos();

    const button = playButtons()[0];
    expect(button).toBeTruthy();

    expect(button!.className).toContain("bg-gradient-to-r");
    expect(button!.className).toContain("from-amber-600");
    expect(button!.className).toContain("via-yellow-500");
    expect(button!.className).toContain("to-amber-600");
    expect(button!.className).toContain("text-slate-900");
    expect(button!.className).toContain("hover:shadow-xl");
    expect(button!.className).toContain("focus-visible:ring-2");
    expect(button!.className).toContain("focus-visible:ring-ring");
  });

  it("4: Play video has a 48px touch target and fits narrow screens", () => {
    renderVideos();

    const button = playButtons()[0];
    expect(button).toBeTruthy();

    expect(button!.className).toContain("h-12");
    expect(button!.className).toContain("min-h-12");
    expect(button!.className).toContain("w-full");
    expect(button!.className).toContain("sm:w-auto");
  });

  it("5: pressing Play activates the correct video item", async () => {
    vi.mocked(openRuntime.openVideo).mockImplementation((request: unknown) => {
      const name = (request as { media: { filename: string } }).media.filename;
      return Promise.resolve(makeSession(name) as never);
    });

    renderVideos();

    await clickPlayAt(1);

    expect(openRuntime.openVideo).toHaveBeenCalledTimes(1);
    expect(openRuntime.openVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        media: expect.objectContaining({ filename: "two.webm" }),
      }),
    );
    await waitFor(() => expect(document.querySelectorAll("video")).toHaveLength(1));
  });

  it("6: loads no video media automatically before Play is pressed", () => {
    renderVideos();

    expect(openRuntime.openVideo).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(createdUrls).toHaveLength(0);
    expect(document.querySelectorAll("video")).toHaveLength(0);
  });

  it("7: pressing Play begins the established lazy loading path", async () => {
    vi.mocked(openRuntime.openVideo).mockImplementation((request: unknown) => {
      const name = (request as { media: { filename: string } }).media.filename;
      return Promise.resolve(makeSession(name) as never);
    });

    renderVideos();
    await clickPlayAt(0);

    expect(openRuntime.openVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        media: expect.objectContaining({ filename: "one.webm" }),
      }),
    );
    await waitFor(() => expect(document.querySelectorAll("video")).toHaveLength(1));

    expect(events.some((event) => event.startsWith("read:one.webm"))).toBe(true);
    expect(createdUrls.length).toBeGreaterThan(0);
  });

  it("8: a second Play disposes the first player before activating the second", async () => {
    const first = makeSession("one.webm");
    const second = makeSession("two.webm");
    stubOpenVideoByCall([
      Promise.resolve(first as never),
      Promise.resolve(second as never),
    ]);

    renderVideos();

    await clickPlayAt(0);
    await waitFor(() => expect(document.querySelectorAll("video")).toHaveLength(1));

    events = [];
    await clickPlayAt(0);
    await waitFor(() => expect(document.querySelectorAll("video")).toHaveLength(1));

    const disposeIdx = events.indexOf("dispose:one.webm");
    const openTwoIdx = events.indexOf("open:two.webm");

    expect(disposeIdx).toBeGreaterThanOrEqual(0);
    expect(openTwoIdx).toBeGreaterThan(disposeIdx);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(second.dispose).not.toHaveBeenCalled();
  });

  it("9: keeps exactly one active player and one remaining card", async () => {
    const first = makeSession("one.webm");
    const second = makeSession("two.webm");
    stubOpenVideoByCall([
      Promise.resolve(first as never),
      Promise.resolve(second as never),
    ]);

    renderVideos();

    await clickPlayAt(0);
    await waitFor(() => expect(document.querySelectorAll("video")).toHaveLength(1));

    await clickPlayAt(0);
    await waitFor(() => expect(document.querySelectorAll("video")).toHaveLength(1));

    expect(openRuntime.openVideo).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll("video")).toHaveLength(1);
    expect(screen.getAllByText("VIDEO")).toHaveLength(1);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(second.dispose).not.toHaveBeenCalled();
  });

  it("10: unmount still disposes the active session and revokes its URL", async () => {
    vi.mocked(openRuntime.openVideo).mockImplementation((request: unknown) => {
      const name = (request as { media: { filename: string } }).media.filename;
      return Promise.resolve(makeSession(name) as never);
    });

    const { unmount } = renderVideos();
    await clickPlayAt(0);
    await waitFor(() => expect(document.querySelectorAll("video")).toHaveLength(1));

    const attached = (document.querySelector("video") as HTMLVideoElement).src;
    const firstResult = vi.mocked(openRuntime.openVideo).mock.results[0];
    if (!firstResult) throw new Error("openVideo was never called");

    const session = firstResult.value as unknown as {
      dispose: ReturnType<typeof vi.fn>;
    };

    events = [];
    unmount();

    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(revokedUrls).toContain(attached);
  });

  it("11: keeps the filename and technical metadata visible", () => {
    renderVideos([
      videoItem({
        filename: "clip.mp4",
        mimeType: "video/mp4",
        size: 12345,
      }),
    ]);

    expect(screen.getByText("clip.mp4")).toBeTruthy();
    expect(screen.getByText(/video\/mp4/)).toBeTruthy();
    expect(screen.getByText(/12345 bytes/)).toBeTruthy();
    expect(screen.getByText("VIDEO")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Play video" })).toBeTruthy();
  });

  it("12: long filenames and narrow layouts stay contained", () => {
    const longFilename = `${"a-very-long-video-filename-".repeat(8)}clip.webm`;

    renderVideos([videoItem({ filename: longFilename })]);

    const filename = screen.getByText(longFilename);
    expect(filename.className).toContain("break-all");
    expect(filename.className).toContain("min-w-0");

    const badge = screen.getByText("VIDEO");
    expect(badge.parentElement?.className).toContain("flex-wrap");
    expect(badge.parentElement?.className).toContain("items-center");
    expect(badge.parentElement?.className).toContain("gap-2");

    const button = playButtons()[0];
    expect(button).toBeTruthy();
    expect(button!.className).toContain("w-full");
    expect(button!.className).toContain("sm:w-auto");
    expect(screen.getByRole("button", { name: "Play video" })).toBeTruthy();
  });
});
