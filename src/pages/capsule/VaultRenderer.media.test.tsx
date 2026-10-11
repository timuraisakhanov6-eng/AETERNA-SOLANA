// @vitest-environment jsdom
/**
 * Component-level regression tests for `MediaItemV2Block` (VaultRenderer).
 *
 * Task section 7 #2, #3, #4, #5, #10:
 *  - #2  effect cleanup during load -> a cancelled attempt must not block a
 *        later attempt.
 *  - #3  same-signature retry after cancellation/failure -> reload starts.
 *  - #4  a stale attempt cannot overwrite a newer attempt's state.
 *  - #5  `session.dispose()` throwing still reaches a terminal state.
 *  - #10 mixed text + media -> text shows, video gets a source and proceeds
 *        to playback or a terminal error.
 *
 * The openRuntime layer is mocked; `URL.createObjectURL` is stubbed. No real
 * network, no real decryption, no capability secrets. With `MediaSource`
 * left undefined, a bare `video/webm` exercises the bounded whole-file
 * fallback path (the legacy-WebM path from #7).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";

vi.mock("@/lib/capsule/open/openRuntime", () => ({
  openImage: vi.fn(),
  openVideo: vi.fn(),
  openAudio: vi.fn(),
  downloadFile: vi.fn(),
}));

import VaultRenderer, {
  sessionToDownloadStream,
} from "@/pages/capsule/VaultRenderer";
import * as openRuntime from "@/lib/capsule/open/openRuntime";
import { MediaPreviewTooLargeError, MediaPreviewConstructionError } from "@/lib/capsule/open/mediaPreviewPolicy";

function makeVault(mediaItems: unknown[]): unknown {
  return {
    version: 2,
    capsule: { capsuleId: "cap-1", items: mediaItems },
  };
}

function videoItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "media",
    mediaType: "video",
    filename: "video.webm",
    mimeType: "video/webm",
    size: 1000,
    // Empty chunks: these lifecycle tests mock openVideo/openRuntime, so the
    // container-resolution (fail-closed) path is intentionally bypassed. This
    // isolates the loading/terminal-state behaviour the task targets.
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

const fakeKey = ({} as unknown) as CryptoKey;

function stubUrl(): void {
  vi.stubGlobal("URL", {
    createObjectURL: () => "blob:fake-url",
    revokeObjectURL: () => {},
  });
}

function okSession() {
  return {
    read: () => Promise.resolve(new Uint8Array(8)),
    dispose: vi.fn(),
  };
}

beforeEach(() => {
  stubUrl();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  cleanup();
});

describe("MediaItemV2Block lifecycle", () => {
  it("#10: mixed text + media renders text and reaches a terminal media state", async () => {
    vi.mocked(openRuntime.openVideo).mockResolvedValue(okSession() as never);
    const vault = makeVault([
      { type: "text", text: "Hello capsule" },
      videoItem(),
    ]);
    render(<VaultRenderer vault={vault as never} cryptoKey={fakeKey} />);

    // Text renders independently and immediately.
    expect(screen.getByText("Hello capsule")).toBeTruthy();

    // Video starts in Loading...
    expect(screen.getByText(/Loading video\.webm/i)).toBeTruthy();

    // ...then settles to a media element (not an infinite spinner).
    await waitFor(() => expect(screen.queryByText(/Loading/i)).toBeNull());
    const vid = document.querySelector("video");
    expect(vid).not.toBeNull();
    expect((vid as HTMLVideoElement).src).toContain("blob");
  });

  it("#5: a throwing session.dispose() does not suppress the terminal error", async () => {
    const session = {
      read: () => Promise.reject(new Error("decrypt fail")),
      dispose: () => {
        throw new Error("dispose boom");
      },
    };
    vi.mocked(openRuntime.openVideo).mockResolvedValue(session as never);
    render(
      <VaultRenderer vault={makeVault([videoItem()]) as never} cryptoKey={fakeKey} />,
    );

    await waitFor(() => expect(screen.queryByText(/Loading/i)).toBeNull());
    // jsdom has no MediaSource, so this bare WebM first hits the
    // capability gate and enters the bounded Blob fallback; the read
    // then fails, so the final stage is a fallback read failure.
    expect(screen.getByText(/PREVIEW_READ_FAILED/)).toBeTruthy();
  });

  it("#2/#3: a cancelled in-flight attempt does not block a later attempt", async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    const first = new Promise<unknown>((r) => {
      resolveFirst = r;
    });
    vi.mocked(openRuntime.openVideo)
      .mockReturnValueOnce(first as never)
      .mockResolvedValueOnce(okSession() as never);

    const { unmount } = render(
      <VaultRenderer vault={makeVault([videoItem()]) as never} cryptoKey={fakeKey} />,
    );

    // Attempt 1 is in flight (never resolves on its own).
    await waitFor(() => expect(openRuntime.openVideo).toHaveBeenCalledTimes(1));

    // Unmount cancels attempt 1.
    unmount();
    resolveFirst(okSession());

    // Remount -> attempt 2 must start (openVideo called again).
    render(
      <VaultRenderer vault={makeVault([videoItem()]) as never} cryptoKey={fakeKey} />,
    );
    await waitFor(() => expect(openRuntime.openVideo).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/Loading/i)).toBeNull());
    expect(document.querySelector("video")).not.toBeNull();
  });

  it("#4: a stale attempt cannot overwrite a newer attempt's state", async () => {
    // attempt1's read resolves LATE (after attempt2 settles). The legacy
    // fallback path is not signal-cancelled, so attempt1 keeps running
    // after the dep change and must be ignored by the generation guard.
    let resolveLate: (v: Uint8Array<ArrayBuffer>) => void = () => {};
    const lateRead = new Promise<Uint8Array<ArrayBuffer>>((r) => {
      resolveLate = r;
    });
    const session1 = { read: () => lateRead, dispose: vi.fn() };
    const session2 = okSession();

    vi.mocked(openRuntime.openVideo)
      .mockReturnValueOnce(session1 as never)
      .mockResolvedValueOnce(session2 as never);

    const { rerender } = render(
      <VaultRenderer vault={makeVault([videoItem()]) as never} cryptoKey={fakeKey} />,
    );

    // Attempt 1 is in flight awaiting its late read.
    await waitFor(() => expect(openRuntime.openVideo).toHaveBeenCalledTimes(1));

    // Change a dep -> cleanup attempt 1, start attempt 2.
    rerender(
      <VaultRenderer
        vault={makeVault([videoItem()]) as never}
        cryptoKey={({} as unknown) as CryptoKey}
      />,
    );

    // Attempt 2 settles to a working video element.
    await waitFor(() => expect(document.querySelector("video")).not.toBeNull());

    // Now attempt 1's late read resolves; its settle must be ignored.
    resolveLate(new Uint8Array(8) as Uint8Array<ArrayBuffer>);
    await new Promise((r) => setTimeout(r, 30));

    // The newer attempt's video is still shown; no error leaked from
    // attempt 1 — so no diagnostic card is rendered at all.
    expect(screen.queryByText(/Media preview unavailable/i)).toBeNull();
    const vid = document.querySelector("video");
    expect(vid).not.toBeNull();
    expect((vid as HTMLVideoElement).src).toContain("blob");
  });

  it("#7: after a terminal failure a same-signature rerun retries and can succeed", async () => {
    const bad = {
      read: () => Promise.reject(new Error("decrypt fail")),
      dispose: vi.fn(),
    };
    vi.mocked(openRuntime.openVideo)
      .mockResolvedValueOnce(bad as never)
      .mockResolvedValueOnce(okSession() as never);

    const { rerender } = render(
      <VaultRenderer vault={makeVault([videoItem()]) as never} cryptoKey={fakeKey} />,
    );

    // Attempt 1 fails terminally: capability gate -> fallback -> read fails.
    await waitFor(() =>
      expect(screen.getByText(/PREVIEW_READ_FAILED/)).toBeTruthy(),
    );

    // ...and must NOT permanently suppress a same-signature retry: a
    // dependency change re-runs the effect and starts a fresh attempt.
    rerender(
      <VaultRenderer
        vault={makeVault([videoItem()]) as never}
        cryptoKey={({} as unknown) as CryptoKey}
      />,
    );

    await waitFor(() => expect(document.querySelector("video")).not.toBeNull());
  });
});

describe("#3: sessionToDownloadStream reads are bounded", () => {
  it("a stalled chunk read rejects (no hang) instead of leaving the UI waiting", async () => {
    vi.useFakeTimers();
    const session = {
      read: () => new Promise<Uint8Array<ArrayBuffer>>(() => {}),
      dispose: vi.fn(),
    };
    // jsdom has no showSaveFilePicker → the bounded fallback path runs.
    const p = sessionToDownloadStream(
      session as never,
      100,
      "video/webm",
      "a.bin",
    );
    const assertion = expect(p).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(31_000);
    await assertion;
    vi.useRealTimers();
  });

  it("a rejecting chunk read still disposes the session", async () => {
    const dispose = vi.fn();
    const session = {
      read: () => Promise.reject(new Error("range fetch failed")),
      dispose,
    };
    await expect(
      sessionToDownloadStream(session as never, 100, "video/webm", "a.bin"),
    ).rejects.toThrow(/range fetch failed/);
    expect(dispose).toHaveBeenCalled();
  });
});

describe("#5: image preview size policy on the UI surface", () => {
  it("an image within the limit renders an inline preview", async () => {
    vi.mocked(openRuntime.openImage).mockResolvedValue({
      objectUrl: "blob:img",
    } as never);
    render(
      <VaultRenderer
        vault={makeVault([imageItem()]) as never}
        cryptoKey={fakeKey}
      />,
    );
    await waitFor(() => expect(document.querySelector("img")).not.toBeNull());
    expect(screen.queryByText(/Loading/i)).toBeNull();
  });

  it("an over-limit image shows a precise terminal notice (no preview, no hang)", async () => {
    const size = 26 * 1024 * 1024;
    vi.mocked(openRuntime.openImage).mockRejectedValue(
      new MediaPreviewTooLargeError(size),
    );
    render(
      <VaultRenderer
        vault={makeVault([imageItem({ size })]) as never}
        cryptoKey={fakeKey}
      />,
    );
    await waitFor(() => expect(screen.queryByText(/Loading/i)).toBeNull());
    expect(
      screen.getByText(/too large for an inline preview/i),
    ).toBeTruthy();
    // No inline preview is produced for an oversized image.
    expect(document.querySelector("img")).toBeNull();
  });

  it("an image read failure is classified as a stream-read failure", async () => {
    vi.mocked(openRuntime.openImage).mockRejectedValue(
      new Error("decrypt failed"),
    );
    render(
      <VaultRenderer
        vault={makeVault([imageItem()]) as never}
        cryptoKey={fakeKey}
      />,
    );
    await waitFor(() => expect(screen.queryByText(/Loading/i)).toBeNull());
    // An image read FAILURE (not a timeout) is a stream-read failure —
    // never mislabelled as an MSE/network error.
    expect(screen.getByText(/STREAM_READ_FAILED/)).toBeTruthy();
  });

  it("an image construction failure is PREVIEW_OBJECT_URL_FAILED, not a read failure", async () => {
    // The image path builds its Blob inside openImage.ts; a construction
    // failure there must reach the terminal surface as a construction
    // failure, never as STREAM_READ_FAILED.
    vi.mocked(openRuntime.openImage).mockRejectedValue(
      new MediaPreviewConstructionError(new Error("createObjectURL exploded")),
    );
    render(
      <VaultRenderer
        vault={makeVault([imageItem()]) as never}
        cryptoKey={fakeKey}
      />,
    );
    await waitFor(() => expect(screen.queryByText(/Loading/i)).toBeNull());
    expect(screen.getByText(/PREVIEW_OBJECT_URL_FAILED/)).toBeTruthy();
    expect(screen.queryByText(/STREAM_READ_FAILED/)).toBeNull();
    // Never leak the platform error text.
    expect(screen.queryByText(/createObjectURL exploded/)).toBeNull();
  });

  it("a stalled image open does not leave the UI in Loading", async () => {
    vi.useFakeTimers();
    vi.mocked(openRuntime.openImage).mockImplementation(
      () => new Promise(() => {}),
    );
    render(
      <VaultRenderer
        vault={makeVault([imageItem()]) as never}
        cryptoKey={fakeKey}
      />,
    );
    expect(screen.getByText(/Loading/i)).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });

    expect(screen.queryByText(/Loading/i)).toBeNull();
    // A stalled image read is a read TIMEOUT — distinct from a read
    // failure and never mislabelled as MSE.
    expect(screen.getByText(/STREAM_READ_TIMEOUT/)).toBeTruthy();
    expect(screen.queryByText(/MSE_SETUP_FAILED/)).toBeNull();
  });
});

/**
 * Range-download deadline regression (container chunk read).
 *
 * The Production defect: a valid 10 MiB container chunk read was
 * aborted by the old 8 s whole-object budget. These tests pin the
 * media-layer consequences — a slow-but-healthy read must still open,
 * and a failed read must always reach a terminal state.
 */
