/**
 * AETERNA — consent link gold light sweep (R9-A49/R9-A50) — CSS contract.
 *
 * jsdom cannot evaluate keyframes or media queries, so the contract is
 * pinned at the source level:
 *   • 4 s cycle, linear, single 1.5 s pass (37.5%);
 *   • the highlight band (38–62% of a 300% image) is fully OUTSIDE the text
 *     at BOTH ends of the sweep — nothing stays illuminated after the pass
 *     (the R9-A49 defect: with a 200% image the rest position put the band on
 *     the last letters);
 *   • gradient clipped to the text behind an @supports guard (no layout);
 *   • prefers-reduced-motion disables the animation entirely.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");

describe("consent link light sweep — CSS contract", () => {
  it("defines a 4 s linear cycle with a single ~1.5 s pass", () => {
    expect(css).toContain("@keyframes aeterna-consent-sweep");
    expect(css).toMatch(
      /animation:\s*aeterna-consent-sweep\s+4s\s+linear\s+infinite/
    );
    // 37.5% of 4 s = 1.5 s travel; 37.5%→100% (2.5 s) holds the uniform rest.
    expect(css).toMatch(/37\.5%\s*{[^}]*background-position:\s*0%\s+0/);
    expect(css).toMatch(/100%\s*{[^}]*background-position:\s*0%\s+0/);
    // The sweep starts fully LEFT of the text.
    expect(css).toMatch(/0%\s*{[^}]*background-position:\s*100%\s+0/);
  });

  it("parks the highlight fully outside the text at rest (no leftover illumination)", () => {
    // Image 300% wide -> the visible window is exactly one third of it.
    expect(css).toMatch(/background-size:\s*300%\s+100%/);
    // Band starts at 38% of the image and ends at 62%.
    expect(css).toMatch(/linear-gradient\([\s\S]*?#fcd34d\s+38%[\s\S]*?#fff6cf\s+50%[\s\S]*?#fcd34d\s+62%/);

    // NUMERIC CHECK — at rest (position 0%) the visible window covers the
    // gradient interval [0%, 33.33%]. The band begins at 38%, so the whole
    // window is base gold: the final letters CANNOT stay illuminated.
    const windowEnd = 100 / 3;
    const bandStart = 38;
    expect(windowEnd).toBeLessThan(bandStart);

    // At the start position (100%) the window covers [66.67%, 100%]; the band
    // ends at 62% — again fully outside the text.
    const windowStart = 200 / 3;
    const bandEnd = 62;
    expect(bandEnd).toBeLessThan(windowStart);
  });

  it("clips the gradient to the text behind a support guard (no layout impact)", () => {
    expect(css).toContain(".aeterna-consent-sweep");
    expect(css).toContain("-webkit-background-clip: text");
    expect(css).toContain("-webkit-text-fill-color: transparent");
    expect(css).toMatch(/@supports \(\(-webkit-background-clip: text\)/);
  });

  it("disables the animation entirely for prefers-reduced-motion: reduce", () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*{[\s\S]*?\.aeterna-consent-sweep[\s\S]*?animation:\s*none/
    );
  });
});
