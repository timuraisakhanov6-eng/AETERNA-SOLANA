/**
 * AETERNA - emergency runtime Confirm Presence availability (R9-A53).
 *
 * The emergency runtime (/emergency.html) exposes the same Confirm Presence
 * action as the primary runtime, so it must apply the same 30-day rule.
 *
 * This suite pins the WIRING in source: the rule comes from the shared
 * presentation helper, it is computed from the trusted instant the runtime
 * already fetched, the button is disabled rather than hidden, and the
 * existing subdued "cooldown" styling is reused.
 *
 * Pure source inspection - no DOM, no network.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, "emergencyRuntime.ts"), "utf8");

/** Emergency UI shell: hosts the Confirm Presence control and its styles. */
const SHELL = readFileSync(
  resolve(HERE, "../../public/emergency.html"),
  "utf8"
);

describe("emergency runtime - availability wiring", () => {
  it("uses the shared presentation rule", () => {
    expect(SRC).toContain(
      'import {\n  resolveConfirmAvailability,\n} from "@/lib/heartbeat/confirmAvailability";'
    );
    expect(SRC).toMatch(/resolveConfirmAvailability\(\{/);
  });

  it("computes availability from the trusted instant it already fetched", () => {
    // Trusted time comes from the Time Authority, not the device clock.
    expect(SRC).toContain("await getTrustedTimeSource()");
    expect(SRC).toMatch(
      /resolveConfirmAvailability\(\{\s*heartbeatInterval,\s*effectiveOpenAt,\s*trustedNowMs: nowUtc,\s*\}\)/
    );
  });

  it("passes the verdict to the Confirm Presence wiring", () => {
    expect(SRC).toContain("confirmAvailability,");
    expect(SRC).toContain("confirmAvailability: ConfirmAvailability;");
  });

  it("disables and subdues the button instead of hiding it", () => {
    expect(SRC).toMatch(
      /confirmBtn\.disabled = true;\s*confirmBtn\.classList\.add\("cooldown"\);/
    );
    // R9-A54 - the label carries the countdown / checking state.
    expect(SRC).toContain("Available in ${days}");
    expect(SRC).toContain("Checking availability…");
    // Availability never touches the wrapper visibility of the button.
    expect(SRC).not.toMatch(/confirmBtn\.style\.display\s*=\s*"none"/);
    expect(SRC).not.toMatch(/confirmWrap\.style\.display\s*=\s*"none"/);
  });

  it("re-applies availability after an attempt, so a failure cannot unlock it", () => {
    expect(SRC).toMatch(/finally\s*\{[\s\S]*?applyAvailability\(\);/);
  });

  it("shows the CREATOR PRESENCE caption above the button (R9-A55)", () => {
    // The caption lives in the shell markup, inside the same wrapper that
    // the runtime reveals, so it can never be detached from the button.
    const wrapStart = SHELL.indexOf('id="confirmWrap"');
    const captionIndex = SHELL.indexOf(
      '<p class="confirm-label" id="confirmLabel">CREATOR PRESENCE</p>'
    );
    const buttonIndex = SHELL.indexOf('id="confirmBtn"');

    expect(wrapStart).toBeGreaterThan(-1);
    expect(captionIndex).toBeGreaterThan(wrapStart);
    expect(buttonIndex).toBeGreaterThan(captionIndex);

    // Linked for assistive tech, and styled as a secondary gold caption.
    expect(SHELL).toContain('aria-describedby="confirmLabel"');
    expect(SHELL).toMatch(/\.confirm-label\{[\s\S]*letter-spacing:0\.22em/);
    expect(SHELL).toMatch(/\.confirm-label\{[\s\S]*color:rgba\(253,230,138,0\.5\)/);
  });

  it("does not read the device clock for the availability verdict", () => {
    const code = SRC
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    // The verdict expression itself must not reference a clock.
    const verdict = code.slice(
      code.indexOf("const confirmAvailability"),
      code.indexOf("const confirmAvailability") + 400
    );
    expect(verdict).not.toContain("Date.now");
    expect(verdict).not.toContain("new Date");
  });
});