describe("range read deadline — media layer", () => {
  it("#8: a slow-but-valid read (>8 s) still opens the mixed text + video flow", async () => {
    vi.useFakeTimers();

    const session = {
      read: () =>
        new Promise<Uint8Array<ArrayBuffer>>((resolve) => {
          // 12 s: past the OLD 8 s budget, well inside the 30 s
          // media-read deadline.
          setTimeout(
            () => resolve(new Uint8Array(8) as Uint8Array<ArrayBuffer>),
            12_000,
          );
        }),
      dispose: vi.fn(),
    };
    vi.mocked(openRuntime.openVideo).mockResolvedValue(session as never);

    render(
      <VaultRenderer
        vault={
          makeVault([
            { type: "text", text: "Hello capsule" },
            videoItem(),
          ]) as never
        }
        cryptoKey={fakeKey}
      />,
    );

    // Text renders independently; media is still loading.
    expect(screen.getByText("Hello capsule")).toBeTruthy();
    expect(screen.getByText(/Loading video\.webm/i)).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_500);
    });

    // The slow read completed and produced a playable element.
    expect(screen.queryByText(/Loading/i)).toBeNull();
    const vid = document.querySelector("video");
    expect(vid).not.toBeNull();
    expect((vid as HTMLVideoElement).src).toContain("blob");

    vi.useRealTimers();
  });

  it("#9: a never-settling range read reaches a terminal error, never a pending state", async () => {
    vi.useFakeTimers();

    const session = {
      read: () => new Promise<Uint8Array<ArrayBuffer>>(() => {}),
      dispose: vi.fn(),
    };
    vi.mocked(openRuntime.openVideo).mockResolvedValue(session as never);

    render(
      <VaultRenderer
        vault={makeVault([videoItem()]) as never}
        cryptoKey={fakeKey}
      />,
    );

    expect(screen.getByText(/Loading/i)).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });

    expect(screen.queryByText(/Loading/i)).toBeNull();
    // The capability gate is entered (no MediaSource in jsdom), then the
    // fallback's bounded read never settles -> a fallback read timeout.
    expect(screen.getByText(/PREVIEW_READ_TIMEOUT/)).toBeTruthy();

    vi.useRealTimers();
  });
});

