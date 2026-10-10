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
import { MediaPreviewTooLargeError } from "@/lib/capsule/open/mediaPreviewPolicy";

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
    expect(screen.getByText(/Failed to load preview/i)).toBeTruthy();
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

    // The newer attempt's video is still shown; no error leaked from attempt 1.
    expect(screen.queryByText(/Failed to load preview/i)).toBeNull();
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

    // Attempt 1 fails terminally...
    await waitFor(() =>
      expect(screen.getByText(/Failed to load preview/i)).toBeTruthy(),
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

  it("an image read failure shows the generic terminal error", async () => {
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
    expect(screen.getByText(/Failed to load preview/i)).toBeTruthy();
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
    expect(screen.getByText(/Failed to load preview/i)).toBeTruthy();
  });
});
