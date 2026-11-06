// @vitest-environment jsdom
/**
 * =========================================================
 * AETERNA — R9-A90.1 compact capsule content cards
 * =========================================================
 *
 * Component-level verification of the redesigned opened-capsule
 * surface against the REAL `VaultRenderer`, the REAL summary
 * component, the REAL compact cards and the REAL letter reader.
 *
 * Only the storage/runtime boundary is mocked:
 *
 *  • `openRuntime` (no network, no crypto, no capability secrets);
 *  • `URL` (deterministic object URLs with observable revocation).
 *
 * Requirement map (see REPORT.md):
 *
 *  A1–A14  summary heading, total, categories, counting rules, no I/O
 *  B15–B22  collapsed photo card, explicit `View photo`, ImageViewer reuse
 *  C23–C39  collapsed letter card, permanently white reader, focus, scroll
 *  D40–D47  video presentation/lifecycle — delegated to the R9-A89
 *           multiVideo suite, with one preservation pin here
 *  E48–E52  collapsed audio card, explicit `Play audio`, no autoplay
 *  F53–F57  ZIP/Other cards, explicit download, badges and classifier
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  act,
  fireEvent,
  within,
} from "@testing-library/react";

vi.mock("@/lib/capsule/open/openRuntime", () => ({
  openImage: vi.fn(),
  openVideo: vi.fn(),
  openAudio: vi.fn(),
  downloadFile: vi.fn(),
}));

import VaultRenderer from "@/pages/capsule/VaultRenderer";
import * as openRuntime from "@/lib/capsule/open/openRuntime";

/* ------------------------------------------------------------------ */
/* Fixtures                                                             */
/* ------------------------------------------------------------------ */

const fakeKey = ({} as unknown) as CryptoKey;

function makeVault(items: unknown[], capsuleId = "cap-r9a90"): unknown {
  return {
    version: 2,
    capsule: { capsuleId, items },
  };
}

function textItem(
  text = "A private letter",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "text",
    text,
    createdAt: "2026-01-01T00:00:00.000Z",
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
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function videoItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "media",
    mediaType: "video",
    filename: "film.webm",
    mimeType: "video/webm",
    size: 2048,
    chunks: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function audioItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "media",
    mediaType: "audio",
    filename: "clip.webm",
    mimeType: "audio/webm",
    size: 1024,
    chunks: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function zipItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "media",
    mediaType: "file",
    filename: "album.zip",
    mimeType: "application/x-zip-compressed",
    size: 4096,
    chunks: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function otherFileItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "media",
    mediaType: "file",
    filename: "document.pdf",
    mimeType: "application/pdf",
    size: 4096,
    chunks: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function chunk(index: number): Record<string, unknown> {
  return {
    chunkId: `chunk-${index}`,
    mediaId: "media-1",
    index,
    size: 10,
  };
}

let createdUrls: string[];
let revokedUrls: string[];

function stubUrl(): void {
  createdUrls = [];
  revokedUrls = [];
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn((_value: unknown) => {
      const url = `blob:created-${createdUrls.length + 1}`;
      createdUrls.push(url);
      return url;
    }),
    revokeObjectURL: vi.fn((url: string) => {
      revokedUrls.push(url);
    }),
  });
}

function renderCapsule(items: unknown[]) {
  return render(
    <VaultRenderer vault={makeVault(items) as never} cryptoKey={fakeKey} />,
  );
}

function totalText(): string {
  return screen.getByTestId("capsule-contents-total").textContent ?? "";
}

function categoryChip(key: string): Element | null {
  return document.querySelector(`[data-category="${key}"]`);
}

function categoryCount(key: string): number {
  const chip = categoryChip(key);
  if (!chip) throw new Error(`missing category chip: ${key}`);
  const value = chip.getAttribute("aria-label") ?? "";
  return Number(value.split(":")[1]?.trim() ?? "NaN");
}