/**
 * Phase E2 — diagnostic classification on the RENDERED surface.
 *
 * The point of the diagnostics is that an iPhone screenshot can be
 * narrowed to a stage, so these assert the actual on-screen text.
 * They must never leak raw exception text or internal markers.
 */
describe("MediaItemV2Block — diagnostic codes on the rendered surface", () => {
  it("a capability rejection followed by a SUCCESSFUL fallback still shows media", async () => {
    // No MediaSource in jsdom -> the bare WebM is not streamable, so the
    // capability gate rejects and the bounded Blob fallback runs. The
    // read resolves, so the preview must still appear normally.
    vi.mocked(openRuntime.openVideo).mockResolvedValue(okSession() as never);

    render(
      <VaultRenderer
        vault={makeVault([videoItem({ mimeType: "video/webm" })]) as never}
        cryptoKey={fakeKey}
      />,
    );

    await waitFor(() => expect(screen.queryByText(/Loading/i)).toBeNull());

    const vid = document.querySelector("video") as HTMLVideoElement | null;
    expect(vid).not.toBeNull();
    expect(vid!.src).toContain("blob");
    // A successful open renders NO diagnostic card at all.
    expect(screen.queryByText(/Media preview unavailable/i)).toBeNull();
  });

  it("a Blob/object-URL construction failure is not reported as a read/network error", async () => {
    vi.mocked(openRuntime.openVideo).mockResolvedValue(okSession() as never);
    // The read succeeds, but URL.createObjectURL throws.
    vi.stubGlobal("URL", {
      createObjectURL: () => {
        throw new Error("createObjectURL exploded");
      },
      revokeObjectURL: () => {},
    });

    render(
      <VaultRenderer
        vault={makeVault([videoItem({ mimeType: "video/webm" })]) as never}
        cryptoKey={fakeKey}
      />,
    );

    await waitFor(() => expect(screen.queryByText(/Loading/i)).toBeNull());
    expect(screen.getByText(/PREVIEW_OBJECT_URL_FAILED/)).toBeTruthy();
    expect(screen.queryByText(/PREVIEW_READ_FAILED/)).toBeNull();
    expect(screen.queryByText(/STREAM_READ_FAILED/)).toBeNull();
    // Never leak the platform error text.
    expect(screen.queryByText(/createObjectURL exploded/)).toBeNull();
  });

  it("a rendered diagnostic never leaks raw text, [AETERNA], or URL fragments", async () => {
    const session = {
      read: () =>
        Promise.reject(
          new Error(
            "[AETERNA] Storage failure at https://gateway.irys.xyz/AbC123#frag=secret",
          ),
        ),
      dispose: vi.fn(),
    };
    vi.mocked(openRuntime.openVideo).mockResolvedValue(session as never);

    render(
      <VaultRenderer
        vault={makeVault([videoItem()]) as never}
        cryptoKey={fakeKey}
      />,
    );

    await waitFor(() => expect(screen.queryByText(/Loading/i)).toBeNull());

    const card = screen.getByText(/Media preview unavailable/i).closest("div");
    const text = card?.textContent ?? "";
    expect(text).not.toMatch(/\[AETERNA\]/);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/AbC123|frag=secret/);
    expect(text).not.toMatch(/at https:/);
  });
});

