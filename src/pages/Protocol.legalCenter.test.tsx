// @vitest-environment jsdom
/**
 * AETERNA — Protocol page (R9-A45 FINAL) — single-document suite.
 *
 * ONE user-facing document with exactly two sections:
 *   - How It Works (default), ending with the "Important Limitations and
 *     User Responsibility" block,
 *   - Opening & Presence (?section=opening-presence), which does NOT repeat
 *     the responsibility block.
 *
 * Pins the owner-approved wording (Capsule Access, Creator Presence 30-day
 * rule, Creator Credit consumption), the limitation subsections, the absence
 * of Terms/Privacy and of the creation CTA, and "Back to Home".
 *
 * jsdom component test. No network, no wallet, no payment.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Protocol from "@/pages/Protocol";

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Protocol />
    </MemoryRouter>
  );
}

const bodyText = (): string =>
  (document.body.textContent ?? "").replace(/\s+/g, " ");

describe("AETERNA Protocol page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows exactly the two intended section tabs, with How It Works selected by default", () => {
    renderAt("/protocol");

    const tabLabels = screen
      .getAllByRole("link")
      .map((a) => a.textContent?.trim())
      .filter(
        (label) => label === "How It Works" || label === "Opening & Presence"
      );
    expect(tabLabels).toEqual(["How It Works", "Opening & Presence"]);

    expect(
      screen.getByRole("link", { name: "How It Works" }).getAttribute(
        "aria-current"
      )
    ).toBe("page");
    expect(
      screen.getByRole("link", { name: "Opening & Presence" }).getAttribute(
        "aria-current"
      )
    ).toBeNull();

    expect(
      screen.getByRole("heading", { name: "AETERNA Protocol" })
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "What Is an AETERNA Capsule?" })
    ).toBeTruthy();
  });

  it("switches to Opening & Presence", () => {
    renderAt("/protocol");

    fireEvent.click(screen.getByRole("link", { name: "Opening & Presence" }));

    expect(
      screen.getByRole("link", { name: "Opening & Presence" }).getAttribute(
        "aria-current"
      )
    ).toBe("page");
    expect(
      screen.getByRole("heading", { name: "How a Capsule Opens" })
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "What Is an AETERNA Capsule?" })
    ).toBeNull();
  });

  it("opens the second section directly from /protocol?section=opening-presence", () => {
    renderAt("/protocol?section=opening-presence");

    expect(
      screen.getByRole("link", { name: "Opening & Presence" }).getAttribute(
        "aria-current"
      )
    ).toBe("page");
    expect(
      screen.getByRole("heading", { name: "Creator Presence" })
    ).toBeTruthy();
  });

  it("fails closed to How It Works for unknown section values", () => {
    renderAt("/protocol?section=bogus");

    expect(
      screen.getByRole("link", { name: "How It Works" }).getAttribute(
        "aria-current"
      )
    ).toBe("page");
    expect(
      screen.getByRole("heading", { name: "What Is an AETERNA Capsule?" })
    ).toBeTruthy();
  });

  it("explains the always-present Confirm Presence button and its availability window (R9-A52)", () => {
    renderAt("/protocol?section=opening-presence");

    const text = bodyText();
    expect(text).toContain("Creator Presence is part of every AETERNA capsule.");
    expect(text).toContain(
      "The Confirm Presence button is always displayed, but its availability depends on the opening interval."
    );
    expect(text).toContain(
      "30 days or less: the button is available throughout the interval."
    );
    expect(text).toContain(
      "More than 30 days: the button becomes available when 30 days remain before the scheduled opening."
    );
    expect(text).toContain(
      "Each successful confirmation renews the opening period."
    );
    expect(text).toContain(
      "Missing a confirmation does not itself postpone the opening date."
    );
    expect(text).toContain(
      "The latest opening date is displayed on the capsule page."
    );
  });

  it("no longer claims that a missed confirmation postpones the opening date (R9-A52 correction)", () => {
    renderAt("/protocol?section=opening-presence");

    const text = bodyText();
    // The R9-A45 wording that survived into R9-A51 is gone.
    expect(text).not.toMatch(/missed\s+confirmation\s+extends/i);
    expect(text).not.toMatch(/a missed confirmation[^.]{0,40}postpones/i);
    expect(text).not.toMatch(/confirmations? stop/i);
    // The correction is explicit and affirmative.
    expect(text).toContain(
      "Missing a confirmation does not itself postpone the opening date."
    );
    // Presence is not described as an opt-in anywhere on the page.
    expect(text).not.toMatch(/when enabled/i);
    expect(text).not.toMatch(/if creator presence is enabled/i);
  });

  it("preserves the owner-approved Capsule Access wording exactly", () => {
    renderAt("/protocol");

    expect(bodyText()).toContain(
      "An AETERNA capsule remains accessible through its complete link before and after opening."
    );
    expect(bodyText()).toContain(
      "While sealed, the capsule displays its current status and opening information. Once the opening conditions are met, its contents become available for viewing and download."
    );
  });

  it("describes Creator Credit consumption against successful publication and sealing", () => {
    renderAt("/protocol");

    expect(bodyText()).toContain(
      "A Creator Credit is consumed only after a capsule has been successfully published and sealed. If the creation process does not finish successfully, the credit remains available for another attempt."
    );
  });

  it("shows the Important Limitations and User Responsibility block with all five subsections in How It Works", () => {
    renderAt("/protocol");

    expect(
      screen.getByRole("heading", {
        name: "Important Limitations and User Responsibility",
      })
    ).toBeTruthy();

    for (const heading of [
      "Encryption and Access",
      "Lost Links and Recovery",
      "Storage and Availability",
      "Content and Legal Responsibility",
      "Limitation of Liability",
    ]) {
      expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
    }

    const text = bodyText();
    expect(text).toContain(
      "AETERNA does not receive or store the secret information required to decrypt capsule contents. AETERNA cannot read, view, decrypt, recover, or modify the private contents of a capsule."
    );
    expect(text).toContain(
      "If the complete capsule link or its secret component is lost, AETERNA cannot recover, recreate, or replace it. AETERNA cannot restore access to the capsule."
    );
    expect(text).toContain(
      "Capsule storage relies on independent network infrastructure and external services that are outside AETERNA's direct control."
    );
    expect(text).toContain(
      "To the extent permitted by applicable law, AETERNA is not responsible for loss of access resulting from lost or disclosed capsule links, loss of secret information controlled by the creator, or interruptions and failures of independent storage networks and external services."
    );
    expect(text).toContain(
      "Nothing in this Protocol excludes or limits liability that cannot be excluded or limited under applicable law."
    );
  });

  it("does not repeat the responsibility block in Opening & Presence", () => {
    renderAt("/protocol?section=opening-presence");

    expect(
      screen.queryByRole("heading", {
        name: "Important Limitations and User Responsibility",
      })
    ).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Content and Legal Responsibility" })
    ).toBeNull();
  });

  it("has no Terms of Service or Privacy Policy tabs or links any more", () => {
    renderAt("/protocol");

    expect(screen.queryByRole("link", { name: "Terms" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Privacy" })).toBeNull();
    expect(bodyText()).not.toContain("Terms of Service");
    expect(bodyText()).not.toContain("Privacy Policy");
  });

  it("has no creation CTA but keeps a context-aware <- Back control", () => {
    renderAt("/protocol");

    expect(screen.queryByText(/Proceed to capsule creation/i)).toBeNull();

    // R9-A57: the fixed "Back to Home" label is gone; the control reads
    // "<- Back" and, without a trusted in-app return context, points Home.
    expect(screen.queryByRole("link", { name: "← Back to Home" })).toBeNull();

    const back = screen.getByRole("link", { name: "← Back" });
    expect(back.getAttribute("href")).toBe("/");
    expect(back.getAttribute("data-protocol-back")).toBe("/");
  });
});
