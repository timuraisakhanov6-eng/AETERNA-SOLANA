// @vitest-environment jsdom
/**
 * AETERNA — /create admission guard (pages/capsule/Create.tsx).
 *
 * A direct open without admission (hand-typed URL, bookmark, external
 * link, stale router state) must redirect Home BEFORE any editor surface
 * renders. URL / route state / React flags are NOT proof of payment — the
 * server remains the authority, and admission is the non-persisted
 * in-memory token the Home access gate grants only after a
 * server-verified outcome.
 *
 * jsdom component test. CapsuleBuilder is mocked so the test observes
 * ONLY the guard's decision (rendered vs never rendered).
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { CreateAccessProvider } from "@/context/CreateAccessContext";

const builderRenderMock = vi.fn();

vi.mock("@/components/capsule/CapsuleBuilder", () => ({
  default: () => {
    builderRenderMock();
    return React.createElement("div", { "data-testid": "builder" });
  },
}));

import Create from "@/pages/capsule/Create";

function HomeProbe() {
  return React.createElement("div", { "data-testid": "home-route" });
}

/** The exact admission shape the Home access gate grants after verification. */
const ADMISSION = {
  creatorCreditId: "creator-credit-create-guard",
  creatorIdentityId: "creator-identity-create-guard",
  account: "7XkWqBase58WalletAccountCreateGuard",
};

const tree = (options?: { seedAdmission?: boolean }) => {
  // Built imperatively (no JSX) — the provider's `children` is passed
  // positionally, exactly like the other suites in this repo.
  const routes = React.createElement(
    Routes,
    null,
    React.createElement(Route, {
      path: "/create",
      element: React.createElement(Create),
    }),
    React.createElement(Route, {
      path: "/",
      element: React.createElement(HomeProbe),
    })
  );

  const provider = options?.seedAdmission
    ? React.createElement(
        CreateAccessProvider,
        { initialAdmission: ADMISSION, children: routes }
      )
    : React.createElement(CreateAccessProvider, { children: routes });

  return React.createElement(
    MemoryRouter,
    { initialEntries: ["/create"] },
    provider
  );
};

describe("/create admission guard", () => {
  afterEach(() => {
    cleanup();
    builderRenderMock.mockClear();
  });

  it("a direct open without admission redirects Home before any editor renders", async () => {
    render(tree());

    await waitFor(() => {
      expect(screen.getByTestId("home-route")).toBeTruthy();
    });
    // The editor is never mounted — not even for one frame.
    expect(screen.queryByTestId("builder")).toBeNull();
    expect(builderRenderMock).not.toHaveBeenCalled();
  });

  it("an admitted session renders the canonical workspace", async () => {
    render(tree({ seedAdmission: true }));

    await waitFor(() => {
      expect(screen.getByTestId("builder")).toBeTruthy();
    });
    expect(screen.queryByTestId("home-route")).toBeNull();
    expect(builderRenderMock).toHaveBeenCalled();
  });
});
