import { describe, it, expect } from "vitest";

import { readFileSync, existsSync } from "node:fs";

import { fileURLToPath } from "node:url";

import { resolve, dirname } from "node:path";

/* =========================================================
   Emergency Runtime Reachability Audit — PHASE 6H.4c
   ========================================================= */

const __dirname = dirname(fileURLToPath(import.meta.url));

const repoRoot = resolve(__dirname, "..", "..");

const emergencyHtmlPath = resolve(
  repoRoot,
  "public/emergency.html",
);

const emergencyBundlePath = resolve(
  repoRoot,
  "dist/scripts/emergency-runtime.js",
);

const openCapsuleScriptPath = resolve(
  repoRoot,
  "public/scripts/openCapsule.js",
);

const emergencyEntryPath = resolve(
  repoRoot,
  "src/emergency/emergencyRuntime.ts",
);

describe("emergencyRuntime.reachability.test.ts", () => {
  it("emergency.html exists", () => {
    expect(existsSync(emergencyHtmlPath)).toBe(true);
  });

  it("emergency.html loads the compiled emergency runtime bundle", () => {
    const html = readFileSync(emergencyHtmlPath, "utf8");

    expect(html).toContain("scripts/emergency-runtime.js");
  });

  it("emergency.html does not contain legacy inline protocol script", () => {
    const html = readFileSync(emergencyHtmlPath, "utf8");

    expect(html).not.toContain("function parseCapsuleLink");
    expect(html).not.toContain("function downloadVault");
    expect(html).not.toContain("function decryptVault");
    expect(html).not.toContain("function openCapsule");
    expect(html).not.toContain("function getTrustedNow");
    expect(html).not.toContain("function sendHeartbeatEmergency");
  });

  it("legacy openCapsule.js does not exist in public/scripts", () => {
    expect(existsSync(openCapsuleScriptPath)).toBe(false);
  });

  it("new emergency entry imports canonical opening primitives", async () => {
    const entry = readFileSync(emergencyEntryPath, "utf8");

    expect(entry).toContain(
      "parseCapsuleCapability",
    );
    expect(entry).toContain(
      "loadManifest",
    );
    expect(entry).toContain(
      "getTrustedTime",
    );
    expect(entry).toContain(
      "resolveEffectiveOpenAt",
    );
    expect(entry).toContain(
      "loadHeartbeatRecord",
    );
    expect(entry).toContain(
      "sendHeartbeat",
    );
    expect(entry).toContain(
      "openCapsule",
    );
  });

  it("new emergency entry imports canonical chunk/runtime primitives", async () => {
    const entry = readFileSync(emergencyEntryPath, "utf8");

    expect(entry).toContain(
      "resolveChunkPointers",
    );
    expect(entry).toContain(
      "createByteRuntime",
    );
  });

  it("compiled emergency runtime bundle exists after build", () => {
    expect(existsSync(emergencyBundlePath)).toBe(true);
  });

  it("emergency bundle does not contain legacy inline protocol function names", async () => {
    const bundle = readFileSync(emergencyBundlePath, "utf8");

    expect(bundle).not.toContain("function downloadVault");
    expect(bundle).not.toContain("function decryptVault");
    expect(bundle).not.toContain("function deriveKey");
    expect(bundle).not.toContain("function parseCapsuleLink");
    expect(bundle).not.toContain("function renderVault");
  });
});
