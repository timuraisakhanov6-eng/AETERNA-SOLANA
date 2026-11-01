// @vitest-environment jsdom
/**
 * AETERNA - context-aware Back from the Protocol (R9-A57).
 *
 * Covers the four entry points, tab switching, browser-history return and
 * the capsule-secret boundary:
 *
 *   home    -> "/"
 *   create  -> "/create"
 *   capsule -> previous history entry (its #fragment restored by the
 *              browser; never copied into the Protocol URL or state)
 *   direct  -> "/"
 *
 * jsdom only. No network, wallet, payment, storage or crypto.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";

import Protocol from "./Protocol";
import { CreatorPresenceLink } from "@/components/capsule/presence/CreatorPresenceNotice";
import { DateTimePickerModal } from "@/components/capsule/DateTimePickerModal";
import {
  protocolReturnState,
} from "@/lib/navigation/protocolReturn";

import type { Location } from "react-router-dom";

const CAPSULE_ID = "a5".repeat(32);
const SECRET = "super-secret-recipient-fragment";

/** Renders exactly what the router sees, including the raw state. */
const LocationProbe = () => {
  const location = useLocation();
  return (
    <div data-testid="loc">
      {JSON.stringify({
        pathname: location.pathname,
        search: location.search,
        hash: location.hash,
        state: location.state ?? null,
      })}
    </div>
  );
};

const CapsuleProbe = () => (
  <div>
    <p>capsule page</p>
    <CreatorPresenceLink
      location="recipient"
      label="Why can the opening date change? →"
    />
    <LocationProbe />
  </div>
);

const CreateProbe = () => (
  <div>
    <p>create page</p>
    <DateTimePickerModal
      date={new Date(Date.UTC(2030, 5, 1, 12, 0, 0, 0))}
      time="12:00"
      onDateChange={() => undefined}
      onTimeChange={() => undefined}
      trigger={<button type="button">open calendar</button>}
    />
    <LocationProbe />
  </div>
);

const tree = (entries: (string | Partial<Location> & { state?: unknown })[]) => (
  <MemoryRouter initialEntries={entries as never[]} initialIndex={entries.length - 1}>
    <Routes>
      <Route path="/" element={<LocationProbe />} />
      <Route path="/create" element={<CreateProbe />} />
      <Route path="/capsule/:capsuleId" element={<CapsuleProbe />} />
      <Route
        path="/protocol"
        element={
          <>
            <Protocol />
            <LocationProbe />
          </>
        }
      />
    </Routes>
  </MemoryRouter>
);

const locationNow = (): {
  pathname: string;
  search: string;
  hash: string;
  state: unknown;
} => JSON.parse(screen.getByTestId("loc").textContent ?? "{}");

const backControl = () => screen.getByText("← Back");

afterEach(() => {
  cleanup();
});

describe("Protocol footer - destination by entry point", () => {
  it("returns Home when opened from Home", () => {
    render(
      tree([{ pathname: "/protocol", state: protocolReturnState("home") }])
    );

    expect(screen.queryByRole("link", { name: "← Back to Home" })).toBeNull();
    const back = screen.getByRole("link", { name: "← Back" });
    expect(back.getAttribute("href")).toBe("/");
    expect(back.getAttribute("target")).toBeNull();

    fireEvent.click(back);

    expect(locationNow()).toMatchObject({ pathname: "/", search: "", hash: "" });
  });

  it("returns to the creation page when opened from the calendar", () => {
    render(
      tree([
        {
          pathname: "/protocol",
          search: "?section=opening-presence",
          state: protocolReturnState("create"),
        },
      ])
    );

    fireEvent.click(backControl());

    expect(locationNow().pathname).toBe("/create");
  });

  it("falls back to Home for a direct visit", () => {
    render(tree(["/protocol"]));

    const back = screen.getByRole("link", { name: "← Back" });
    expect(back.getAttribute("href")).toBe("/");

    fireEvent.click(back);
    expect(locationNow().pathname).toBe("/");
  });

  it("falls back to Home when the state is foreign or malformed", () => {
    render(
      tree([{ pathname: "/protocol", state: { some: "other app" } }])
    );

    expect(
      screen.getByRole("link", { name: "← Back" }).getAttribute("href")
    ).toBe("/");
  });
});