beforeEach(() => {
  // Reset FIRST: `resetAllMocks` also strips the implementations of the
  // URL spies installed below, which would silently disable revocation
  // tracking (and make ownership assertions vacuously pass).
  vi.resetAllMocks();
  stubUrl();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  cleanup();
  document.documentElement.classList.remove("dark");
});

/* ================================================================== */
/* A — capsule contents summary                                        */
/* ================================================================== */

describe("R9-A90.1-A — capsule contents summary", () => {
  it("A1/A2/A3: renders the heading, prominent total and category labels", () => {
    renderCapsule([
      imageItem({ filename: "one.png" }),
      imageItem({ filename: "two.png" }),
      videoItem(),
      textItem(),
      audioItem(),
      zipItem(),
    ]);

    // A1 — the heading is a real heading named exactly for the surface.
    expect(
      screen.getByRole("heading", { name: "Capsule contents" }),
    ).toBeTruthy();

    // A2 — the total is prominent and pluralised from the descriptors.
    expect(totalText()).toBe("6 files");
    expect(screen.getByTestId("capsule-contents-total").tagName).toBe("P");

    // A3 — categories in the required order with the exact counts.
    expect(categoryCount("photos")).toBe(2);
    expect(categoryCount("videos")).toBe(1);
    expect(categoryCount("letters")).toBe(1);
    expect(categoryCount("audio")).toBe(1);
    expect(categoryCount("zip")).toBe(1);

    for (const key of ["photos", "videos", "letters", "audio", "zip"]) {
      const label = key === "zip" ? "ZIP" : key[0]!.toUpperCase() + key.slice(1);
      expect(categoryChip(key)?.textContent).toContain(label);
    }
  });

  it("A2: a single item uses the singular '1 file'", () => {
    renderCapsule([textItem()]);
    expect(totalText()).toBe("1 file");
  });

  it("A2: an empty capsule shows '0 files' and the existing empty notice", () => {
    renderCapsule([]);

    expect(screen.getByTestId("capsule-contents-summary")).toBeTruthy();
    expect(totalText()).toBe("0 files");
    expect(screen.getByText("Capsule is empty")).toBeTruthy();
    expect(categoryChip("other")).toBeNull();
  });

  it("A4: zero-count categories are hidden", () => {
    renderCapsule([textItem(), textItem("another")]);

    expect(categoryChip("letters")).toBeTruthy();
    expect(categoryChip("photos")).toBeNull();
    expect(categoryChip("videos")).toBeNull();
    expect(categoryChip("audio")).toBeNull();
    expect(categoryChip("zip")).toBeNull();
    expect(categoryChip("other")).toBeNull();
    expect(screen.queryByText("Other")).toBeNull();
  });

  it("A5/A7: each logical item counts once; a text item is one letter", () => {
    renderCapsule([
      textItem("First"),
      textItem("Second"),
      imageItem({ filename: "one.png" }),
      imageItem({ filename: "two.png" }),
    ]);

    expect(totalText()).toBe("4 files");
    expect(categoryCount("letters")).toBe(2);
    expect(categoryCount("photos")).toBe(2);
  });

  it("A6: encrypted chunks are never counted as content items", () => {
    renderCapsule([
      videoItem({ chunks: [chunk(0), chunk(1), chunk(2)] }),
      imageItem({ chunks: [chunk(3), chunk(4)] }),
    ]);

    expect(totalText()).toBe("2 files");
    expect(categoryCount("videos")).toBe(1);
    expect(categoryCount("photos")).toBe(1);
  });

  it("A8: a file descriptor is either ZIP or Other", () => {
    renderCapsule([zipItem(), otherFileItem()]);

    expect(totalText()).toBe("2 files");
    expect(categoryCount("zip")).toBe(1);
    expect(categoryCount("other")).toBe(1);
  });

  it("A9: an unknown item type falls into Other without breaking the summary", () => {
    renderCapsule([
      { type: "poll", question: "?" },
      otherFileItem(),
    ]);

    expect(totalText()).toBe("2 files");
    expect(categoryCount("other")).toBe(2);
  });

  it("A10: the total equals the sum of every displayed category, including Other", () => {
    renderCapsule([
      imageItem(),
      videoItem(),
      textItem(),
      audioItem(),
      zipItem(),
      otherFileItem(),
    ]);

    const keys = ["photos", "videos", "letters", "audio", "zip", "other"];
    const sum = keys.reduce((total, key) => total + categoryCount(key), 0);

    expect(totalText()).toBe("6 files");
    expect(sum).toBe(6);
  });

  it("A11/A13: counts are derived only from descriptors and stay stable through interaction", async () => {
    const items = [
      textItem("First line\nSecond line"),
      imageItem(),
      zipItem(),
    ];

    const view = renderCapsule(items);

    expect(totalText()).toBe("3 files");
    expect(categoryCount("letters")).toBe(1);
    expect(categoryCount("photos")).toBe(1);
    expect(categoryCount("zip")).toBe(1);

    // Opening and closing the letter reader changes no count and performs
    // no storage work — the summary is derived, never re-fetched.
    fireEvent.click(screen.getByRole("button", { name: "Open letter" }));
    await screen.findByRole("dialog", { name: "Letter" });
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(totalText()).toBe("3 files");
    expect(openRuntime.openImage).not.toHaveBeenCalled();
    expect(openRuntime.openVideo).not.toHaveBeenCalled();
    expect(openRuntime.openAudio).not.toHaveBeenCalled();
    expect(openRuntime.downloadFile).not.toHaveBeenCalled();

    // A re-render with the same descriptor list keeps every count.
    view.rerender(
      <VaultRenderer vault={makeVault(items) as never} cryptoKey={fakeKey} />,
    );
    expect(totalText()).toBe("3 files");
    expect(categoryCount("letters")).toBe(1);
    expect(categoryCount("photos")).toBe(1);
    expect(categoryCount("zip")).toBe(1);
  });

  it("A11/A13: counts update when the descriptor list is replaced", () => {
    const first = [textItem("First"), imageItem()];
    const view = renderCapsule(first);

    expect(totalText()).toBe("2 files");
    expect(categoryCount("letters")).toBe(1);
    expect(categoryCount("photos")).toBe(1);

    const second = [videoItem(), audioItem(), zipItem(), otherFileItem()];
    view.rerender(
      <VaultRenderer vault={makeVault(second) as never} cryptoKey={fakeKey} />,
    );

    expect(totalText()).toBe("4 files");
    expect(categoryCount("videos")).toBe(1);
    expect(categoryCount("audio")).toBe(1);
    expect(categoryCount("zip")).toBe(1);
    expect(categoryCount("other")).toBe(1);

    // Zero-count categories are hidden after the replacement.
    expect(categoryChip("photos")).toBeNull();
    expect(categoryChip("letters")).toBeNull();

    expect(openRuntime.openImage).not.toHaveBeenCalled();
    expect(openRuntime.openVideo).not.toHaveBeenCalled();
    expect(openRuntime.openAudio).not.toHaveBeenCalled();
    expect(openRuntime.downloadFile).not.toHaveBeenCalled();
    expect(createdUrls).toHaveLength(0);
  });

  it("A12/A13: counts stay stable while a video starts and stops", async () => {
    renderCapsule([videoItem(), textItem(), imageItem()]);

    expect(totalText()).toBe("3 files");
    expect(categoryCount("videos")).toBe(1);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Play video" }));
    });

    expect(totalText()).toBe("3 files");
    expect(categoryCount("videos")).toBe(1);
    expect(categoryCount("letters")).toBe(1);
    expect(categoryCount("photos")).toBe(1);
  });

  it("A12: opening the capsule performs no storage, URL or media request", () => {
    renderCapsule([
      imageItem(),
      videoItem(),
      textItem(),
      audioItem(),
      zipItem(),
    ]);

    expect(openRuntime.openImage).not.toHaveBeenCalled();
    expect(openRuntime.openVideo).not.toHaveBeenCalled();
    expect(openRuntime.openAudio).not.toHaveBeenCalled();
    expect(openRuntime.downloadFile).not.toHaveBeenCalled();
    expect(createdUrls).toHaveLength(0);

    // No media element is mounted by the summary itself.
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("video")).toBeNull();
    expect(document.querySelector("audio")).toBeNull();
  });

  it("A14: every audio descriptor is counted under Audio — no voice category is invented", () => {
    renderCapsule([
      audioItem({ filename: "voice-message.webm" }),
      audioItem({ filename: "ambience.ogg", mimeType: "audio/ogg" }),
    ]);

    expect(totalText()).toBe("2 files");
    expect(categoryCount("audio")).toBe(2);
    // The summary itself invents no voice category; the card's filename is
    // irrelevant to classification.
    expect(
      screen.getByTestId("capsule-contents-summary").textContent,
    ).not.toMatch(/voice/i);
    expect(categoryChip("other")).toBeNull();
  });

  it("A12/A13: the summary exposes no private letter text", () => {
    const secret = "a sentence only the recipient should read";
    renderCapsule([textItem(secret)]);

    expect(screen.queryByText(secret)).toBeNull();
    expect(
      screen.getByTestId("capsule-contents-summary").textContent,
    ).not.toContain(secret);
  });
});

