// @vitest-environment jsdom
/**
 * =========================================================
 * AETERNA — CapsulePreview bottom safe-area contract (R9-A88.11)
 * =========================================================
 *
 * The pre-seal staging page ends in a sticky action bar holding the
 * "Add file to capsule" button. With `viewport-fit=cover` the bar sits on the
 * physical bottom edge, so a flat `p-4` left the button's lower edge inside the
 * iPhone Home Indicator gesture band.
 *
 * What is pinned:
 *  1  horizontal padding is still exactly 1rem
 *  2  top padding is still exactly 1rem
 *  3  bottom padding is `env(safe-area-inset-bottom) + 1rem`
 *  4  zero-inset bottom padding is exactly 1rem (the `+1rem` constant)
 *  5  the Add file action still opens the file picker
 *
 * jsdom has no layout engine and no safe-area insets; only the class contract
 * and the DOM behaviour are observed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import CapsulePreview from "@/pages/capsule/CapsulePreview";

vi.mock("@/components/capsule/TextLetterModal", () => ({
  default: () => null,
}));
vi.mock("@/components/capsule/ItemPreviewModal", () => ({
  default: () => null,
}));

/**
 * The stub must be a STABLE reference. `CapsulePreview` syncs its order state in
 * `useEffect(..., [items])`, and that effect always stores a fresh array — so a
 * context mock that returned a new `items` array on every render would re-run
 * the effect on every render and spin forever. Production is unaffected: the
 * real provider keeps `items` in state.
 */
const { capsuleStub } = vi.hoisted(() => ({
  capsuleStub: {
    items: [] as { id: string }[],
    removeItem: vi.fn(),
    getMediaFile: vi.fn(),
    addMediaItem: vi.fn(),
  },
}));

vi.mock("@/context/CapsuleContext", () => ({
  useCapsule: () => capsuleStub,
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/capsule/preview"]}>
      <CapsulePreview />
    </MemoryRouter>,
  );
}

function actionBar(): HTMLElement {
  const button = screen.getByRole("button", { name: /Add file to capsule/i });
  const bar = button.parentElement;
  if (!bar) throw new Error("action bar not found");
  return bar;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("R9-A88.11 — CapsulePreview sticky action bar safe area", () => {
  it("1/2/3/4: keeps 1rem sides and top, and adds the bottom inset", () => {
    renderPage();

    const classes = actionBar().className.split(/\s+/);

    expect(classes).toContain("sticky");
    expect(classes).toContain("bottom-0");

    // Horizontal and top padding are still exactly 1rem.
    expect(classes).toContain("px-4");
    expect(classes).toContain("pt-4");

    // Bottom is inset + 1rem, so a zero-inset device keeps exactly 16 px.
    expect(classes).toContain(
      "pb-[calc(env(safe-area-inset-bottom)+1rem)]",
    );

    // No blanket `p-4` left behind: its interaction with an arbitrary `pb-*`
    // would depend on utility order.
    expect(classes).not.toContain("p-4");
  });

  it("5: the Add file action still opens the file picker", () => {
    const clickSpy = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => {});

    renderPage();

    fireEvent.click(
      screen.getByRole("button", { name: /Add file to capsule/i }),
    );

    expect(clickSpy).toHaveBeenCalledTimes(1);

    // The hidden input it triggers is still a multi-file picker.
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.multiple).toBe(true);

    clickSpy.mockRestore();
  });

  it("6/7: the root tracks the VISIBLE viewport, so the bar cannot be pushed under Safari's toolbars", () => {
    const { container } = renderPage();

    const root = container.firstElementChild as HTMLElement;
    expect(root).not.toBeNull();

    const classes = root.className.split(/\s+/);

    /**
     * R9-A88.13 — `h-screen` compiles to `height:100vh`, the LARGE viewport on
     * iOS Safari: with `viewport-fit=cover` the whole column can be taller than
     * the visible area, so the last flex row (the action bar) slides under the
     * bottom toolbar. `h-[100dvh]` tracks the dynamic viewport instead.
     */
    expect(classes).toContain("h-[100dvh]");

    // The legacy 100vh utility is gone from this element, and no other height
    // utility competes with it (a second one would make the result depend on
    // stylesheet order rather than intent).
    expect(classes).not.toContain("h-screen");
    expect(classes.filter((c) => c === "h-full" || c === "h-[100vh]")).toEqual([]);

    // The flex column that gives the internal scroller its height is unchanged.
    expect(classes).toContain("flex");
    expect(classes).toContain("flex-col");
    expect(classes).toContain("overflow-hidden");

    // …and the bar this height exists for still carries its bottom inset.
    expect(actionBar().className.split(/\s+/)).toContain(
      "pb-[calc(env(safe-area-inset-bottom)+1rem)]",
    );

    /**
     * jsdom cannot simulate Safari's address bar expanding or collapsing, has no
     * `dvh` unit and performs no layout: what is pinned here is the class
     * contract on the rendered root, not a measured viewport height.
     */
  });
});