// @vitest-environment node
/**
 * AETERNA — R9-A83 brand-mark contract.
 *
 * The approved circular AETERNA mark (gold "A" + keyhole, luminous blue
 * ring, dark navy disc, transparent corners) replaced the old small
 * vertical capsule emblem on exactly three surfaces: Home, the recipient
 * capsule view, and Emergency Runtime's sealed card.
 *
 * This file pins the replacement as a contract, so a later change cannot
 * silently reintroduce the old pill, duplicate the asset, or disturb the
 * functional icons that merely look capsule-like (the SEALED shield, the
 * media-type icons) or the R9-A82 opened-state behaviour.
 *
 * Source-level assertions only: the mark is decorative, so there is no
 * behaviour to exercise here. Visual results are recorded in the R9-A83
 * report instead.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");

const read = (relative: string): string =>
  readFileSync(resolve(REPO_ROOT, relative), "utf8");

const ASSET = "public/assets/aeterna-brand-mark.png";
const ASSET_URL = "/assets/aeterna-brand-mark.png";

const HOME = read("src/pages/Home.tsx");
const CAPSULE_VIEW = read("src/pages/capsule/CapsuleView.tsx");
const BRAND_MARK = read("src/components/BrandMark.tsx");
const EMERGENCY = read("public/emergency.html");

describe("R9-A83 brand mark", () => {
  it("ships exactly one shared asset, and it is a readable PNG", () => {
    const bytes = readFileSync(resolve(REPO_ROOT, ASSET));
    expect(bytes.length).toBeGreaterThan(1024);
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    expect([...bytes.subarray(0, 8)]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);

    const assetFiles = readdirSync(resolve(REPO_ROOT, "public/assets"));
    expect(assetFiles).toEqual(["aeterna-brand-mark.png"]);
  });

  it("is referenced through one root-relative public URL", () => {
    expect(BRAND_MARK).toContain(`"${ASSET_URL}"`);
    expect(HOME).toContain("<BrandMark");
    expect(CAPSULE_VIEW).toContain("<BrandMark");
    expect(EMERGENCY).toContain(`src="${ASSET_URL}"`);
    // No base64 embedding of the artwork.
    expect(BRAND_MARK).not.toContain("data:image");
    expect(EMERGENCY).not.toContain("data:image/png;base64");
  });

  it("replaces the old vertical pill on both React surfaces", () => {
    for (const source of [HOME, CAPSULE_VIEW]) {
      expect(source).not.toContain("w-8 h-14");
      expect(source).not.toContain("border-amber-400/80");
      expect(source).not.toContain("bg-gradient-to-b from-amber-400/10");
      expect(source).toContain("BrandMark");
    }
  });

  it("replaces the pill in Emergency Runtime without touching the shield", () => {
    expect(EMERGENCY).not.toContain("pill-shape");
    expect(EMERGENCY).not.toContain("pill-pulse");
    expect(EMERGENCY).toContain('class="brand-mark"');
    expect(EMERGENCY).toContain('alt="AETERNA"');

    // Functional SEALED badge (shield) is untouched.
    expect(EMERGENCY).toContain('class="sealed-badge"');
    expect(EMERGENCY).toContain("M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z");
  });

  it("keeps the media-type icons that merely look capsule-like", () => {
    const runtime = read("src/emergency/emergencyRuntime.ts");
    expect(runtime).toContain('<rect x="3" y="3" width="18" height="18" rx="2"/>');
    expect(runtime).toContain('<rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>');
    expect(runtime).not.toContain("brand-mark");
  });

  it("keeps the return control and the R9-A82 opened-state treatment intact", () => {
    expect(EMERGENCY).toContain("/* R9-A65 RETURN CONTROL:START */");
    expect(EMERGENCY).toContain("buildCapsuleHref");
    expect(EMERGENCY).toContain("loc.hash");
    expect(EMERGENCY).toContain("body.is-opened footer");
    expect(EMERGENCY).toContain("classList.toggle('is-opened', which === stateOpened)");
    expect(EMERGENCY).toContain("padding-bottom:calc(132px + env(safe-area-inset-bottom,0px))");
  });

  it("keeps the mark presentational: no state, handlers or new imports", () => {
    expect(BRAND_MARK).not.toMatch(/useState|useEffect|onClick|onLoad/);
    expect(BRAND_MARK).not.toMatch(/^import /m);
  });
});