/* ================================================================== */
/* B — photos                                                          */
/* ================================================================== */

describe("R9-A90.1-B — collapsed photo cards", () => {
  function renderPhoto(overrides: Record<string, unknown> = {}) {
    vi.mocked(openRuntime.openImage).mockResolvedValue({
      objectUrl: "blob:photo",
    } as never);

    return renderCapsule([imageItem(overrides)]);
  }

  it("B15/B16/B17/B18/B19/B20: renders a compact metadata card with an explicit action", () => {
    renderPhoto();

    // B15 — no full-size image and no read on mount.
    expect(document.querySelector("img")).toBeNull();
    expect(openRuntime.openImage).not.toHaveBeenCalled();

    // B16/B17 — an icon (decorative) and a visible PHOTO badge.
    const badge = screen.getByText("PHOTO");
    expect(badge.className).toContain("border-accent/40");
    expect(badge.className).toContain("bg-accent/10");
    expect(document.querySelector("article svg")).toBeTruthy();

    // B18/B19 — filename, MIME type and size.
    expect(screen.getByText("photo.png")).toBeTruthy();
    expect(screen.getByText(/image\/png/)).toBeTruthy();
    expect(screen.getByText(/1024 bytes/)).toBeTruthy();

    // B20 — exactly one explicit, named control.
    const action = screen.getByRole("button", {
      name: "View photo: photo.png",
    });
    expect(action.tagName).toBe("BUTTON");
    expect(action.getAttribute("aria-haspopup")).toBe("dialog");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("B20/B21: View photo reads once and reuses ImageViewer", async () => {
    renderPhoto();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "View photo: photo.png" }),
      );
    });

    const dialog = await screen.findByRole("dialog");

    // B21 — the existing full-screen viewer is the presentation surface.
    expect(
      within(dialog).getByTestId("image-viewer-backdrop"),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Close image viewer" }),
    ).toBeTruthy();

    const image = within(dialog).getByRole("img", { name: "photo.png" });
    expect(image.getAttribute("src")).toBe("blob:photo");
    expect(image.className).toContain("object-contain");
    expect(openRuntime.openImage).toHaveBeenCalledTimes(1);
  });

  it("B22: closing reuses the item-owned URL; unmount is the only release point", async () => {
    renderPhoto();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "View photo: photo.png" }),
      );
    });
    const dialog = await screen.findByRole("dialog");

    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Close image viewer" }),
      );
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // The URL is still owned by the item: closing revokes nothing.
    expect(revokedUrls).toEqual([]);
    expect(openRuntime.openImage).toHaveBeenCalledTimes(1);

    // Reopening is instantaneous and does not read the container again.
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "View photo: photo.png" }),
      );
    });
    const dialog2 = await screen.findByRole("dialog");
    expect(
      within(dialog2).getByRole("img", { name: "photo.png" }).getAttribute("src"),
    ).toBe("blob:photo");
    expect(openRuntime.openImage).toHaveBeenCalledTimes(1);

    // Unmount releases exactly once.
    cleanup();
    expect(revokedUrls).toContain("blob:photo");
  });
});

