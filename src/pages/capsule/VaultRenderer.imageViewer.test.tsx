// @vitest-environment jsdom
/**
 * =========================================================
 * AETERNA — Full-screen image viewer regressions
 * =========================================================
 *
 * Drives the REAL `VaultRenderer` and the REAL `ImageViewer` through
 * user-visible interaction. The only mocked layer is `openRuntime`
 * (no network, no crypto, no capability secrets); `URL` is stubbed so
 * object URLs are deterministic and their revocation is observable.
 *
 * R9-A90.1 changed the entry point, not the viewer:
 *
 *  • the capsule initially renders a compact photo card and NO <img>;
 *  • `openImage` is not called until `View photo` is activated;
 *  • the same ImageViewer, URL ownership and focus restoration are used;
 *  • closing the viewer reuses the cached URL (no second container read);
 *  • the URL is released when the capsule unmounts.
 *
 * What is pinned here:
 *  1  clicking View photo opens the viewer
 *  2  the photo action is an operable, named control
 *  3  the viewer shows THAT image's URL
 *  4  the viewer's presentation preserves aspect ratio (object-contain)
 *  5  the close button closes and restores focus
 *  6  Escape closes
 *  7  a backdrop click closes
 *  8  a click on the image itself does NOT close
 *  9  closing returns to the same capsule view, no navigation
 * 10  no ZIP/download path is triggered
 * 11  no second read of the image is triggered
 * 12  opening/closing reuses the item-owned object URL; unmount revokes it
 * 13  multiple images: the selected one is shown, not a previous one
 * 14  repeated open/close cycles leak neither listeners nor URLs
 * 15  the full-screen surface cancels the dialog's panel motion and radius
 * 16  all four horizontal/vertical safe-area insets are present
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
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

function makeVault(items: unknown[]): unknown {
  return {
    version: 2,
    capsule: { capsuleId: "cap-1", items },
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

let revoked: string[];

function stubUrl(): void {
  revoked = [];
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:created"),
    revokeObjectURL: vi.fn((url: string) => {
      revoked.push(url);
    }),
  });
}

/** Renders one image item and waits for its collapsed card, not its bytes. */
async function renderImage(
  overrides: Record<string, unknown> = {},
  objectUrl = "blob:photo",
): Promise<void> {
  vi.mocked(openRuntime.openImage).mockResolvedValue({
    objectUrl,
  } as never);

  const filename =
    (overrides["filename"] as string | undefined) ?? "photo.png";

  render(
    <VaultRenderer
      vault={makeVault([imageItem(overrides)]) as never}
      cryptoKey={fakeKey}
    />,
  );

  await screen.findByRole("button", { name: `View photo: ${filename}` });

  // The initial capsule has no decoded image and performed no read.
  expect(screen.queryByRole("img", { name: filename })).toBeNull();
  expect(document.querySelector("img")).toBeNull();
  expect(openRuntime.openImage).not.toHaveBeenCalled();
}

function trigger(filename = "photo.png"): HTMLElement {
  return screen.getByRole("button", {
    name: `View photo: ${filename}`,
  });
}

async function openViewer(filename = "photo.png"): Promise<HTMLElement> {
  fireEvent.click(trigger(filename));
  return screen.findByRole("dialog");
}

function closeByButton(dialog: HTMLElement): void {
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Close image viewer" }),
  );
}

