// @vitest-environment jsdom
/**
 * AETERNA - recipient capsule footer (R9-A59).
 *
 * The recipient page's "A non-custodial digital time capsule" tagline is
 * replaced by the single modern X mark, placed directly below the gold
 * Protocol link. Pins:
 *
 *  - tagline gone on the recipient view, kept on the creator/authority view;
 *  - exactly one X link, glyph only (no text), official profile URL that is
 *    identical to Home's, new tab + rel="noopener noreferrer";
 *  - no capsule id / fragment / access data in the external URL;
 *  - ordering: capsule card -> Protocol link -> X mark;
 *  - nothing else in the capsule card changed.
 *
 * Mock state only: no manifest fetch, no wallet, no payment, no storage,
 * no upload, no sealing.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import CapsuleView from "./CapsuleView";

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

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME_SRC = readFileSync(resolve(HERE, "../Home.tsx"), "utf8");
const VIEW_SRC = readFileSync(resolve(HERE, "./CapsuleView.tsx"), "utf8");

const CAPSULE_ID = "a5".repeat(32);
const SECRET = "recipient-secret-fragment";
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 31, 12, 0, 0, 0);
const TAGLINE = "A non-custodial digital time capsule";
const X_URL = "https://x.com/aeternacapsule";

function renderCard(authorityMode: boolean) {
  return render(
    <MemoryRouter>
      <CapsuleView
        state={{
          status: "preview",
          capsuleId: CAPSULE_ID,
          authorityMode,
          title: "For the ones who open this later",
          openAt: ((NOW + 45 * DAY_MS) as unknown) as OpenAtUtc,
          heartbeatInterval: 90 * DAY_MS,
          trustedNowMs: NOW,
          shareUrl: `https://aeterna.test/capsule/${CAPSULE_ID}#${SECRET}`,
          ...(authorityMode
            ? {
                creatorShareUrl: `https://aeterna.test/capsule/${CAPSULE_ID}#${SECRET}&c=preview`,
                onCopyCreatorLink: () => undefined,
                onConfirmPresence: async () => "rejected" as const,
              }
            : {}),
          onCopyLink: () => undefined,
          onPrint: () => undefined,
        }}
      />
    </MemoryRouter>
  );
}

const xLink = (): HTMLAnchorElement | null =>
  document.querySelector("[data-capsule-x-link]");

const pageText = (): string =>
  (document.body.textContent ?? "").replace(/\s+/g, " ");

afterEach(() => {
  cleanup();
});

describe("recipient capsule page - X mark replaces the tagline", () => {
  it("removes the tagline entirely", () => {
    renderCard(false);

    expect(pageText()).not.toContain(TAGLINE);
    expect(screen.queryByText(TAGLINE)).toBeNull();
  });

  it("renders exactly one X link, glyph only, with the approved label", () => {
    renderCard(false);

    const link = xLink();
    expect(link).toBeTruthy();
    expect(link?.getAttribute("aria-label")).toBe("AETERNA on X");
    // Icon only: no text, no "Follow …" copy.
    expect((link?.textContent ?? "").trim()).toBe("");
    expect(pageText()).not.toMatch(/follow/i);

    // The modern X glyph, not the legacy bird.
    const path = link?.querySelector("path")?.getAttribute("d") ?? "";
    expect(path).toContain("M18.244 2.25h3.308");
    expect(link?.querySelectorAll("svg")).toHaveLength(1);
    expect(link?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");

    // Exactly one external X link on the page.
    expect(
      document.querySelectorAll('a[href="https://x.com/aeternacapsule"]')
    ).toHaveLength(1);
  });

  it("uses the same official destination as Home and opens a new tab safely", () => {
    renderCard(false);

    const link = xLink();
    expect(link?.getAttribute("href")).toBe(X_URL);
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");

    // Home carries the very same destination (and the same glyph).
    expect(HOME_SRC).toContain(`href="${X_URL}"`);
    expect(HOME_SRC).toContain("M18.244 2.25h3.308");
  });

  it("never transmits capsule access data", () => {
    renderCard(false);

    const href = xLink()?.getAttribute("href") ?? "";

    expect(href).not.toContain("#");
    expect(href).not.toContain(CAPSULE_ID);
    expect(href).not.toContain(SECRET);
    expect(href).not.toMatch(/\?/);
    expect(href).toBe(X_URL);
  });

  it("sits directly below the Protocol link, after the capsule card", () => {
    renderCard(false);

    const link = xLink() as HTMLElement;
    const protocolLink = screen.getByRole("link", {
      name: "Why can the opening date change? →",
    });
    const cardHeading = screen.getByText("AETERNA CAPSULE");

    // card -> Protocol link -> X mark
    expect(
      cardHeading.compareDocumentPosition(protocolLink) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      protocolLink.compareDocumentPosition(link) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    // Outside the card shell, with the modest gap class.
    const card = cardHeading.closest('div[class*="rounded-[72px]"]');
    expect(card?.contains(link)).toBe(false);
    expect(link.parentElement?.className).toContain("mt-5");
  });

  it("keeps the capsule card, Recipient Link and Protocol link intact", () => {
    renderCard(false);

    expect(screen.getByText("AETERNA CAPSULE")).toBeTruthy();
    expect(screen.getByText(/^Opens on /)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Copy recipient link" })
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Why can the opening date change? →" })
    ).toBeTruthy();
    // No creator-only controls on the recipient page.
    expect(screen.queryByRole("button", { name: "CREATOR LINK" })).toBeNull();
    expect(screen.queryByRole("button", { name: "CONFIRM PRESENCE" })).toBeNull();
  });
});

describe("creator/authority capsule page", () => {
  it("keeps the existing tagline and shows no X mark", () => {
    renderCard(true);

    expect(screen.getByText(TAGLINE)).toBeTruthy();
    expect(xLink()).toBeNull();
    expect(
      screen.queryByRole("link", { name: "AETERNA on X" })
    ).toBeNull();
  });
});

describe("Home is not affected by this change", () => {
  it("still carries its tagline and its own X link", () => {
    expect(HOME_SRC).toContain(TAGLINE);
    expect(HOME_SRC).toContain(`href="${X_URL}"`);
    expect(HOME_SRC).toContain('aria-label="X (Twitter)"');
  });

  it("keeps the two marks separate, with the tagline only on the creator view", () => {
    expect(VIEW_SRC).toContain('aria-label="AETERNA on X"');
    // The tagline survives exactly once, inside the authorityMode footer.
    expect(VIEW_SRC.match(/A non-custodial digital time capsule/g) ?? []).toHaveLength(1);
    expect(VIEW_SRC).toMatch(/\{authorityMode && \(\s*<footer/);
    // The X mark is gated to the recipient view.
    expect(VIEW_SRC).toMatch(/\{!authorityMode && \(\s*<div className="mt-5 flex justify-center">/);
  });
});