/* ================================================================== */
/* C — letters                                                         */
/* ================================================================== */

describe("R9-A90.1-C — collapsed letters and the white paper reader", () => {
  const BODY = "A sentence that must stay private\nuntil the letter is opened.";

  function renderLetter(content = BODY) {
    return renderCapsule([textItem(content)]);
  }

  async function openLetter(): Promise<HTMLElement> {
    fireEvent.click(screen.getByRole("button", { name: "Open letter" }));
    return screen.findByRole("dialog", { name: "Letter" });
  }

  /** The Radix dialog overlay rendered behind the reader. */
  function dialogOverlay(): HTMLElement {
    const overlay = Array.from(
      document.querySelectorAll<HTMLElement>('[data-state="open"]'),
    ).find((element) => element.className.includes("bg-black/80"));

    if (!overlay) throw new Error("dialog overlay not found");
    return overlay;
  }

  it("C23/C24: the capsule shows a compact card with no letter body", () => {
    renderLetter();

    // C23 — the body is absent from the collapsed surface.
    expect(screen.queryByText(/must stay private/)).toBeNull();

    // C24 — one explicit, named action.
    const action = screen.getByRole("button", { name: "Open letter" });
    expect(action.tagName).toBe("BUTTON");
    expect(action.getAttribute("aria-haspopup")).toBe("dialog");

    // Content-type marker and neutral (non-invented) label.
    expect(screen.getByText("LETTER")).toBeTruthy();
    expect(screen.getByText("Personal letter")).toBeTruthy();
    expect(screen.queryByText(/subject/i)).toBeNull();
  });

  it("C25/C36/C37: Open letter opens a dedicated dialog and performs no storage request", async () => {
    renderLetter();

    const dialog = await openLetter();

    // C25 — a modal dialog dedicated to the letter.
    expect(dialog.getAttribute("aria-modal")).toBe("true");

    // C36 — its accessible name is the content-type label, not an
    // invented subject line.
    expect(within(dialog).getByText("Letter")).toBeTruthy();

    // C37 — no storage, crypto or media URL work.
    expect(openRuntime.openImage).not.toHaveBeenCalled();
    expect(openRuntime.openVideo).not.toHaveBeenCalled();
    expect(openRuntime.openAudio).not.toHaveBeenCalled();
    expect(openRuntime.downloadFile).not.toHaveBeenCalled();
    expect(createdUrls).toHaveLength(0);
  });

  it("C26/C27: the paper stays white with dark text, independent of the theme", async () => {
    document.documentElement.classList.add("dark");
    renderLetter();

    const dialog = await openLetter();
    const paper = within(dialog).getByTestId("letter-paper");

    // C26 — the surface is an explicit fixed white, not a theme token.
    expect(paper.style.backgroundColor).toBe("rgb(255, 255, 255)");
    expect(paper.className).not.toContain("bg-background");
    expect(paper.className).not.toContain("bg-card");

    // C27 — the ink is an explicit fixed dark colour.
    expect(paper.style.color).toBe("rgb(17, 17, 17)");
    expect(paper.className).not.toContain("text-foreground");
  });

  it("C28/C29/C38: Unicode and line breaks survive verbatim", async () => {
    const original = "Olá, Zoë 🕯️\nSecond line stays on its own line.\n\n第二段 — fin.";
    renderLetter(original);

    // The body is still absent before opening.
    expect(screen.queryByText(/Zoë/)).toBeNull();

    const dialog = await openLetter();
    const paper = within(dialog).getByTestId("letter-paper");

    // C28 — Unicode is rendered exactly (no transliteration or escaping).
    expect(paper.textContent).toContain("Olá, Zoë 🕯️");
    expect(paper.textContent).toContain("第二段 — fin.");

    // C29 — a single newline is preserved inside a paragraph; a blank
    // line starts a new paragraph.
    const paragraphs = Array.from(paper.querySelectorAll("p"));
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]?.textContent).toContain("\n");
    expect(paragraphs[0]?.textContent).toBe(
      "Olá, Zoë 🕯️\nSecond line stays on its own line.",
    );
    expect(paragraphs[1]?.textContent).toBe("第二段 — fin.");

    // C38 — reassembling the rendered paragraphs reproduces the stored
    // string exactly: presentation did not mutate the content.
    expect(paragraphs.map((p) => p.textContent).join("\n\n")).toBe(original);
  });

  it("C30/C39: a long letter is fully present and scrolls inside the paper", async () => {
    const longLetter = `${"A long paragraph that keeps going. ".repeat(120)}\n\nTHE END MARKER`;

    renderLetter(longLetter);

    const dialog = await openLetter();
    const paper = within(dialog).getByTestId("letter-paper");

    // C39 — the reader contains the END, not a clamped preview.
    expect(paper.textContent).toContain("THE END MARKER");

    // C30 — overflow scrolls inside the paper instead of moving the page.
    expect(paper.className).toContain("overflow-y-auto");
    expect(paper.className).toContain("overscroll-contain");
    expect(paper.className).toContain("max-h-");
  });

  it("C33/C34: the close button closes, but a click on the paper does not", async () => {
    renderLetter();
    const dialog = await openLetter();
    const paper = within(dialog).getByTestId("letter-paper");

    // C34 — interacting with the paper never dismisses the reader.
    fireEvent.click(paper);
    expect(screen.queryByRole("dialog")).not.toBeNull();

    // C33 — the explicit close control closes it.
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Close letter" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("C31: Escape closes the reader", async () => {
    renderLetter();
    await openLetter();

    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("C32: a backdrop interaction closes the reader", async () => {
    renderLetter();
    await openLetter();

    const overlay = dialogOverlay();

    /*
     * Radix registers its document-level outside-pointerdown listener in a
     * `setTimeout(…, 0)` after the layer mounts, so let that macrotask run
     * before dispatching the backdrop interaction.
     */
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      /*
       * Radix's modal dialog defers outside-pointerdown dismissal to the
       * following click, so a real backdrop press is pointerdown + click.
       */
      fireEvent.pointerDown(overlay, {
        pointerType: "mouse",
        button: 0,
      });
      fireEvent.click(overlay);
    });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("C35: closing restores focus to the Open letter control", async () => {
    renderLetter();

    const trigger = screen.getByRole("button", { name: "Open letter" });
    trigger.focus();

    await openLetter();
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("C26/C27: the paper stays white when the theme changes while open", async () => {
    document.documentElement.classList.add("dark");
    renderLetter();

    const dialog = await openLetter();
    const paper = within(dialog).getByTestId("letter-paper");

    expect(paper.style.backgroundColor).toBe("rgb(255, 255, 255)");
    expect(paper.style.color).toBe("rgb(17, 17, 17)");

    // Switch to light while the reader is open.
    document.documentElement.classList.remove("dark");
    expect(paper.style.backgroundColor).toBe("rgb(255, 255, 255)");
    expect(paper.style.color).toBe("rgb(17, 17, 17)");

    // Switch back to dark while still open.
    document.documentElement.classList.add("dark");
    expect(paper.style.backgroundColor).toBe("rgb(255, 255, 255)");
    expect(paper.style.color).toBe("rgb(17, 17, 17)");

    // Normal theme behaviour is untouched for the page itself.
    document.documentElement.classList.remove("dark");
  });

  it("C31/C35: reopening after close works and URL/scroll stay unchanged", async () => {
    const hrefBefore = window.location.href;
    const scrollBefore = window.scrollY;

    renderLetter();
    const first = await openLetter();
    expect(first.getAttribute("aria-modal")).toBe("true");

    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Reopen works.
    const second = await openLetter();
    expect(second.getAttribute("aria-modal")).toBe("true");
    expect(window.location.href).toBe(hrefBefore);
    expect(window.scrollY).toBe(scrollBefore);

    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("C30: the paper carries scroll-containment evidence (jsdom cannot lock body scroll)", async () => {
    renderLetter();
    const dialog = await openLetter();
    const paper = within(dialog).getByTestId("letter-paper");

    // Strongest genuine observable evidence available in jsdom: the paper
    // scrolls internally and contains overscroll, so wheel events on the
    // paper cannot chain to the background page. Radix modal portals the
    // dialog; jsdom cannot establish real body scroll locking, so no
    // fake lock is asserted here.
    expect(paper.className).toContain("overflow-y-auto");
    expect(paper.className).toContain("overscroll-contain");
    expect(paper.className).toContain("max-h-");
  });
});

/* ================================================================== */
/* D — video presentation (delegated lifecycle coverage)               */
/* ================================================================== */

describe("R9-A90.1-D — video presentation remains the R9-A89 surface", () => {
  it("D40–D47: counts the video yet renders the gold VIDEO card, loading nothing", () => {
    renderCapsule([videoItem()]);

    // The summary sees the logical video item.
    expect(totalText()).toBe("1 file");
    expect(categoryCount("videos")).toBe(1);

    // The R9-A89 gold badge and Play video control are unchanged.
    const badge = screen.getByText("VIDEO");
    expect(badge.className).toContain("border-accent/40");
    expect(badge.className).toContain("bg-accent/10");
    expect(badge.className).toContain("text-amber-700");
    expect(badge.className).toContain("dark:text-amber-300");

    const play = screen.getByRole("button", { name: "Play video" });
    expect(play.tagName).toBe("BUTTON");

    // And the lazy single-active-video lifecycle owns no session yet.
    expect(openRuntime.openVideo).not.toHaveBeenCalled();
    expect(document.querySelector("video")).toBeNull();
    expect(createdUrls).toHaveLength(0);
  });
});

/* ================================================================== */
/* E — audio                                                           */
/* ================================================================== */

describe("R9-A90.1-E — collapsed audio cards", () => {
  function renderAudio(overrides: Record<string, unknown> = {}) {
    /*
     * Keep the open pending. jsdom has no MediaSource, so a resolved
     * session would immediately take the terminal fallback path and
     * unmount the player. The contract under test here is the explicit
     * activation itself: nothing loads before the click, and after it
     * exactly one existing `openAudio` request is in flight with a
     * mounted, non-autoplaying player.
     */
    vi.mocked(openRuntime.openAudio).mockImplementation(
      () => new Promise(() => {}),
    );

    return renderCapsule([audioItem(overrides)]);
  }

  it("E48/E49/E50: renders a compact card with an AUDIO badge and Play audio", () => {
    renderAudio();

    expect(screen.getByText("AUDIO")).toBeTruthy();
    expect(screen.getByText("clip.webm")).toBeTruthy();
    expect(screen.getByText(/audio\/webm/)).toBeTruthy();
    expect(screen.getByText(/1024 bytes/)).toBeTruthy();

    const play = screen.getByRole("button", {
      name: "Play audio: clip.webm",
    });
    expect(play.tagName).toBe("BUTTON");
  });

  it("E51: nothing is loaded and nothing autoplays before the explicit action", async () => {
    renderAudio();

    expect(openRuntime.openAudio).not.toHaveBeenCalled();
    expect(document.querySelector("audio")).toBeNull();
    expect(createdUrls).toHaveLength(0);

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Play audio: clip.webm" }),
      );
    });

    await waitFor(() =>
      expect(openRuntime.openAudio).toHaveBeenCalledTimes(1),
    );

    const player = document.querySelector("audio") as HTMLAudioElement;
    expect(player).toBeTruthy();
    expect(player.autoplay).toBe(false);
    expect(player.hasAttribute("autoplay")).toBe(false);
    expect(player.hasAttribute("src")).toBe(false);
  });

  it("E52: Play audio reuses the existing openAudio pipeline exactly once", async () => {
    const items = [audioItem()];
    const view = renderCapsule(items);

    // Mock must be installed before activation.
    vi.mocked(openRuntime.openAudio).mockImplementation(
      () => new Promise(() => {}),
    );

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Play audio: clip.webm" }),
      );
    });

    await waitFor(() =>
      expect(openRuntime.openAudio).toHaveBeenCalledTimes(1),
    );
    expect(openRuntime.openAudio).toHaveBeenCalledWith(
      expect.objectContaining({
        media: expect.objectContaining({ filename: "clip.webm" }),
      }),
    );

    // The item stays requested: the action is in its preparing state and
    // cannot be re-triggered.
    const button = screen.getByRole("button", {
      name: "Play audio: clip.webm",
    });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");

    // A re-render with the SAME descriptor references must not open a
    // second session.
    view.rerender(
      <VaultRenderer vault={makeVault(items) as never} cryptoKey={fakeKey} />,
    );
    expect(openRuntime.openAudio).toHaveBeenCalledTimes(1);

    cleanup();
    expect(openRuntime.openAudio).toHaveBeenCalledTimes(1);
  });

  it("E52: cleanup on unmount does not throw and keeps a single openAudio call", async () => {
    renderAudio();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Play audio: clip.webm" }),
      );
    });

    await waitFor(() =>
      expect(openRuntime.openAudio).toHaveBeenCalledTimes(1),
    );

    // jsdom has no MediaSource, so the session stays pending; unmount must
    // not throw and must not create a second request.
    expect(() => cleanup()).not.toThrow();
    expect(openRuntime.openAudio).toHaveBeenCalledTimes(1);
  });
});

