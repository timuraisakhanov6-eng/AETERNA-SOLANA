// @vitest-environment jsdom
/**
 * Component-level regression tests for `LetterCard` (F3.3.6).
 *
 * Covered behaviour:
 *  - the card shows the content-type marker and a REAL preview of the
 *    author's own first lines;
 *  - the CSS clamp does NOT alter the stored text — the full original
 *    string stays in the DOM and is handed to the reader untouched;
 *  - clicking opens the FULL letter;
 *  - paragraphs and single line breaks are preserved;
 *  - the close button and Escape both close the reader;
 *  - a short letter also opens (no special casing);
 *  - the dialog exposes the same accessible shape as the project's
 *    existing Radix dialogs (accessible name "Letter", role="dialog");
 *  - opening/closing the letter does not reset a neighbouring media
 *    player (no shared state, no Object-URL revocation, no remount).
 *
 * No network, no crypto, no capability secrets. `URL.createObjectURL`
 * is instrumented to prove the letter never touches media URLs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import LetterCard from "./LetterCard";
import VaultRenderer from "./VaultRenderer";
import * as openRuntime from "@/lib/capsule/open/openRuntime";

// `openRuntime` is mocked so the sibling <video> reaches a real element
// with a blob URL without any decryption, network or MediaSource work.
vi.mock("@/lib/capsule/open/openRuntime", () => ({
  openImage: vi.fn(),
  openVideo: vi.fn(),
  openAudio: vi.fn(),
  downloadFile: vi.fn(),
}));

// React 18 requires this flag for `act()` outside a test runner setup.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const LONG_LETTER = [
  "My dear friend,",
  "",
  "If you are reading this, then time has done what time does.",
  "I wrote these words on an ordinary evening, not knowing",
  "what your evening would look like.",
  "",
  "I hope the world has been kind to you. I hope you still",
  "remember how to be surprised. I hope there is someone",
  "who tells you the truth gently.",
  "",
  "Whatever has happened, you are still here, and that counts",
  "for more than you think.",
  "",
  "With love,",
  "me",
].join("\n");

const SHORT_LETTER = "See you in ten years.";

const PARAGRAPH_LETTER = [
  "First paragraph, one line.",
  "Second line of the SAME paragraph.",
  "",
  "Second paragraph.",
].join("\n");

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function openReader(user: ReturnType<typeof userEvent.setup>) {
  return act(async () => {
    await user.click(screen.getByRole("button", { name: /read letter/i }));
  });
}

/* ------------------------------------------------------------------ *
 * Setup
 * ------------------------------------------------------------------ */

let createObjectURL = vi.fn((_obj: unknown) => "blob:letter-test");
let revokeObjectURL = vi.fn((_url: string) => undefined);