/**
 * MSE read timeout vs MSE handshake timeout.
 *
 * A codec-qualified type IS supported and the handshake COMPLETES, so
 * the progressive path reaches `session.read(...)`. When that read
 * never settles, the failure is a STREAM-READ timeout — it must NOT be
 * labelled `MSE_SETUP_FAILED` merely because the media type is video.
 */
describe("MSE read timeout is a stream-read timeout, never MSE setup", () => {
  let openSources: MsFakeMediaSource[];

  class OpeningMediaSource extends EventTarget {
    static isTypeSupported(): boolean {
      return true; // streamable — the handshake proceeds
    }
    readyState: "closed" | "open" | "ended" = "closed";
    addSourceBuffer(): MsFakeSourceBuffer {
      return new MsFakeSourceBuffer();
    }
    endOfStream(): void {
      this.readyState = "ended";
    }
  }

  let originalSrcDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    openSources = [];
    vi.stubGlobal("MediaSource", OpeningMediaSource);

    // Instrument the element's `src` setter so assigning a MediaSource
    // object URL OPENS the source and fires `sourceopen` (mirroring the
    // real browser handshake used by the production attach-before-await).
    const proto = HTMLMediaElement.prototype;
    originalSrcDescriptor = Object.getOwnPropertyDescriptor(proto, "src");
    Object.defineProperty(proto, "src", {
      configurable: true,
      get() {
        return "";
      },
      set(this: HTMLMediaElement, value: string) {
        const url = String(value);
        if (url.startsWith("blob:ms-")) {
          const idx = Number(url.slice("blob:ms-".length));
          const ms = openSources[idx];
          if (ms && ms.readyState === "closed") {
            ms.readyState = "open";
            queueMicrotask(() => ms.dispatchEvent(new Event("sourceopen")));
          }
        }
        Object.defineProperty(this, "__src", {
          configurable: true,
          writable: true,
          value: url,
        });
      },
    });

    vi.stubGlobal("URL", {
      createObjectURL: (obj: unknown) => {
        if (obj instanceof OpeningMediaSource) {
          openSources.push(obj as unknown as MsFakeMediaSource);
          return `blob:ms-${openSources.length - 1}`;
        }
        return `blob:obj-${openSources.length}`;
      },
      revokeObjectURL: () => {},
    });
  });

  afterEach(() => {
    const proto = HTMLMediaElement.prototype;
    if (originalSrcDescriptor) {
      Object.defineProperty(proto, "src", originalSrcDescriptor);
    }
    vi.useRealTimers();
  });

  it("a never-settling session.read on the MSE path reports STREAM_READ_TIMEOUT", async () => {
    // Handshake completes; the chunk read never settles.
    const session = {
      read: () => new Promise<Uint8Array<ArrayBuffer>>(() => {}),
      dispose: vi.fn(),
    };
    vi.mocked(openRuntime.openVideo).mockResolvedValue(session as never);

    render(
      <VaultRenderer
        vault={
          makeVault([
            videoItem({ mimeType: "video/webm;codecs=vp8,opus", size: 32 }),
          ]) as never
        }
        cryptoKey={fakeKey}
      />,
    );

    // Past the 30 s chunk-read deadline.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });

    expect(screen.queryByText(/Loading/i)).toBeNull();
    expect(screen.getByText(/STREAM_READ_TIMEOUT/)).toBeTruthy();
    // The misclassification this phase fixes: a read timeout must NOT be
    // reported as an MSE setup failure.
    expect(screen.queryByText(/MSE_SETUP_FAILED/)).toBeNull();
    expect(screen.queryByText(/MEDIA_UNSUPPORTED/)).toBeNull();
  });
});

