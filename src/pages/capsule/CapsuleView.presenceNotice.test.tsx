// @vitest-environment jsdom
/**
 * AETERNA - recipient card, Creator Presence link and Confirm Presence
 * availability + countdown (R9-A52 … R9-A54).
 *
 * Renders the REAL capsule card (CapsuleView, status "preview") and pins:
 *
 *  - recipient view -> the single compact link sits directly BELOW the
 *    capsule card; the creator view never shows it;
 *  - the button is ALWAYS visible and mirrors the server's 30-day rule:
 *      <= 30-day interval           -> available immediately, no countdown
 *      90 days left                 -> disabled, "Available in 60 days"
 *      89 days left                 -> disabled, "Available in 59 days"
 *      60 days left                 -> disabled, "Available in 30 days"
 *      31 days left                 -> disabled, "Available in 1 day"
 *      exactly 30 / 5 days left     -> enabled, "CONFIRM PRESENCE"
 *  - unknown trusted time -> disabled, "Checking availability…" (no device
 *    clock fallback);
 *  - in-flight and cooldown protections still apply.
 *
 * Mock state only: no manifest fetch, no wallet, no payment, no storage,
 * no upload, no sealing. framer-motion and the QR generator are stubbed as
 * in the existing CapsuleView suites.
 */

import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createElement } from "react";

import CapsuleView from "./CapsuleView";
import { heartbeatCooldownKey } from "@/lib/heartbeat/confirmPresenceCooldown";

import type { ConfirmPresenceResult } from "@/lib/heartbeat/confirmPresence";
import type { OpenAtUtc } from "@/types/manifest";

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

const CAPSULE_ID = "a5".repeat(32);
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 31, 12, 0, 0, 0);

const RECIPIENT_LABEL = "Why can the opening date change? →";

type RenderOptions = {
  authorityMode?: boolean;
  daysToOpen?: number;
  intervalDays?: number;
  trustedNowMs?: number | null;
  onConfirmPresence?: () => Promise<ConfirmPresenceResult>;
};

function renderCard({
  authorityMode = false,
  daysToOpen = 45,
  intervalDays = 30,
  trustedNowMs = NOW,
  onConfirmPresence,
}: RenderOptions) {
  return render(
    <MemoryRouter>
      <CapsuleView
        state={{
          status: "preview",
          capsuleId: CAPSULE_ID,
          authorityMode,
          title: "For the ones who open this later",
          openAt: ((NOW + daysToOpen * DAY_MS) as unknown) as OpenAtUtc,
          heartbeatInterval: intervalDays * DAY_MS,
          trustedNowMs,
          shareUrl: `https://aeterna.test/capsule/${CAPSULE_ID}#preview-fragment`,
          ...(authorityMode
            ? {
                creatorShareUrl: `https://aeterna.test/capsule/${CAPSULE_ID}#preview-fragment&c=preview`,
                onCopyCreatorLink: () => undefined,
                onConfirmPresence:
                  onConfirmPresence ??
                  (async () => "rejected" as const),
              }
            : {}),
          onCopyLink: () => undefined,
          onPrint: () => undefined,
        }}
      />
    </MemoryRouter>
  );
}

function capsuleCard(): Element | null {
  const heading = screen.getByText("AETERNA CAPSULE");
  return heading.closest('div[class*="rounded-[72px]"]');
}

function presenceLink(): Element | null {
  return document.querySelector('[data-aeterna-presence-link="recipient"]');
}

/** The Confirm Presence control, whatever its current label. */
function confirmButton(): HTMLButtonElement {
  return document.querySelector(
    "button[data-confirm-availability]"
  ) as HTMLButtonElement;
}

const labelOf = (button: Element): string =>
  (button.textContent ?? "").replace(/\s+/g, " ").trim();

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* jsdom always provides localStorage */
  }
});

afterEach(() => {
  cleanup();
});