beforeEach(() => {
  createObjectURL = vi.fn((_obj: unknown) => "blob:letter-test");
  revokeObjectURL = vi.fn((_url: string) => undefined);
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL,
    revokeObjectURL,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/* ================================================================== *
 * 1. Card shows the marker and the real preview
 * ================================================================== */

describe("LetterCard — marker and real preview", () => {
  it("shows the LETTER marker and the author's own first lines", () => {
    render(<LetterCard content={LONG_LETTER} />);

    expect(screen.getByText("Letter")).toBeTruthy();
    // The preview carries the letter's OWN opening words, real text.
    expect(screen.getByText(/My dear friend,/)).toBeTruthy();
    expect(
      screen.getByText(/If you are reading this, then time has done what time does\./)
    ).toBeTruthy();
  });

  it("offers the 'Read letter' action and announces it opens a dialog", () => {
    render(<LetterCard content={LONG_LETTER} />);

    const trigger = screen.getByRole("button", { name: /read letter/i });
    expect(trigger).toBeTruthy();
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
  });
});

/* ================================================================== *
 * 2. The CSS clamp does not change the stored text
 * ================================================================== */

describe("LetterCard — preview clamping is visual only", () => {
  it("keeps the FULL original string in the DOM, unmodified", () => {
    render(<LetterCard content={LONG_LETTER} />);

    const preview = screen.getByText(/My dear friend,/);

    // The clamp is a CSS bound; the text node itself is the whole letter.
    expect(preview.textContent).toBe(LONG_LETTER);
    expect(preview.className).toContain("line-clamp-3");
    expect(preview.className).toContain("whitespace-pre-wrap");

    // Nothing is truncated in the data the component received.
    expect(LONG_LETTER.startsWith("My dear friend,")).toBe(true);
    expect(LONG_LETTER.endsWith("me")).toBe(true);
  });

  it("adds a continuation fade only when the text is long", () => {
    const { unmount } = render(<LetterCard content={SHORT_LETTER} />);
    // Short letter: no fade element is needed.
    expect(document.querySelector("[aria-hidden='true'].bg-gradient-to-t")).toBeNull();
    unmount();

    render(<LetterCard content={LONG_LETTER} />);
    expect(
      document.querySelector("[aria-hidden='true'].bg-gradient-to-t")
    ).toBeTruthy();
  });
});

/* ================================================================== *
 * 3. Click opens the full letter
 * ================================================================== */

describe("LetterCard — opening the full letter", () => {
  it("opens a dialog containing the ENTIRE letter, start to end", async () => {
    const user = userEvent.setup();
    render(<LetterCard content={LONG_LETTER} />);

    await openReader(user);

    const dialog = screen.getByRole("dialog");
    const inDialog = within(dialog);
    expect(dialog).toBeTruthy();

    // The letter's closing is present — i.e. it is the FULL text.
    expect(
      inDialog.getByText(/you are still here, and that counts/)
    ).toBeTruthy();
    expect(inDialog.getByText(/With love,\s*\n?\s*me/)).toBeTruthy();

    // The reader reassembles the original content exactly.
    const paragraphs = Array.from(
      dialog.querySelectorAll("p.whitespace-pre-wrap")
    );
    expect(paragraphs.length).toBeGreaterThan(0);
    expect(paragraphs.map((p) => p.textContent).join("\n\n")).toBe(LONG_LETTER);
  });

  it("a SHORT letter also opens", async () => {
    const user = userEvent.setup();
    render(<LetterCard content={SHORT_LETTER} />);

    await openReader(user);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeTruthy();
    expect(within(dialog).getByText(SHORT_LETTER)).toBeTruthy();
  });
});

/* ================================================================== *
 * 4. Paragraphs and line breaks are preserved
 * ================================================================== */

describe("LetterCard — author formatting is preserved", () => {
  it("splits on blank lines and keeps single newlines inside a paragraph", async () => {
    const user = userEvent.setup();
    render(<LetterCard content={PARAGRAPH_LETTER} />);

    await openReader(user);

    const paragraphs = Array.from(
      screen.getByRole("dialog").querySelectorAll("p.whitespace-pre-wrap")
    );

    // Blank line -> separate paragraph.
    expect(paragraphs.length).toBe(2);
    // Single newline -> preserved verbatim inside its paragraph.
    expect(paragraphs[0]!.textContent).toBe(
      "First paragraph, one line.\nSecond line of the SAME paragraph."
    );
    expect(paragraphs[1]!.textContent).toBe("Second paragraph.");
  });

  it("never rewrites the saved text to add a title", async () => {
    const user = userEvent.setup();
    render(<LetterCard content={SHORT_LETTER} />);

    await openReader(user);

    // The dialog's accessible name is the CONTENT-TYPE label only —
    // no fabricated subject line appears anywhere.
    const headings = screen.getAllByText("Letter");
    expect(headings.length).toBeGreaterThan(0);
    expect(screen.queryByText(/Subject/i)).toBeNull();

    // The dialog title is the content-type label, NOT the letter's
    // first line (no letter title invented from the body text).
    const dialog = screen.getByRole("dialog");
    const title = document.getElementById(
      dialog.getAttribute("aria-labelledby")!
    );
    expect(title?.textContent).toBe("Letter");
    expect(title?.textContent).not.toContain("My dear friend");
  });
});

/* ================================================================== *
 * 5. Closing: button and Escape
 * ================================================================== */

describe("LetterCard — closing the reader", () => {
  it("closes via the close button", async () => {
    const user = userEvent.setup();
    render(<LetterCard content={LONG_LETTER} />);

    await openReader(user);
    expect(screen.getByRole("dialog")).toBeTruthy();

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /close/i }));
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    // The card remains, ready to be reopened.
    expect(screen.getByRole("button", { name: /read letter/i })).toBeTruthy();
  });

  it("closes via Escape", async () => {
    const user = userEvent.setup();
    render(<LetterCard content={LONG_LETTER} />);

    await openReader(user);
    expect(screen.getByRole("dialog")).toBeTruthy();

    await act(async () => {
      await user.keyboard("{Escape}");
    });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("can be reopened after closing", async () => {
    const user = userEvent.setup();
    render(<LetterCard content={LONG_LETTER} />);

    await openReader(user);
    await act(async () => {
      await user.keyboard("{Escape}");
    });
    await openReader(user);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeTruthy();
    // The reopened reader shows the closing paragraph of the letter.
    expect(within(dialog).getByText(/With love,\s*\n?\s*me/)).toBeTruthy();
  });
});

/* ================================================================== *
 * 6. Accessibility matches the project's existing Radix dialogs
 * ================================================================== */

describe("LetterCard — dialog accessibility", () => {
  it("uses role=dialog with an accessible name", async () => {
    const user = userEvent.setup();
    render(<LetterCard content={LONG_LETTER} />);

    await openReader(user);

    const dialog = screen.getByRole("dialog");
    // Radix wires aria-labelledby to the DialogTitle text.
    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe("Letter");
  });

  it("moves focus into the dialog when it opens", async () => {
    const user = userEvent.setup();
    render(<LetterCard content={LONG_LETTER} />);

    await openReader(user);

    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});

/* ================================================================== *
 * 7. The letter never disturbs a neighbouring media player
 *
 * `openRuntime` is mocked (as in VaultRenderer.media.test.tsx), so the
 * video reaches a real <video> element with a blob URL and NO real
 * decryption/network happens. The assertions then prove that opening
 * and closing the letter leaves that player completely untouched.
 * ================================================================== */

describe("LetterCard — media player isolation", () => {
  it("never creates or revokes an Object URL", async () => {
    const user = userEvent.setup();
    render(<LetterCard content={LONG_LETTER} />);

    await openReader(user);
    await act(async () => {
      await user.keyboard("{Escape}");
    });

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("opening/closing the letter leaves the sibling video element untouched", async () => {
    const user = userEvent.setup();

    const dispose = vi.fn();
    vi.mocked(openRuntime.openVideo).mockResolvedValue({
      read: () => Promise.resolve(new Uint8Array(8)),
      dispose,
    } as never);

    const vault = {
      version: 2,
      capsule: {
        capsuleId: "cap-letter",
        items: [
          { type: "text", text: LONG_LETTER, createdAt: "2026-01-01T00:00:00.000Z" },
          {
            type: "media",
            mediaType: "video",
            filename: "letter-video.webm",
            mimeType: "video/webm",
            size: 1000,
            chunks: [],
          },
        ],
      },
    } as unknown as Parameters<typeof VaultRenderer>[0]["vault"];

    render(
      <VaultRenderer
        vault={vault}
        cryptoKey={{ } as CryptoKey}
        containerChunks={new Map()}
      />
    );

    // Wait for the video to reach a real element with a blob source.
    await waitFor(() => {
      const el = document.querySelector("video");
      expect(el).not.toBeNull();
      expect((el as HTMLVideoElement).src).toContain("blob");
    });

    const video = document.querySelector("video") as HTMLVideoElement;
    const srcBefore = video.src;
    const loadSpy = vi.spyOn(video, "load");
    const removeSpy = vi.spyOn(video, "remove");
    const pauseSpy = vi.spyOn(video, "pause");
    video.currentTime = 12.5;

    // --- open the letter ---
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /read letter/i }));
    });
    expect(screen.getByRole("dialog")).toBeTruthy();

    // The player was NOT disturbed by the letter opening.
    expect(document.querySelector("video")).toBe(video);
    expect(video.src).toBe(srcBefore);
    expect(video.currentTime).toBe(12.5);
    expect(loadSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();

    // --- close the letter ---
    await act(async () => {
      await user.keyboard("{Escape}");
    });
    expect(screen.queryByRole("dialog")).toBeNull();

    // Still the same element, same source, same position, no revoke.
    expect(document.querySelector("video")).toBe(video);
    expect(video.src).toBe(srcBefore);
    expect(video.currentTime).toBe(12.5);
    expect(loadSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });
});