/**
 * MSE setup failure vs capability rejection — distinct diagnostics.
 *
 * A codec-qualified type IS supported by MSE here, but the handshake
 * never completes, so the MSE layer fails at SETUP (`mse-setup`). The
 * bounded fallback is then entered for that reason; a failing fallback
 * read must be reported as a PREVIEW read failure (with the known
 * trigger), never as MEDIA_UNSUPPORTED.
 */
describe("MSE setup failure is distinguishable from a capability rejection", () => {
  class StallingMediaSource extends EventTarget {
    static isTypeSupported(): boolean {
      return true; // the type IS supported — setup still fails
    }
    readyState: "closed" | "open" | "ended" = "closed";
    addSourceBuffer(): EventTarget {
      // Never emits updateend — but we stall before that at sourceopen.
      return new EventTarget();
    }
    endOfStream(): void {}
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("MediaSource", StallingMediaSource);
    // The MediaSource object URL is created, but sourceopen never fires
    // (nothing transitions readyState to "open").
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:stalling-mediasource",
      revokeObjectURL: () => {},
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports a fallback read failure (not MEDIA_UNSUPPORTED) after an MSE setup stall", async () => {
    // The fallback read itself also fails.
    const session = {
      read: () => Promise.reject(new Error("fallback read failed")),
      dispose: vi.fn(),
    };
    vi.mocked(openRuntime.openVideo).mockResolvedValue(session as never);

    render(
      <VaultRenderer
        vault={
          makeVault([
            videoItem({ mimeType: "video/webm;codecs=vp8,opus", size: 32 }),
          ]) as never
        }
        cryptoKey={fakeKey}
      />,
    );

    // Advance past the 20 s sourceopen timeout so the MSE layer fails at
    // SETUP, then let the fallback read reject.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_500);
    });

    expect(screen.queryByText(/Loading/i)).toBeNull();
    expect(screen.getByText(/PREVIEW_READ_FAILED/)).toBeTruthy();
    expect(screen.queryByText(/MEDIA_UNSUPPORTED/)).toBeNull();
    // The MSE setup boundary is what the code must NOT confuse with a
    // capability answer.
    expect(screen.queryByText(/MSE_SETUP_FAILED/)).toBeNull();
  });
});

/**
 * Phase E2.4 — the fallback TRIGGER must be VISIBLE on the error card.
 *
 * The classifier already knew WHY the bounded Blob fallback was entered,
 * but the renderer forwarded only the final failure message, so a
 * screenshot could not distinguish "the device refused the format" from
 * "MSE setup failed". These tests pin that both facts now appear — and
 * that the trigger line appears ONLY when a fallback was attempted.
 */
