/**
 * AETERNA - development-only preview route pin (R9-A51).
 *
 * The Creator Presence preview must be unreachable in a production build.
 * This suite pins the guard at SOURCE level, next to the existing Irys
 * probe precedent:
 *
 *  - App.tsx resolves the page through `import.meta.env.DEV ? lazy(...) :
 *    null`, so the dynamic import is emitted only for dev builds;
 *  - the route is registered only inside `{CalendarPresencePreview && (...)}`,
 *    so a production router never registers the path at all
 *    (`/dev/calendar-presence-preview` falls through to NotFound);
 *  - the page itself also renders nothing outside DEV (defence in depth);
 *  - no other module imports the preview page, so nothing can pull it into
 *    a non-dev entry graph.
 *
 * Pure source inspection - no build, no network.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = HERE;

const APP_SRC = readFileSync(resolve(SRC_ROOT, "App.tsx"), "utf8");
const PREVIEW_SRC = readFileSync(
  resolve(SRC_ROOT, "pages/dev/CalendarPresencePreview.tsx"),
  "utf8"
);

const ROUTE_PATH = "/dev/calendar-presence-preview";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("preview route - dev-only guard in App.tsx", () => {
  it("resolves the page through import.meta.env.DEV and a dynamic import", () => {
    expect(APP_SRC).toMatch(
      /const CalendarPresencePreview =\s*import\.meta\.env\.DEV\s*\?\s*lazy\(\(\) =>\s*import\("@\/pages\/dev\/CalendarPresencePreview"\)\)\s*:\s*null;/
    );
  });

  it("registers the route only behind the guard value", () => {
    const routeIndex = APP_SRC.indexOf(`path="${ROUTE_PATH}"`);
    expect(routeIndex).toBeGreaterThan(-1);

    // The nearest guard before the route must be the preview value itself.
    const before = APP_SRC.slice(0, routeIndex);
    const guardIndex = before.lastIndexOf("{CalendarPresencePreview && (");
    expect(guardIndex).toBeGreaterThan(-1);

    // Nothing between the guard and the route may close/stub it.
    const between = APP_SRC.slice(guardIndex, routeIndex);
    expect(between).not.toMatch(/:\s*null|null\s*}/);
  });

  it("does not register the route unconditionally", () => {
    // A bare `<Route path="/dev/...">` outside the guard would expose it in
    // production; assert the guard wraps every registration of the path.
    const registrations = APP_SRC.split(`path="${ROUTE_PATH}"`).length - 1;
    expect(registrations).toBe(1);
  });

  it("keeps the existing production routes untouched", () => {
    for (const route of [
      'path="/"',
      'path="/protocol"',
      'path="/create"',
      'path="/create/hold"',
      'path="/capsule/preview"',
      'path="/capsule/:capsuleId"',
      'path="*"',
    ]) {
      expect(APP_SRC).toContain(route);
    }
  });
});

describe("preview page - defence in depth", () => {
  it("renders nothing outside a DEV build", () => {
    expect(PREVIEW_SRC).toMatch(
      /if\s*\(!\s*import\.meta\.env\.DEV\s*\)\s*\{\s*return null;\s*\}/
    );
  });

  it("reuses the real calendar and the real recipient card", () => {
    expect(PREVIEW_SRC).toContain(
      'from "@/components/capsule/DateTimePicker"'
    );
    expect(PREVIEW_SRC).toContain('from "@/pages/capsule/CapsuleView"');
    // No bespoke second calendar / card implementation.
    expect(PREVIEW_SRC).not.toMatch(/function\s+(Calendar|CapsuleCard)\s*\(/);
  });

  it("performs no write or money path (no fetch, no signature, no seal)", () => {
    for (const forbidden of [
      "fetch(",
      "signAndSendTransaction",
      "signSolanaUSDCPayment",
      "sealCapsule",
      "uploadPreparedContainer",
      "creatorIrys",
      "openWalletPicker",
      "verifyIdentity",
    ]) {
      expect(PREVIEW_SRC).not.toContain(forbidden);
    }
  });
});

describe("preview page - single entry", () => {
  it("is imported by App.tsx only (no other module can pull it into a build graph)", () => {
    const importers = walk(SRC_ROOT).filter((file) => {
      const rel = file.replace(SRC_ROOT, "").replace(/\\/g, "/");
      if (rel === "/App.tsx") return false;
      if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) return false;
      if (rel === "/pages/dev/CalendarPresencePreview.tsx") return false;
      return readFileSync(file, "utf8").includes("CalendarPresencePreview");
    });

    expect(importers).toEqual([]);
  });
});
