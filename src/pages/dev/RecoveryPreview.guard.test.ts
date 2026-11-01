/**
 * AETERNA - dev-only recovery preview guard (R9-A65).
 *
 * `/dev/recovery-preview` must never exist in a production build. Pinned at
 * source level, next to the existing preview precedents:
 *
 *  - App.tsx resolves the page through `import.meta.env.DEV ? lazy(...) : null`,
 *    so the dynamic import is emitted for dev builds only;
 *  - the route is registered only inside `{RecoveryPreview && (...)}`;
 *  - the page renders nothing outside DEV (defence in depth);
 *  - nothing else imports the page.
 *
 * Pure source inspection - no build, no network.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(HERE, "../..");

const APP_SRC = readFileSync(resolve(SRC_ROOT, "App.tsx"), "utf8");
const PREVIEW_SRC = readFileSync(resolve(HERE, "RecoveryPreview.tsx"), "utf8");

const ROUTE_PATH = "/dev/recovery-preview";

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

describe("recovery preview - dev-only guard in App.tsx", () => {
  it("resolves the page through import.meta.env.DEV and a dynamic import", () => {
    expect(APP_SRC).toMatch(
      /const RecoveryPreview =\s*import\.meta\.env\.DEV\s*\?\s*lazy\(\(\) =>\s*import\("@\/pages\/dev\/RecoveryPreview"\)\)\s*:\s*null;/
    );
  });

  it("registers the route only behind the guard value", () => {
    const routeIndex = APP_SRC.indexOf('path="' + ROUTE_PATH + '"');
    expect(routeIndex).toBeGreaterThan(-1);

    const before = APP_SRC.slice(0, routeIndex);
    const guardIndex = before.lastIndexOf("{RecoveryPreview && (");
    expect(guardIndex).toBeGreaterThan(-1);

    const between = APP_SRC.slice(guardIndex, routeIndex);
    expect(between).not.toMatch(/:\s*null|null\s*}/);
  });

  it("registers the path exactly once", () => {
    const registrations = APP_SRC.split('path="' + ROUTE_PATH + '"').length - 1;
    expect(registrations).toBe(1);
  });
});

describe("recovery preview - defence in depth", () => {
  it("renders nothing outside a DEV build", () => {
    expect(PREVIEW_SRC).toMatch(
      /if\s*\(!\s*import\.meta\.env\.DEV\s*\)\s*\{\s*return null;\s*\}/
    );
  });

  it("performs no network, storage, wallet or payment work", () => {
    for (const forbidden of [
      "fetch(",
      "localStorage",
      "sessionStorage",
      "indexedDB",
      "signAndSendTransaction",
      "signSolanaUSDCPayment",
      "sealCapsule",
      "openWalletPicker",
      "sendHeartbeat",
    ]) {
      expect(PREVIEW_SRC).not.toContain(forbidden);
    }
  });

  it("is imported by App.tsx only", () => {
    const importers = walk(SRC_ROOT).filter((file) => {
      const rel = file.replace(SRC_ROOT, "").replace(/\\/g, "/");
      if (rel === "/App.tsx") return false;
      if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) return false;
      if (rel === "/pages/dev/RecoveryPreview.tsx") return false;
      return readFileSync(file, "utf8").includes("RecoveryPreview");
    });

    expect(importers).toEqual([]);
  });

  it("covers every supervisor state in the preview", () => {
    for (const surface of [
      "normal",
      "attempt-1",
      "attempt-2",
      "recovery-panel",
      "emergency-view",
      "back-to-capsule",
    ]) {
      expect(PREVIEW_SRC).toContain(surface);
    }
  });
});