describe("Phase E2.4 — the fallback trigger is shown beside the final failure", () => {
  it("capability rejection + fallback failure shows BOTH the failure and the capability trigger", async () => {
    // jsdom has no MediaSource → a bare video/webm is refused at the
    // capability gate (trigger = "capability"), then the bounded Blob
    // fallback runs and its read fails.
    const session = {
      read: () => Promise.reject(new Error("fallback read failed")),
      dispose: vi.fn(),
    };
    vi.mocked(openRuntime.openVideo).mockResolvedValue(session as never);

    render(
      <VaultRenderer
        vault={makeVault([videoItem()]) as never}
        cryptoKey={fakeKey}
      />,
    );

    await waitFor(() => expect(screen.queryByText(/Loading/i)).toBeNull());

    // 1) the final failure stage…
    expect(screen.getByText(/PREVIEW_READ_FAILED/)).toBeTruthy();
    // 2) …and the known fallback trigger, as distinct visible copy. The
    // copy must state the precise, established fact — progressive
    // streaming was unavailable — NOT that the device cannot play it.
    expect(
      screen.getByText(/Fallback reason: progressive streaming unavailable/i),
    ).toBeTruthy();
    expect(screen.getByText(/capability check/i)).toBeTruthy();
    expect(screen.queryByText(/cannot stream the format/i)).toBeNull();
  });

  it("MSE setup failure + fallback failure shows BOTH the failure and the MSE setup trigger", async () => {
    // A codec-qualified type IS accepted by MSE here, but sourceopen never
    // fires → the MSE layer fails at SETUP (trigger = "mse-setup"); the
    // fallback is then entered for that reason and its read fails.
    class StallingMediaSource extends EventTarget {
      static isTypeSupported(): boolean {
        return true;
      }
      readyState: "closed" | "open" | "ended" = "closed";
      addSourceBuffer(): EventTarget {
        return new EventTarget();
      }
      endOfStream(): void {}
    }
    vi.useFakeTimers();
    vi.stubGlobal("MediaSource", StallingMediaSource);
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:stalling-mediasource",
      revokeObjectURL: () => {},
    });

    const session = {
      read: () => Promise.reject(new Error("fallback read failed")),
      dispose: vi.fn(),
    };
    vi.mocked(openRuntime.openVideo).mockResolvedValue(session as never);

    render(
      <VaultRenderer
        vault={
          makeVault([
            videoItem({ mimeType: "video/webm;codecs=vp8,opus", size: 32 }),
          ]) as never
        }
        cryptoKey={fakeKey}
      />,
    );

    // Past the 20 s sourceopen timeout, then the fallback read rejects.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_500);
    });

    expect(screen.queryByText(/Loading/i)).toBeNull();
    // 1) the final failure stage…
    expect(screen.getByText(/PREVIEW_READ_FAILED/)).toBeTruthy();
    // 2) …and the MSE setup trigger, distinct from the capability copy.
    expect(screen.getByText(/Fallback reason/i)).toBeTruthy();
    expect(screen.getByText(/MSE setup/i)).toBeTruthy();
  });

  it("a direct stream-read failure BEFORE any fallback shows NO fallback trigger", async () => {
    // An image read failure never touches the A/V fallback path, so no
    // trigger is known and none may be displayed.
    vi.mocked(openRuntime.openImage).mockRejectedValue(
      new Error("decrypt failed"),
    );

    render(
      <VaultRenderer
        vault={makeVault([imageItem()]) as never}
        cryptoKey={fakeKey}
      />,
    );

    await waitFor(() => expect(screen.queryByText(/Loading/i)).toBeNull());

    // The final failure is shown…
    expect(screen.getByText(/STREAM_READ_FAILED/)).toBeTruthy();
    // …but there is NO trigger line, because no fallback was attempted.
    expect(screen.queryByText(/Fallback reason/i)).toBeNull();
  });

  it("a SUCCESSFUL fallback still shows media and no diagnostic card", async () => {
    // The capability gate refuses the bare WebM, but the bounded Blob
    // fallback reads successfully and produces a playable object URL.
    vi.mocked(openRuntime.openVideo).mockResolvedValue(okSession() as never);

    render(
      <VaultRenderer
        vault={makeVault([videoItem()]) as never}
        cryptoKey={fakeKey}
      />,
    );

    await waitFor(() => expect(document.querySelector("video")).not.toBeNull());

    const vid = document.querySelector("video") as HTMLVideoElement;
    expect(vid.src).toContain("blob");
    // No terminal card, and therefore no trigger line either.
    expect(screen.queryByText(/Media preview unavailable/i)).toBeNull();
    expect(screen.queryByText(/Fallback reason/i)).toBeNull();
    expect(screen.queryByText(/PREVIEW_/)).toBeNull();
  });

  it("diagnostic text never leaks raw exception messages, URLs, fragments or identifiers", async () => {
    const session = {
      read: () =>
        Promise.reject(
          new Error(
            "range read failed: https://gateway.irys.xyz/AbC123#secret",
          ),
        ),
      dispose: vi.fn(),
    };
    vi.mocked(openRuntime.openVideo).mockResolvedValue(session as never);

    render(
      <VaultRenderer
        vault={makeVault([videoItem()]) as never}
        cryptoKey={fakeKey}
      />,
    );

    await waitFor(() => expect(screen.queryByText(/Loading/i)).toBeNull());

    // The trigger IS shown…
    expect(screen.getByText(/Fallback reason/i)).toBeTruthy();
    // …but no raw exception text, URL, fragment or identifier leaks.
    expect(screen.queryByText(/gateway\.irys\.xyz/)).toBeNull();
    expect(screen.queryByText(/AbC123/)).toBeNull();
    expect(screen.queryByText(/#secret/)).toBeNull();
    expect(screen.queryByText(/range read failed/)).toBeNull();
  });
});

