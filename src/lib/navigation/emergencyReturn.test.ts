// @vitest-environment jsdom
/**
 * AETERNA - Emergency Runtime "Back to Main Capsule" (R9-A65).
 *
 * Executes the shipped inline source of `public/emergency.html`, so the test
 * pins the real control rather than a re-implementation.
 *
 * Contract: the capsule id comes from the canonical query handoff (or a
 * /capsule/<id> bookmark); the capability is read from location.hash at click
 * time and never appears in a query string, the DOM, storage or logs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const HTML = readFileSync(resolve(REPO_ROOT, "public/emergency.html"), "utf8");

const START = "/* R9-A65 RETURN CONTROL:START */";
const END = "/* R9-A65 RETURN CONTROL:END */";

const SOURCE = (() => {
  const start = HTML.indexOf(START);
  const end = HTML.indexOf(END);
  if (start < 0 || end < 0) {
    throw new Error("return control markers missing from emergency.html");
  }
  return HTML.slice(start, end + END.length);
})();

const CAPSULE_ID = "c".repeat(64);
const SECRET = "a".repeat(64);
const FRAGMENT = "#" + SECRET;

type FakeLocation = {
  pathname: string;
  search: string;
  hash: string;
  assign: ReturnType<typeof vi.fn>;
};

function load(loc: FakeLocation) {
  const win: Record<string, unknown> = {
    __AETERNA_EMERGENCY_NO_AUTOSTART__: true,
    location: loc,
  };
  const run = new Function("window", "document", SOURCE);
  run(win, document);
  return win["__aeternaEmergencyReturn"] as {
    buildCapsuleHref: (id: string, hash: string) => string;
    capsuleIdFromLocation: (location: FakeLocation) => string;
    activate: (location: FakeLocation, doc: Document) => string;
  };
}

function locationAt(overrides: Partial<FakeLocation> = {}): FakeLocation {
  return {
    pathname: "/emergency",
    search: "?capsuleId=" + CAPSULE_ID,
    hash: FRAGMENT,
    assign: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("R9-A65 emergency return - href construction", () => {
  it("builds /capsule/<id>#<fragment> and rejects anything else", () => {
    const api = load(locationAt());

    expect(api.buildCapsuleHref(CAPSULE_ID, FRAGMENT)).toBe(
      "/capsule/" + CAPSULE_ID + FRAGMENT
    );

    expect(api.buildCapsuleHref("not-an-id", FRAGMENT)).toBe("");
    expect(api.buildCapsuleHref("c".repeat(63), FRAGMENT)).toBe("");
    expect(api.buildCapsuleHref("C".repeat(64), FRAGMENT)).toBe("");
    expect(api.buildCapsuleHref(CAPSULE_ID, "")).toBe("");
    expect(api.buildCapsuleHref(CAPSULE_ID, "#")).toBe("");
    expect(api.buildCapsuleHref(CAPSULE_ID, "fragment")).toBe("");
  });

  it("reads the id from the query handoff and from a legacy bookmark path", () => {
    const api = load(locationAt());

    expect(api.capsuleIdFromLocation(locationAt())).toBe(CAPSULE_ID);

    expect(
      api.capsuleIdFromLocation(
        locationAt({ search: "", pathname: "/capsule/" + CAPSULE_ID })
      )
    ).toBe(CAPSULE_ID);

    expect(
      api.capsuleIdFromLocation(
        locationAt({ search: "?capsuleId=<redacted>", pathname: "/emergency" })
      )
    ).toBe("");
  });
});

describe("R9-A65 emergency return - control behaviour", () => {
  it("shows the control and returns to the capsule with the fragment intact", () => {
    const button = document.createElement("button");
    button.id = "returnToCapsule";
    button.hidden = true;
    document.body.appendChild(button);

    const loc = locationAt();
    const api = load(loc);

    const href = api.activate(loc, document);

    expect(href).toBe("/capsule/" + CAPSULE_ID + FRAGMENT);
    expect(button.hidden).toBe(false);

    button.click();

    expect(loc.assign).toHaveBeenCalledTimes(1);

    const call = loc.assign.mock.calls.at(0);
    expect(call).toBeDefined();
    const assigned = String(call ? call[0] : "");
    const [path, fragment] = assigned.split("#");

    expect(path).toBe("/capsule/" + CAPSULE_ID);
    expect(fragment).toBe(SECRET);
    expect(path).not.toContain(SECRET);
    expect(assigned.includes("?")).toBe(false);
  });

  it("stays hidden when no capability fragment is present", () => {
    const button = document.createElement("button");
    button.id = "returnToCapsule";
    button.hidden = true;
    document.body.appendChild(button);

    const loc = locationAt({ hash: "" });
    const api = load(loc);

    expect(api.activate(loc, document)).toBe("");
    expect(button.hidden).toBe(true);

    button.click();
    expect(loc.assign).not.toHaveBeenCalled();
  });

  it("is present in the emergency document and uses no query for the fragment", () => {
    expect(HTML).toContain('id="returnToCapsule"');
    expect(HTML).toContain("Back to Main Capsule");
    // No href is ever written into the DOM for the return control.
    expect(HTML).not.toContain('href="/capsule/');
  });
});