/* ================================================================== */
/* F — ZIP / Other                                                     */
/* ================================================================== */

describe("R9-A90.1-F — ZIP and Other file cards", () => {
  function okSession() {
    return {
      read: () => Promise.resolve(new Uint8Array(8)),
      dispose: vi.fn(),
    };
  }

  it("F53/F54: Download is explicit and nothing downloads on mount", () => {
    renderCapsule([zipItem(), otherFileItem()]);

    // F54 — opening the capsule downloads nothing.
    expect(openRuntime.downloadFile).not.toHaveBeenCalled();
    expect(createdUrls).toHaveLength(0);

    // F53 — one explicit, named Download control per file.
    expect(
      screen.getByRole("button", { name: "Download: album.zip" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Download: document.pdf" }),
    ).toBeTruthy();
  });

  it("F55: the explicit click runs the existing download handler once", async () => {
    vi.mocked(openRuntime.downloadFile).mockResolvedValue(
      okSession() as never,
    );

    renderCapsule([zipItem()]);

    expect(openRuntime.downloadFile).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Download: album.zip" }),
      );
    });

    await waitFor(() =>
      expect(openRuntime.downloadFile).toHaveBeenCalledTimes(1),
    );
    expect(openRuntime.downloadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        capsuleId: "cap-r9a90",
        media: expect.objectContaining({ filename: "album.zip" }),
      }),
    );
  });

  it("F56/F57: ZIP and Other use distinct badges, MIME-first classification and no preview", () => {
    renderCapsule([
      zipItem(),
      zipItem({
        filename: "fallback.zip",
        mimeType: "application/octet-stream",
      }),
      otherFileItem(),
      otherFileItem({
        filename: "misleading.zip",
        mimeType: "application/pdf",
      }),
    ]);

    const inSummary = (element: HTMLElement): boolean =>
      element.closest('[data-testid="capsule-contents-summary"]') !== null;

    const zipBadges = screen
      .getAllByText("ZIP")
      .filter((element) => !inSummary(element));
    const otherBadges = screen
      .getAllByText("OTHER")
      .filter((element) => !inSummary(element));

    expect(zipBadges).toHaveLength(2);
    expect(otherBadges).toHaveLength(2);

    // Neither card attempts an inline preview.
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("video")).toBeNull();
    expect(document.querySelector("audio")).toBeNull();

    // The summary agrees with the card classification.
    expect(categoryCount("zip")).toBe(2);
    expect(categoryCount("other")).toBe(2);
    expect(totalText()).toBe("4 files");
  });
});