/**
 * Structural requirement of the MediaSource fix.
 *
 * A MediaSource only opens once its object URL is attached to a media
 * element, so the element MUST already be mounted while the item is
 * still loading. Deferring it until after the load resolves is exactly
 * the circular dependency that made every progressive attempt burn the
 * full open timeout and fall back to a whole-file Blob.
 */
describe("A/V element is mounted BEFORE the load resolves", () => {
  it("renders the <video> element while still Loading…", async () => {
    // The load never settles on its own.
    vi.mocked(openRuntime.openVideo).mockImplementation(
      () => new Promise(() => {}),
    );

    render(
      <VaultRenderer
        vault={makeVault([videoItem()]) as never}
        cryptoKey={fakeKey}
      />,
    );

    // Still loading…
    expect(screen.getByText(/Loading video\.webm/i)).toBeTruthy();
    // …yet the element the MediaSource will attach to already exists,
    // and it is the ONLY player (never duplicated).
    const players = document.querySelectorAll("video");
    expect(players.length).toBe(1);
  });

  it("keeps the SAME element across loading → loaded (never two players)", async () => {
    vi.mocked(openRuntime.openVideo).mockResolvedValue(okSession() as never);

    render(
      <VaultRenderer
        vault={makeVault([videoItem()]) as never}
        cryptoKey={fakeKey}
      />,
    );

    const before = document.querySelector("video");
    expect(before).not.toBeNull();

    await waitFor(() => expect(screen.queryByText(/Loading/i)).toBeNull());

    const after = document.querySelector("video");
    expect(after).toBe(before);
    expect((after as HTMLVideoElement).src).toContain("blob");
  });

  it("an <audio> item is mounted early too", async () => {
    vi.mocked(openRuntime.openAudio).mockImplementation(
      () => new Promise(() => {}),
    );

    render(
      <VaultRenderer
        vault={
          makeVault([
            {
              type: "media",
              mediaType: "audio",
              filename: "clip.webm",
              mimeType: "audio/webm",
              size: 1000,
              chunks: [],
            },
          ]) as never
        }
        cryptoKey={fakeKey}
      />,
    );

    expect(screen.getByText(/Loading clip\.webm/i)).toBeTruthy();
    expect(document.querySelectorAll("audio").length).toBe(1);
  });
});

/**
 * A/V `src` ownership — Chromium re-write regression.
 *
 * Models the exact Chromium rule that broke the first attach-before-await
 * attempt: assigning the SAME MediaSource object URL a second time
 * re-runs the media element load algorithm, which CLOSES the MediaSource
 * (`readyState` → "closed", duration → NaN) and does NOT fire another
 * `sourceopen`.
 *
 * The instrumented `HTMLMediaElement.prototype.src` enforces that rule,
 * so any regression to "let React render `src`" fails here.
 */

type MsInstrumented = HTMLMediaElement & { __src?: string };

class MsFakeSourceBuffer extends EventTarget {
  appendBuffer(_b?: Uint8Array): void {
    queueMicrotask(() => this.dispatchEvent(new Event("updateend")));
  }
  abort(): void {}
}

class MsFakeMediaSource extends EventTarget {
  static isTypeSupported(m: string): boolean {
    return msSupports(m);
  }
  readyState: "closed" | "open" | "ended" = "closed";
  opens = 0;
  resets = 0;
  addSourceBuffer(): MsFakeSourceBuffer {
    return new MsFakeSourceBuffer();
  }
  endOfStream(): void {
    this.readyState = "ended";
  }
}

let msSupports: (m: string) => boolean = () => true;
let msSourcesByUrl: Map<string, MsFakeMediaSource>;
let msRevoked: string[];
let msSrcWrites: string[];
let msUrlSeq = 0;

let msOriginalSrcDescriptor: PropertyDescriptor | undefined;
let msOriginalRemoveAttribute: typeof Element.prototype.removeAttribute;
let msOriginalSetAttribute: typeof Element.prototype.setAttribute;

function msInstallInstrumentation(): void {
  const proto = HTMLMediaElement.prototype;

  msOriginalSrcDescriptor = Object.getOwnPropertyDescriptor(proto, "src");

  Object.defineProperty(proto, "src", {
    configurable: true,
    get(this: MsInstrumented) {
      return this.__src ?? "";
    },
    set(this: MsInstrumented, value: string) {
      const url = String(value);
      msSrcWrites.push(url);
      this.__src = url;

      const ms = msSourcesByUrl.get(url);
      if (!ms) return;

      if (ms.readyState !== "closed") {
        // Chromium: re-assigning an already-attached URL RESETS the
        // MediaSource — back to "closed", and it never re-opens.
        ms.readyState = "closed";
        ms.resets++;
        return;
      }

      ms.readyState = "open";
      ms.opens++;
      queueMicrotask(() => ms.dispatchEvent(new Event("sourceopen")));
    },
  });

  msOriginalRemoveAttribute = Element.prototype.removeAttribute;
  Object.defineProperty(proto, "removeAttribute", {
    configurable: true,
    value(this: MsInstrumented, name: string) {
      if (String(name).toLowerCase() === "src") this.__src = "";
      return msOriginalRemoveAttribute.call(this, name);
    },
  });

  // React writes attributes via setAttribute — route it through the
  // instrumented property so the same Chromium rule applies.
  msOriginalSetAttribute = Element.prototype.setAttribute;
  Object.defineProperty(proto, "setAttribute", {
    configurable: true,
    value(this: MsInstrumented, name: string, value: string) {
      if (String(name).toLowerCase() === "src") {
        (this as HTMLMediaElement).src = String(value);
        return;
      }
      return msOriginalSetAttribute.call(this, name, value);
    },
  });
}