describe("Protocol footer - recipient capsule (secret boundary)", () => {
  const capsuleEntry = `/capsule/${CAPSULE_ID}#${SECRET}`;
  const protocolEntry = {
    pathname: "/protocol",
    search: "?section=opening-presence",
    state: protocolReturnState("capsule"),
  };

  it("keeps the capsule secret out of the Protocol URL and state", () => {
    render(tree([capsuleEntry, protocolEntry]));

    const now = locationNow();

    expect(now.pathname).toBe("/protocol");
    expect(now.search).toBe("?section=opening-presence");
    expect(now.hash).toBe("");

    // Neither the router location nor the navigation state may carry the
    // fragment or the capsule id.
    const serialized = JSON.stringify(now);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(CAPSULE_ID);
    expect(serialized).not.toContain("#");

    const state = JSON.stringify(protocolEntry.state);
    expect(state).not.toContain(SECRET);
    expect(state).not.toContain(CAPSULE_ID);
    expect(state).not.toContain("#");
  });

  it("returns to the same capsule through browser history, fragment intact", () => {
    render(tree([capsuleEntry, protocolEntry]));

    // History return is a control, not a link with a constructed URL.
    expect(screen.queryByRole("link", { name: "← Back" })).toBeNull();
    const back = screen.getByRole("button", { name: "← Back" });
    expect(back.getAttribute("data-protocol-back")).toBe("history");
    expect(back.getAttribute("href")).toBeNull();

    fireEvent.click(back);

    const now = locationNow();
    expect(now.pathname).toBe(`/capsule/${CAPSULE_ID}`);
    expect(now.hash).toBe(`#${SECRET}`);
  });

  it("keeps the return context while switching Protocol tabs", () => {
    render(tree([capsuleEntry, protocolEntry]));

    fireEvent.click(screen.getByRole("link", { name: "How It Works" }));
    expect(locationNow().search).toBe("");

    fireEvent.click(screen.getByRole("link", { name: "Opening & Presence" }));
    expect(locationNow().search).toBe("?section=opening-presence");

    // Still a history return, and it still lands on the capsule.
    fireEvent.click(screen.getByRole("button", { name: "← Back" }));

    expect(locationNow().pathname).toBe(`/capsule/${CAPSULE_ID}`);
    expect(locationNow().hash).toBe(`#${SECRET}`);
  });

  it("does not add history entries while switching tabs", () => {
    render(tree([capsuleEntry, protocolEntry]));

    fireEvent.click(screen.getByRole("link", { name: "How It Works" }));
    fireEvent.click(screen.getByRole("link", { name: "Opening & Presence" }));

    // One history step must skip the tab switches and reach the capsule.
    fireEvent.click(screen.getByRole("button", { name: "← Back" }));
    expect(locationNow().pathname).toBe(`/capsule/${CAPSULE_ID}`);
  });
});

describe("Protocol footer - tab switching keeps the context", () => {
  it("keeps /create as the destination after switching tabs", () => {
    render(
      tree([
        {
          pathname: "/protocol",
          state: protocolReturnState("create"),
        },
      ])
    );

    fireEvent.click(screen.getByRole("link", { name: "Opening & Presence" }));

    const back = screen.getByRole("link", { name: "← Back" });
    expect(back.getAttribute("href")).toBe("/create");

    fireEvent.click(back);
    expect(locationNow().pathname).toBe("/create");
  });

  it("keeps the ?section= deep link working", () => {
    render(
      tree([
        {
          pathname: "/protocol",
          search: "?section=opening-presence",
          state: protocolReturnState("home"),
        },
      ])
    );

    expect(
      screen.getByRole("link", { name: "Opening & Presence" }).getAttribute(
        "aria-current"
      )
    ).toBe("page");
    expect(
      screen.getByRole("heading", { name: "Creator Presence" })
    ).toBeTruthy();
  });
});

describe("in-app Protocol links carry their origin", () => {
  it("recipient capsule link -> capsule origin, same tab", () => {
    render(tree([`/capsule/${CAPSULE_ID}#${SECRET}`]));

    const link = screen.getByRole("link", {
      name: "Why can the opening date change? →",
    });
    expect(link.getAttribute("target")).toBeNull();
    expect(link.getAttribute("href")).toBe("/protocol?section=opening-presence");

    fireEvent.click(link);

    expect(locationNow()).toMatchObject({
      pathname: "/protocol",
      search: "?section=opening-presence",
      state: protocolReturnState("capsule"),
    });
    expect(JSON.stringify(locationNow())).not.toContain(SECRET);
  });

  it("calendar modal link -> create origin, same tab, dialog unchanged", () => {
    render(tree(["/create"]));

    fireEvent.click(screen.getByRole("button", { name: "open calendar" }));
    const dialog = screen.getByRole("dialog");

    const link = dialog.querySelector(
      '[data-aeterna-presence-link="calendar"]'
    ) as HTMLAnchorElement;

    expect(link).toBeTruthy();
    expect(link.textContent?.trim()).toBe(
      "Learn how the Confirm Presence button works →"
    );
    expect(link.getAttribute("target")).toBeNull();
    expect(link.getAttribute("href")).toBe("/protocol?section=opening-presence");

    fireEvent.click(link);

    expect(locationNow()).toMatchObject({
      pathname: "/protocol",
      search: "?section=opening-presence",
      state: protocolReturnState("create"),
    });

    // And the footer returns to the creation page.
    fireEvent.click(backControl());
    expect(locationNow().pathname).toBe("/create");
  });

  it("never opens a new tab from the footer control", () => {
    render(
      tree([{ pathname: "/protocol", state: protocolReturnState("home") }])
    );

    const back = screen.getByRole("link", { name: "← Back" });
    expect(back.getAttribute("target")).toBeNull();
    expect(back.getAttribute("rel")).toBeNull();
  });
});
