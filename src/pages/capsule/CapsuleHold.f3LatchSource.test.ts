/**
 * R9-A92 F3 — CapsuleHold seal latch / retry invariants (source-level).
 *
 * The latch is component state, so these are SOURCE invariants pinned
 * the same way the repo pins other component contracts: the exact guard
 * sequence, the retry decision, and the absence of any payment path.
 * Together with the unit tests of `shouldReleaseRuntimeAfterSeal` and
 * the claim-boundary classification this documents the state machine
 * implemented in the component.
 *
 * STATE MACHINE (implemented; documented in IMPLEMENTATION-REPORT.md):
 *   prepared → (uploadToken) → container upload → container cache →
 *   container claim → (trusted time) → vault upload → vault claim →
 *   publication verify → seal → seal verify → finalize
 *   exits: retryable failure (bounded, ≤3, exponential backoff) /
 *          terminal failure (no repeat) / success+finalized (cleanup)
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RAW = readFileSync(resolve(__dirname, "CapsuleHold.tsx"), "utf8").replace(
  /\r\n/g,
  "\n",
);

/**
 * Line-comment stripper for CALL-SITE assertions only.
 *
 * A documentation mention of an adapter method (`upload()/uploadContainer()`
 * in the 3BM-R7-F1 comment) is not an Irys call. Structural pins still run
 * against the raw source; only negative "this file never CALLS X" checks
 * use the stripped text. `scheme://` URLs are preserved.
 */
const CODE = RAW.split("\n")
  .map((line) => {
    const comment = line.match(/^(.*?)(?<!:)\/\/.*$/);
    return comment ? comment[1] : line;
  })
  .join("\n");

const SRC = RAW;

describe("CapsuleHold — single active attempt per capsule", () => {
  it("guards re-entry with startedRef BEFORE any work", () => {
    const guard = SRC.indexOf("startedRef.current ||");
    expect(guard).toBeGreaterThan(-1);
    // The guard sits inside the core effect, before the first fetch.
    const firstFetch = SRC.indexOf('"/api/upload-token"');
    expect(guard).toBeLessThan(firstFetch);
  });

  it("serialises cross-remount attempts with the sessionStorage seal lock", () => {
    expect(SRC).toMatch(/sessionStorage\.getItem\(\s*sealLockKey\s*\)/);
    expect(SRC).toMatch(/sessionStorage\.setItem\(\s*sealLockKey\s*,\s*canonicalLifecycleId\s*\)/);
    // A foreign lock refuses to start instead of silently superseding.
    expect(SRC).toContain("A previous capsule session is still open in this tab.");
  });

  it("a definitive conflict does NOT repeat identical requests", () => {
    // The terminal check precedes the attempt increment: a terminal
    // failure throws instead of consuming another bounded attempt.
    const terminalCheck = CODE.search(
      /if\s*\(\s*isTerminalSealFailure\s*\(\s*sealErr\s*\)\s*\)\s*\{/,
    );
    const attemptIncrement = CODE.indexOf("attempt++;");
    expect(terminalCheck).toBeGreaterThan(-1);
    expect(attemptIncrement).toBeGreaterThan(terminalCheck);
    const terminalThrow = CODE.slice(terminalCheck, attemptIncrement);
    expect(terminalThrow).toContain("throw sealErr");
  });

  it("the transient retry stays bounded (≤3 attempts, exponential backoff)", () => {
    expect(CODE).toMatch(/while\s*\(\s*attempt\s*<\s*3\s*\)/);
    expect(CODE).toMatch(/Math\.pow\(\s*2\s*,\s*attempt\s*\)/);
  });

  it("Try Again releases the latch and clears the lock explicitly", () => {
    const retry = CODE.slice(
      CODE.indexOf("const handleRetry ="),
      CODE.indexOf("/* ================= CORE LOGIC"),
    );
    expect(retry).toMatch(/startedRef\.current\s*=\s*false;/);
    expect(retry).toMatch(/sessionStorage\.removeItem\(\s*sealLockKey\s*\)/);
    expect(retry).toContain("setRetryNonce(");
  });

  it("a failed resumable attempt does NOT lock the user out", () => {
    // The error surface is the recovery surface: the retry button stays
    // reachable, and the lock is only held while the attempt runs.
    expect(SRC).toContain("onClick={handleRetry}");
    expect(SRC).toMatch(/sessionStorage\.removeItem\(\s*sealLockKey\s*\)/);
  });

  it("a retry NEVER creates another USDC transfer or entitlement payment", () => {
    expect(CODE).not.toContain("fundCreatorPaidStorage");
    expect(CODE).not.toContain("/api/storage/verify-payment");
    expect(CODE).not.toContain("/api/creator/reserve-lifecycle");
    expect(CODE).not.toContain("/api/service-payment");
    expect(CODE).not.toContain("/api/storage/quote");
  });

  it("the seal path never drives Irys directly (uploads go through the adapter only)", () => {
    // Comment-stripped: the 3BM-R7-F1 comment MENTIONS the adapter methods
    // to document that the wallet is consumed only inside them. A mention
    // is not a call site. The component itself must not invoke either.
    expect(CODE).not.toContain("uploadContainer(");
    expect(CODE).not.toContain("uploadData(");
    // And the only mentions in the raw file are that comment.
    for (const match of RAW.matchAll(/uploadContainer\s*\(/g)) {
      const before = RAW.slice(0, match.index);
      expect(before.trimEnd().endsWith("/") || /\/\/[^\n]*$/.test(before)).toBe(true);
    }
  });

  it("the Runtime release follows the F2 cleanup decision", () => {
    expect(CODE).toContain("shouldReleaseRuntimeAfterSeal(");
    // Unconditional release is gone: the guarded decision owns cleanup.
    expect(CODE.match(/await\s+destroyRuntime\s*\(/g)?.length).toBe(1);
  });
});