describe("recipient card - compact Presence link", () => {
  it("shows one link directly below the capsule card, outside it", () => {
    renderCard({});

    const card = capsuleCard();
    const link = presenceLink();

    expect(card).toBeTruthy();
    expect(link).toBeTruthy();
    expect(card?.contains(link as Node)).toBe(false);
    expect(
      (card as Element).compareDocumentPosition(link as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("uses the exact approved wording, the canonical destination and gold underlined styling", () => {
    renderCard({});

    const link = screen.getByRole("link", { name: RECIPIENT_LABEL });

    expect((link.textContent ?? "").trim()).toBe(RECIPIENT_LABEL);
    expect(link.getAttribute("href")).toBe("/protocol?section=opening-presence");
    expect(link.getAttribute("target")).toBeNull();

    const cls = link.className;
    expect(cls).toContain("underline");
    expect(cls).toContain("text-amber-700");
    expect(cls).toContain("dark:text-amber-300");
    expect(cls).toContain("text-[11px]");
  });
});

describe("creator card", () => {
  it("never shows the recipient link", () => {
    renderCard({ authorityMode: true });

    expect(presenceLink()).toBeNull();
    expect(screen.queryByRole("link", { name: RECIPIENT_LABEL })).toBeNull();
    expect(
      screen.getByText(/This link contains a capability fragment/)
    ).toBeTruthy();
  });
});

describe("Confirm Presence countdown (30-day rule)", () => {
  it.each([
    ["30-day interval, 18 days left", 30, 18, "available", "CONFIRM PRESENCE"],
    ["7-day interval, 3 days left", 7, 3, "available", "CONFIRM PRESENCE"],
    ["90 days left", 90, 90, "awaiting-window", "AVAILABLE IN 60 DAYS"],
    ["89 days left", 90, 89, "awaiting-window", "AVAILABLE IN 59 DAYS"],
    ["60 days left", 90, 60, "awaiting-window", "AVAILABLE IN 30 DAYS"],
    ["31 days left", 90, 31, "awaiting-window", "AVAILABLE IN 1 DAY"],
    ["exactly 30 days left", 90, 30, "available", "CONFIRM PRESENCE"],
    ["5 days left", 90, 5, "available", "CONFIRM PRESENCE"],
  ] as const)(
    "%s",
    (_label, intervalDays, daysToOpen, expectedState, expectedLabel) => {
      renderCard({ authorityMode: true, intervalDays, daysToOpen });

      const button = confirmButton();

      // Always visible - never hidden, whatever the state.
      expect(button).toBeTruthy();
      expect(button.getAttribute("data-confirm-availability")).toBe(
        expectedState
      );
      expect(labelOf(button)).toBe(expectedLabel);
      expect(button.hasAttribute("disabled")).toBe(
        expectedState !== "available"
      );
    }
  );

  it("always shows the static CREATOR PRESENCE caption above the button", () => {
    for (const [intervalDays, daysToOpen] of [[90, 90], [90, 5], [30, 18]] as const) {
      renderCard({ authorityMode: true, intervalDays, daysToOpen });

      const caption = screen.getByText("CREATOR PRESENCE");
      const button = confirmButton();

      expect(caption).toBeTruthy();
      // Above the button in document order.
      expect(
        caption.compareDocumentPosition(button) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
      // Small, letter-spaced, gold, secondary.
      expect(caption.className).toContain("tracking-[0.22em]");
      expect(caption.className).toMatch(/text-amber-200\/45/);
      // The caption labels the button for assistive tech.
      expect(button.getAttribute("aria-describedby")).toBe(caption.id);

      cleanup();
    }
  });

  it("keeps the disabled countdown button subdued and non-clickable", () => {
    renderCard({ authorityMode: true, intervalDays: 90, daysToOpen: 90 });

    const button = confirmButton();
    const style = button.getAttribute("style") ?? "";

    expect(button.hasAttribute("disabled")).toBe(true);
    expect(style).toContain("148, 163, 184"); // existing subdued tone
    expect(style).toContain("not-allowed");
  });

  it("updates the countdown as trusted time advances (no new timer)", () => {
    // Same capsule, later trusted instant -> one day less to wait.
    renderCard({ authorityMode: true, intervalDays: 90, daysToOpen: 90 });
    expect(labelOf(confirmButton())).toBe("AVAILABLE IN 60 DAYS");

    cleanup();

    renderCard({
      authorityMode: true,
      intervalDays: 90,
      daysToOpen: 90,
      trustedNowMs: NOW + DAY_MS,
    });
    expect(labelOf(confirmButton())).toBe("AVAILABLE IN 59 DAYS");
  });

  it("shows Checking availability… when trusted time is unknown", () => {
    renderCard({
      authorityMode: true,
      intervalDays: 90,
      daysToOpen: 90,
      trustedNowMs: null,
    });

    const button = confirmButton();
    expect(button.getAttribute("data-confirm-availability")).toBe("unknown");
    expect(labelOf(button)).toBe("CHECKING AVAILABILITY…");
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("still blocks a second submission while a confirmation is in flight", async () => {
    let settle: (value: ConfirmPresenceResult) => void = () => undefined;

    const handler = () =>
      new Promise<ConfirmPresenceResult>((resolve) => {
        settle = resolve;
      });

    renderCard({
      authorityMode: true,
      intervalDays: 90,
      daysToOpen: 5,
      onConfirmPresence: handler,
    });

    const button = confirmButton();
    expect(button.hasAttribute("disabled")).toBe(false);

    fireEvent.click(button);

    await waitFor(() => expect(labelOf(button)).toBe("CONFIRMING..."));
    expect(button.hasAttribute("disabled")).toBe(true);

    await act(async () => {
      settle("rejected");
    });

    await waitFor(() => expect(labelOf(button)).toBe("CONFIRM PRESENCE"));
  });

  it("still honours the existing 15-minute success cooldown", async () => {
    localStorage.setItem(
      heartbeatCooldownKey(CAPSULE_ID),
      JSON.stringify({ v: 2, at: Date.now() })
    );

    renderCard({ authorityMode: true, intervalDays: 90, daysToOpen: 5 });

    const button = await screen.findByRole("button", { name: "WAIT 15 MIN" });
    expect(button.hasAttribute("disabled")).toBe(true);
  });
});