beforeEach(() => {
  stubUrl();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("R9-A88.1 + R9-A90.1 — collapsed photo card opens the full-screen viewer", () => {
  it("1/2/3/4: View photo opens a dialog showing that image, uncropped", async () => {
    await renderImage();

    // 2 — the collapsed card's action is an operable control with a name.
    const photoTrigger = trigger();
    expect(photoTrigger.tagName).toBe("BUTTON");
    expect(photoTrigger.getAttribute("aria-haspopup")).toBe("dialog");

    // 1 — a real click starts the image pipeline and opens the dialog.
    const dialog = await openViewer();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(openRuntime.openImage).toHaveBeenCalledTimes(1);

    // 3 — the viewer displays the SAME object URL the item owns.
    const viewerImage = within(dialog).getByRole("img", { name: "photo.png" });
    expect(viewerImage.getAttribute("src")).toBe("blob:photo");

    // 4 — aspect ratio is preserved by presentation, never by cropping.
    const classes = viewerImage.className;
    expect(classes).toContain("object-contain");
    expect(classes).toContain("max-h-full");
    expect(classes).toContain("max-w-full");

    // The dialog has an accessible name (from the image label).
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
  });

  it("5: the close button closes and returns focus to the photo action", async () => {
    await renderImage();
    const photoTrigger = trigger();
    const dialog = await openViewer();

    closeByButton(dialog);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    // The capsule view is untouched and focus is back on the opener.
    expect(screen.getByRole("button", { name: "View photo: photo.png" })).toBeTruthy();
    expect(document.activeElement).toBe(photoTrigger);
  });

  it("6: Escape closes the viewer", async () => {
    await renderImage();
    await openViewer();

    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("7/8: a backdrop click closes, a click on the image does not", async () => {
    await renderImage();
    const dialog = await openViewer();
    const viewerImage = within(dialog).getByRole("img", { name: "photo.png" });

    // 8 — clicking the image itself must NOT close.
    fireEvent.click(viewerImage);
    expect(screen.queryByRole("dialog")).not.toBeNull();

    // 7 — clicking the backdrop (the viewer's own full-screen layer) closes.
    const backdrop = screen.getByTestId("image-viewer-backdrop");
    fireEvent.click(backdrop);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("9/10/11: closing returns to the capsule without navigation, download or re-read", async () => {
    const hrefBefore = window.location.href;
    const scrollBefore = window.scrollY;

    await renderImage();
    const dialog = await openViewer();
    closeByButton(dialog);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    // 9 — same capsule view, no scroll jump, no navigation.
    expect(screen.getByRole("button", { name: "View photo: photo.png" })).toBeTruthy();
    expect(window.location.href).toBe(hrefBefore);
    expect(window.scrollY).toBe(scrollBefore);

    // 10 — the ZIP/download path was never touched.
    expect(openRuntime.downloadFile).not.toHaveBeenCalled();

    // 11 — the image was read exactly once; the viewer reused it.
    expect(openRuntime.openImage).toHaveBeenCalledTimes(1);

    // A second open still reuses that same read.
    await openViewer();
    expect(openRuntime.openImage).toHaveBeenCalledTimes(1);
  });

  it("12: the item keeps owning its object URL until unmount", async () => {
    await renderImage();
    const dialog = await openViewer();
    closeByButton(dialog);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    // Closing the viewer must not revoke the URL the item still owns;
    // reopening is instantaneous and performs no second read.
    expect(revoked).toEqual([]);
    await openViewer();
    expect(openRuntime.openImage).toHaveBeenCalledTimes(1);

    closeByButton(screen.getByRole("dialog"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    // Unmounting the item still releases it exactly as before.
    cleanup();
    expect(revoked).toEqual(["blob:photo"]);
  });

  it("13: two images open their OWN image, not the previous one", async () => {
    const bySize: Record<number, string> = {
      1024: "blob:small",
      2048: "blob:large",
    };

    vi.mocked(openRuntime.openImage).mockImplementation(async (request) => {
      const size = (request as unknown as { media: { size: number } }).media.size;
      return { objectUrl: bySize[size] } as never;
    });

    render(
      <VaultRenderer
        vault={
          makeVault([
            imageItem({ filename: "small.png", size: 1024 }),
            imageItem({ filename: "large.png", size: 2048 }),
          ]) as never
        }
        cryptoKey={fakeKey}
      />,
    );

    await screen.findByRole("button", { name: "View photo: small.png" });
    await screen.findByRole("button", { name: "View photo: large.png" });

    expect(document.querySelector("img")).toBeNull();
    expect(openRuntime.openImage).not.toHaveBeenCalled();

    // Open the SECOND image.
    const dialog = await openViewer("large.png");
    expect(openRuntime.openImage).toHaveBeenCalledTimes(1);
    expect(
      within(dialog).getByRole("img", { name: "large.png" }).getAttribute("src"),
    ).toBe("blob:large");
    expect(
      within(dialog).queryByRole("img", { name: "small.png" }),
    ).toBeNull();

    closeByButton(dialog);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    // …and the first image still opens its own.
    const dialog2 = await openViewer("small.png");
    expect(openRuntime.openImage).toHaveBeenCalledTimes(2);
    expect(
      within(dialog2).getByRole("img", { name: "small.png" }).getAttribute("src"),
    ).toBe("blob:small");
    expect(
      within(dialog2).queryByRole("img", { name: "large.png" }),
    ).toBeNull();
  });

  it("14: repeated open/close cycles leak neither listeners nor object URLs", async () => {
    await renderImage();

    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");

    const countKeydown = (
      spy: typeof addSpy | typeof removeSpy,
    ): number => spy.mock.calls.filter((call) => call[0] === "keydown").length;

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const dialog = await openViewer();
      closeByButton(dialog);
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
    }

    // No listener survives a cycle: every keydown registration is matched.
    expect(countKeydown(addSpy)).toBe(countKeydown(removeSpy));

    // No dialog is left mounted, and the image was read exactly once.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(openRuntime.openImage).toHaveBeenCalledTimes(1);
    expect(
      (URL.createObjectURL as unknown as { mock: { calls: unknown[] } }).mock.calls,
    ).toHaveLength(0);
    expect(revoked).toEqual([]);

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it("15: the full-screen surface cancels the dialog's panel motion and radius", async () => {
    await renderImage();
    const dialog = await openViewer();

    const classes = dialog.className.split(/\s+/);

    /**
     * R9-A88.3 — styling contract.
     *
     * `DialogContent` ships `data-[state=open]:animate-in` with
     * `slide-in-from-*`/`zoom-in-95` and `sm:rounded-lg`. On a full-viewport
     * surface that reads as the whole screen flying in, and it rounds the four
     * viewport corners at >= 640 px.
     *
     * These assertions pin the MERGED class list that actually reaches the DOM
     * (the string below is the output of cn() -> clsx -> tailwind-merge, not
     * the literal prop), which is the only part of the contract a DOM test can
     * observe. The cascade outcome — that `!animate-none` beats the inherited
     * `animate-in` — is a CSS property of the built bundle and is verified by
     * inspecting the compiled stylesheet, not here.
     */
    expect(classes).toContain("data-[state=open]:!animate-none");
    expect(classes).toContain("data-[state=closed]:!animate-none");
    expect(classes).toContain("sm:rounded-none");

    // tailwind-merge resolves `rounded-none`/`sm:rounded-lg` as the same
    // utility family, so the inherited desktop radius is not in the list at all.
    expect(classes).not.toContain("sm:rounded-lg");

    // The layer is a full-viewport flex box, not the shared dialog's grid.
    expect(classes).toContain("fixed");
    expect(classes).toContain("inset-0");
    expect(classes).toContain("flex");
    expect(classes).not.toContain("grid");
  });

  it("16: horizontal safe areas — image and close control clear the landscape notch", async () => {
    await renderImage();
    const dialog = await openViewer();

    /**
     * R9-A88.9 — horizontal safe-area contract.
     *
     * jsdom has no layout engine and no notion of a sensor housing, so
     * `env(safe-area-inset-*)` cannot be evaluated here. What is pinned is the
     * class contract that actually reaches the DOM — the base margin (`+1rem`)
     * and the two horizontal insets.
     */
    const backdrop = within(dialog).getByTestId("image-viewer-backdrop");
    const imageClasses = backdrop.className.split(/\s+/);

    expect(imageClasses).toContain("pl-[calc(env(safe-area-inset-left)+1rem)]");
    expect(imageClasses).toContain("pr-[calc(env(safe-area-inset-right)+1rem)]");

    // The flat `px-4` is gone rather than merely overridden.
    expect(imageClasses).not.toContain("px-4");

    expect(imageClasses).toContain("pt-[calc(env(safe-area-inset-top)+4.5rem)]");
    expect(imageClasses).toContain("pb-[calc(env(safe-area-inset-bottom)+1.5rem)]");

    const close = within(dialog).getByRole("button", {
      name: "Close image viewer",
    });
    const closeClasses = close.className.split(/\s+/);

    expect(closeClasses).toContain("right-[calc(env(safe-area-inset-right)+1rem)]");
    expect(closeClasses).not.toContain("right-4");

    expect(closeClasses).toContain("top-4");
    expect(closeClasses).toContain("mt-[env(safe-area-inset-top)]");
    expect(closeClasses).toContain("h-10");
    expect(closeClasses).toContain("w-10");

    // Zero-inset devices keep the original 16 px margin: `+1rem` is additive.
    expect(closeClasses.join(" ")).toMatch(/\+1rem\)\]/);

    // 7/8 — the interaction contract is untouched by the placement change.
    closeByButton(dialog);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(document.activeElement).toBe(trigger());
  });
});
