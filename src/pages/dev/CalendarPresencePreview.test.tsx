// @vitest-environment jsdom
/**
 * AETERNA - local Creator Presence preview (R9-A54).
 *
 * Pins the six requested states and that each drives the REAL availability
 * rule and countdown:
 *
 *   90 days -> Available in 60 days (disabled)
 *   89 days -> Available in 59 days (disabled)
 *   60 days -> Available in 30 days (disabled)
 *   31 days -> Available in 1 day   (disabled)
 *   30 days -> Confirm Presence     (enabled)
 *    5 days -> Confirm Presence     (enabled)
 *
 * Also pins that the preview stays inert: no fetch, no wallet, no payment,
 * no identity, no Irys, no upload, no sealing - in any state.
 *
 * jsdom only.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createElement } from "react";

import CalendarPresencePreview from "./CalendarPresencePreview";

vi.mock("framer-motion", async () => {
  const passthrough = (tag: string) => {
    const C = (props: Record<string, unknown>) => {
      const {
        initial: _i,
        animate: _a,
        transition: _t,
        whileHover: _h,
        whileTap: _p,
        exit: _e,
        layout: _l,
        variants: _v,
        ...domProps
      } = props;
      return createElement(tag, domProps as never);
    };
    return C;
  };
  const cache = new Map<string, unknown>();
  const motion = new Proxy(
    {},
    {
      get: (_t, key) => {
        const k = String(key);
        if (!cache.has(k)) cache.set(k, passthrough(k));
        return cache.get(k);
      },
    }
  );
  return {
    motion,
    AnimatePresence: (p: { children?: unknown }) => p.children,
  };
});

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn(async () => "data:image/png;base64,AAAA") },
}));

const DATE_BUTTON = /^[A-Z][a-z]{2} \d{2}, \d{4}$/;

const renderPreview = () =>
  render(
    <MemoryRouter>
      <CalendarPresencePreview />
    </MemoryRouter>
  );

const surface = (): HTMLElement =>
  document.querySelector("[data-preview-state]") as HTMLElement;

const previewAvailability = (): string | null =>
  (document.querySelector("[data-preview-availability]") as HTMLElement | null)
    ?.getAttribute("data-preview-availability") ?? null;

const previewLabel = (): string =>
  (document.querySelector("[data-preview-button-label]")?.textContent ?? "")
    .replace(/\s+/g, " ")
    .trim();

const cardButton = (): HTMLButtonElement =>
  document.querySelector("button[data-confirm-availability]") as HTMLButtonElement;

const select = (key: string) => {
  fireEvent.click(
    document.querySelector(`[data-preview-control="${key}"]`) as HTMLElement
  );
};

const openCalendar = () => {
  fireEvent.click(screen.getByRole("button", { name: DATE_BUTTON }));
  return screen.getByRole("dialog");
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("preview - structure", () => {
  it("offers exactly the six requested states", () => {
    renderPreview();

    const controls = Array.from(
      document.querySelectorAll("[data-preview-control]")
    ).map((el) => el.getAttribute("data-preview-control"));

    expect(controls).toEqual([
      "days-90",
      "days-89",
      "days-60",
      "days-31",
      "days-30",
      "days-5",
    ]);

    expect(controls.join(" ")).not.toMatch(/disabled|enabled|off/i);
    expect(document.body.textContent).not.toMatch(/presence disabled/i);
  });

  it("opens on the 90-day countdown state", () => {
    renderPreview();

    expect(surface().getAttribute("data-preview-state")).toBe("days-90");
    expect(previewAvailability()).toBe("awaiting-window");
    expect(previewLabel()).toBe("AVAILABLE IN 60 DAYS");
  });
});

describe("preview - countdown states", () => {
  it.each([
    ["days-90", "AVAILABLE IN 60 DAYS"],
    ["days-89", "AVAILABLE IN 59 DAYS"],
    ["days-60", "AVAILABLE IN 30 DAYS"],
    ["days-31", "AVAILABLE IN 1 DAY"],
  ] as const)("%s -> %s, disabled", (key, expectedLabel) => {
    renderPreview();
    select(key);

    expect(previewAvailability()).toBe("awaiting-window");
    expect(previewLabel()).toBe(expectedLabel);

    const button = cardButton();
    expect(button).toBeTruthy();
    expect(button.hasAttribute("disabled")).toBe(true);
    expect((button.textContent ?? "").replace(/\s+/g, " ").trim()).toBe(
      expectedLabel
    );
  });

  it.each([
    ["days-30"],
    ["days-5"],
  ] as const)("%s -> Confirm Presence, enabled", (key) => {
    renderPreview();
    select(key);

    expect(previewAvailability()).toBe("available");
    expect(previewLabel()).toBe("CONFIRM PRESENCE");

    const button = cardButton();
    expect(button.hasAttribute("disabled")).toBe(false);
    expect((button.textContent ?? "").trim()).toBe("CONFIRM PRESENCE");
  });
});

describe("preview - calendar surface", () => {
  it("shows the CREATOR PRESENCE caption above the button in every state", () => {
    renderPreview();

    for (const key of [
      "days-90",
      "days-89",
      "days-60",
      "days-31",
      "days-30",
      "days-5",
    ]) {
      select(key);

      const caption = screen.getByText("CREATOR PRESENCE");
      const button = cardButton();

      expect(caption).toBeTruthy();
      expect(
        caption.compareDocumentPosition(button) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    }
  });

  it("keeps the compact Creator Presence link in the real modal", () => {
    renderPreview();

    const dialog = openCalendar();
    const link = dialog.querySelector('[data-aeterna-presence-link="calendar"]');

    expect(link).toBeTruthy();
    expect((link?.textContent ?? "").trim()).toBe(
      "Learn how the Confirm Presence button works →"
    );
    expect(link?.getAttribute("href")).toBe(
      "/protocol?section=opening-presence"
    );
  });
});

describe("preview - no production side effects", () => {
  it("never issues a fetch across every state", () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("preview must not perform network calls");
    });
    vi.stubGlobal("fetch", fetchSpy);

    renderPreview();

    for (const control of Array.from(
      document.querySelectorAll("[data-preview-control]")
    )) {
      fireEvent.click(control);
    }

    select("days-5");
    const dialog = openCalendar();
    const input = dialog.querySelector("input") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "12.12.2030" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
