// @vitest-environment jsdom
/**
 * AETERNA - Creator Presence compact links (R9-A52).
 *
 * Pins the two links that replace the R9-A51 long blocks:
 *
 *   calendar modal -> "Learn how the Confirm Presence button works ->"
 *   recipient card -> "Why can the opening date change? ->"
 *
 * For both: exact approved wording, canonical Protocol deep link
 * (/protocol?section=opening-presence), same-tab navigation, gold +
 * underlined styling, and no explanatory paragraph, card, icon or banner.
 *
 * jsdom only. No network, wallet, payment, storage or crypto.
 */

import { describe, expect, it, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { ReactNode } from "react";

import {
  CreatorPresenceLink,
  CREATOR_PRESENCE_PROTOCOL_HREF,
  CREATOR_PRESENCE_CALENDAR_LABEL,
  CREATOR_PRESENCE_RECIPIENT_LABEL,
} from "./presence/CreatorPresenceNotice";

const norm = (el: Element | null): string =>
  (el?.textContent ?? "").replace(/\s+/g, " ").trim();

const ProtocolProbe = () => {
  const location = useLocation();
  return (
    <div data-testid="protocol-route">
      {location.pathname}
      {location.search}
    </div>
  );
};

const tree = (node: ReactNode) => (
  <MemoryRouter initialEntries={["/"]}>
    <Routes>
      <Route path="/" element={<div>{node}</div>} />
      <Route path="/protocol" element={<ProtocolProbe />} />
    </Routes>
  </MemoryRouter>
);

afterEach(() => {
  cleanup();
});

describe("approved wording", () => {
  it("uses the exact R9-A52 labels", () => {
    expect(CREATOR_PRESENCE_CALENDAR_LABEL).toBe(
      "Learn how the Confirm Presence button works →"
    );
    expect(CREATOR_PRESENCE_RECIPIENT_LABEL).toBe(
      "Why can the opening date change? →"
    );
    expect(CREATOR_PRESENCE_PROTOCOL_HREF).toBe(
      "/protocol?section=opening-presence"
    );
  });
});

describe.each([
  ["calendar", CREATOR_PRESENCE_CALENDAR_LABEL],
  ["recipient", CREATOR_PRESENCE_RECIPIENT_LABEL],
] as const)("%s link", (location, label) => {
  it("renders only the compact label — no paragraph, card, icon or banner", () => {
    render(
      tree(<CreatorPresenceLink location={location} label={label} />)
    );

    const link = screen.getByRole("link", { name: label });
    expect(norm(link)).toBe(label);
    // Exactly one element in the tree: the link itself.
    expect(document.body.querySelectorAll("*").length).toBeLessThanOrEqual(12);
    expect(document.querySelector("svg")).toBeNull();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(norm(document.body)).not.toMatch(/postponed|renew|interval/i);
  });

  it("targets the canonical Protocol section in the same tab", () => {
    render(
      tree(<CreatorPresenceLink location={location} label={label} />)
    );

    const link = screen.getByRole("link", { name: label });
    expect(link.getAttribute("href")).toBe(
      "/protocol?section=opening-presence"
    );
    expect(link.getAttribute("target")).toBeNull();
    expect(link.getAttribute("rel")).toBeNull();
    expect(link.getAttribute("href")).not.toContain("#");
  });

  it("is gold and underlined, brighter on hover", () => {
    render(
      tree(<CreatorPresenceLink location={location} label={label} />)
    );

    const link = screen.getByRole("link", { name: label });
    const cls = link.className;

    expect(cls).toContain("underline");
    // Gold accent, theme-aware so it stays legible on light and dark.
    expect(cls).toContain("text-amber-700");
    expect(cls).toContain("dark:text-amber-300");
    // Hover brightens.
    expect(cls).toMatch(/hover:text-amber-600/);
    expect(cls).toMatch(/dark:hover:text-amber-200/);
    // Understated size.
    expect(cls).toContain("text-[11px]");
  });

  it("navigates in the same document to the deep link", async () => {
    render(
      tree(<CreatorPresenceLink location={location} label={label} />)
    );

    fireEvent.click(screen.getByRole("link", { name: label }));

    await waitFor(() =>
      expect(screen.getByTestId("protocol-route")).toBeTruthy()
    );
    expect(screen.getByTestId("protocol-route").textContent).toBe(
      "/protocol?section=opening-presence"
    );
  });
});