function msRestoreInstrumentation(): void {
  const proto = HTMLMediaElement.prototype;
  if (msOriginalSrcDescriptor) {
    Object.defineProperty(proto, "src", msOriginalSrcDescriptor);
  }
  Object.defineProperty(proto, "removeAttribute", {
    configurable: true,
    value: msOriginalRemoveAttribute,
  });
  Object.defineProperty(proto, "setAttribute", {
    configurable: true,
    value: msOriginalSetAttribute,
  });
}

const msMediaSourceWrites = () =>
  msSrcWrites.filter((u) => u.startsWith("blob:mediasource-"));
const msObjectWrites = () => msSrcWrites.filter((u) => u.startsWith("blob:object-"));

describe("A/V src ownership — identical URL is never re-written", () => {
  beforeEach(() => {
    msSourcesByUrl = new Map();
    msRevoked = [];
    msSrcWrites = [];
    msUrlSeq = 0;
    msSupports = () => true;

    msInstallInstrumentation();

    vi.stubGlobal("MediaSource", MsFakeMediaSource);
    vi.stubGlobal("URL", {
      createObjectURL: (obj: unknown) => {
        if (obj instanceof MsFakeMediaSource) {
          const url = `blob:mediasource-${++msUrlSeq}`;
          msSourcesByUrl.set(url, obj);
          return url;
        }
        return `blob:object-${++msUrlSeq}`;
      },
      revokeObjectURL: (url: string) => {
        msRevoked.push(url);
      },
    });
  });

  afterEach(() => {
    msRestoreInstrumentation();
    (globalThis as unknown as { MediaSource?: unknown }).MediaSource = undefined;
  });

  it("attaches the MediaSource URL exactly once and never resets it", async () => {
    vi.mocked(openRuntime.openVideo).mockResolvedValue(okSession() as never);

    render(
      <VaultRenderer
        vault={
          makeVault([
            videoItem({ mimeType: "video/webm;codecs=vp8,opus", size: 32 }),
          ]) as never
        }
        cryptoKey={fakeKey}
      />,
    );

    await waitFor(() => {
      const v = document.querySelector("video") as HTMLVideoElement | null;
      expect(v?.src ?? "").toMatch(/^blob:mediasource-/);
    });

    // Give React every opportunity to write `src` a second time.
    await new Promise((r) => setTimeout(r, 40));

    const el = document.querySelector("video") as HTMLVideoElement;
    const ms = msSourcesByUrl.get(el.src);

    expect(ms).toBeTruthy();
    expect(msMediaSourceWrites().length).toBe(1);
    expect(ms!.opens).toBe(1);
    expect(ms!.resets).toBe(0);
    expect(ms!.readyState).toBe("ended");
  });

  it("keeps exactly one player element across loading → loaded", async () => {
    vi.mocked(openRuntime.openVideo).mockResolvedValue(okSession() as never);

    render(
      <VaultRenderer
        vault={
          makeVault([
            videoItem({ mimeType: "video/webm;codecs=vp8,opus", size: 32 }),
          ]) as never
        }
        cryptoKey={fakeKey}
      />,
    );

    expect(document.querySelectorAll("video").length).toBe(1);

    await waitFor(() =>
      expect(
        (document.querySelector("video") as HTMLVideoElement).src,
      ).toMatch(/^blob:mediasource-/),
    );

    expect(document.querySelectorAll("video").length).toBe(1);
  });

  it("the Blob fallback writes its URL once through the same path", async () => {
    msSupports = () => false;
    vi.mocked(openRuntime.openVideo).mockResolvedValue(okSession() as never);

    render(
      <VaultRenderer
        vault={makeVault([videoItem({ mimeType: "video/webm" })]) as never}
        cryptoKey={fakeKey}
      />,
    );

    await waitFor(() => {
      const v = document.querySelector("video") as HTMLVideoElement | null;
      expect(v?.src ?? "").toMatch(/^blob:object-/);
    });

    await new Promise((r) => setTimeout(r, 40));

    expect(msObjectWrites().length).toBe(1);
    expect(msMediaSourceWrites().length).toBe(0);
  });

  it("unmount revokes the MediaSource URL it attached", async () => {
    vi.mocked(openRuntime.openVideo).mockResolvedValue(okSession() as never);

    const { unmount } = render(
      <VaultRenderer
        vault={
          makeVault([
            videoItem({ mimeType: "video/webm;codecs=vp8,opus", size: 32 }),
          ]) as never
        }
        cryptoKey={fakeKey}
      />,
    );

    await waitFor(() =>
      expect(
        (document.querySelector("video") as HTMLVideoElement).src,
      ).toMatch(/^blob:mediasource-/),
    );

    const attached = (document.querySelector("video") as HTMLVideoElement).src;

    unmount();

    expect(msRevoked).toContain(attached);
  });
});
