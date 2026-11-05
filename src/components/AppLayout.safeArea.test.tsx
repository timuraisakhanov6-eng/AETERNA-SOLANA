// @vitest-environment jsdom
/**
 * =========================================================
 * AETERNA — Global header safe-area contract (R9-A88.9)
 * =========================================================
 *
 * `viewport-fit=cover` is applied globally by index.html, so the fixed header
 * in `AppLayout` is positioned against the physical screen edge. Before this
 * change it sat 16 px from the raw edge, which on an iPhone puts the theme
 * control inside the status-bar band (portrait) and inside the sensor housing
 * (landscape).
 *
 * What is pinned here:
 *  1  the header is `fixed` and uses inset-aware top/right offsets
 *  2  the unscoped `top-4` / `right-4` tokens are gone, so no cascade order
 *     can restore the unsafe placement
 *  3  the theme control still renders, is named, and still toggles
 *
 * What is NOT proven: jsdom has no layout engine, no `env()` evaluation and no
 * sensor housing. Zero-inset and notched behaviour on real hardware cannot be
 * observed here; only the class contract can.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

import AppLayout from "@/components/AppLayout";

function renderLayout(): HTMLElement {
  const { container } = render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<div>page</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

  return container;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("R9-A88.9 — global header respects the iOS safe area", () => {
  it("1/2: positions the fixed header below the status bar and inside the side inset", () => {
    const container = renderLayout();
    const header = container.querySelector("header");

    expect(header).not.toBeNull();

    const classes = (header as HTMLElement).className.split(/\s+/);

    expect(classes).toContain("fixed");
    expect(classes).toContain("top-[calc(env(safe-area-inset-top)+1rem)]");
    expect(classes).toContain("right-[calc(env(safe-area-inset-right)+1rem)]");

    // The unsafe flat offsets are removed, not merely out-cascaded.
    expect(classes).not.toContain("top-4");
    expect(classes).not.toContain("right-4");

    // 16 px is preserved BESIDE each inset, not replaced by it.
    expect(classes.join(" ")).toMatch(/inset-top\)\+1rem\)\]/);
    expect(classes.join(" ")).toMatch(/inset-right\)\+1rem\)\]/);
  });

  it("3: keeps the theme control visible, named and operable", () => {
    renderLayout();

    const toggle = screen.getByRole("button", {
      name: /Switch to (light|dark) theme/,
    });

    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.getAttribute("aria-label")).toMatch(/Switch to (light|dark) theme/);

    const before = toggle.getAttribute("aria-pressed");
    fireEvent.click(toggle);

    // Behaviour is unchanged: the control still flips the theme.
    expect(toggle.getAttribute("aria-pressed")).not.toBe(before);
  });

  it("renders the routed page inside the layout (header is chrome, not content)", () => {
    renderLayout();

    expect(screen.getByText("page")).not.toBeNull();
  });
});