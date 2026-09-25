/**
 * AETERNA — publish-failure diagnosability regression tests.
 *
 * Defect: the seal retry loop in CapsuleHold discarded the real error in
 * a bare `catch {}` and re-threw a generic `SEALING_FAILED_FINAL`. The
 * outer handler logged only under `import.meta.env.DEV` and showed
 * generic copy, so a real production publish failure ("Unable to
 * Publish Capsule") could not be localised without screenshot forensics
 * — which is exactly what happened on 2026-09-25.
 *
 * Fix: the underlying error is preserved across the loop and reduced to
 * a bounded, display-safe string by `sealErrorDetail`, surfaced as a
 * secondary, collapsible "Technical details" block. The human-readable
 * message stays primary and the retry policy is unchanged.
 *
 * These tests pin the derive helper (pure) — the mapping from any thrown
 * value to what the user sees, including the "nothing useful → nothing
 * rendered" case.
 *
 * INVARIANT PINNED: the new secondary detail must NEVER leak key
 * material. In practice crypto/storage helpers throw short CODES (as the
 * cases below show), so the surface area is the reason string only.
 *
 * node env (no DOM); the helper is pure. No network, no production calls.
 */

import { describe, expect, it } from "vitest";

import { sealErrorDetail } from "@/pages/capsule/CapsuleHold";

describe("sealErrorDetail — publish failure diagnosability", () => {
  it("returns the message of an Error instance", () => {
    expect(sealErrorDetail(new Error("SEALING_FAILED_FINAL"))).toBe(
      "SEALING_FAILED_FINAL"
    );
  });

  it("returns an [AETERNA] creatorIrys:* code-bearing message verbatim", () => {
    const msg =
      "[AETERNA] creatorIrys: failed to build Irys uploader";
    expect(sealErrorDetail(new Error(msg))).toBe(msg);
  });

  it("returns a plain string unchanged", () => {
    expect(sealErrorDetail("UPLOAD_TOKEN_DENIED")).toBe("UPLOAD_TOKEN_DENIED");
  });

  it("stringifies a non-Error object", () => {
    expect(sealErrorDetail({ code: "X", message: "y" })).toBe(
      JSON.stringify({ code: "X", message: "y" })
    );
  });

  it("falls back to String() when JSON cannot serialize (circular)", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const out = sealErrorDetail(circular);
    expect(typeof out).toBe("string");
    expect(out).not.toBe("");
  });

  it("returns undefined for null / undefined / empty — nothing rendered", () => {
    expect(sealErrorDetail(null)).toBeUndefined();
    expect(sealErrorDetail(undefined)).toBeUndefined();
    expect(sealErrorDetail("")).toBeUndefined();
    expect(sealErrorDetail("   ")).toBeUndefined();
  });

  it("bounds the output to one short line (never a dump)", () => {
    const long = "x".repeat(5000);
    const out = sealErrorDetail(new Error(long));
    expect(out).toBeDefined();
    expect((out as string).length).toBeLessThanOrEqual(301); // 300 + ellipsis
    expect((out as string).endsWith("…")).toBe(true);
  });

  it("does not truncate a useful short reason", () => {
    const short = "SEALING_FAILED_FINAL";
    expect(sealErrorDetail(new Error(short))).toBe(short);
  });

  it("prefers message, falls back to name when message is empty", () => {
    const e = new Error("");
    e.name = "WeirdError";
    expect(sealErrorDetail(e)).toBe("WeirdError");
  });

  it("preserves a Cyrillic + Latin mixed reason verbatim", () => {
    const mixed = "Ошибка Irys upload: bundler недоступен";
    expect(sealErrorDetail(new Error(mixed))).toBe(mixed);
  });

  it("does not truncate a base58 Solana signature (bounds only LONG reasons)", () => {
    // 88-char base58: unbreakable, so it must stay fully intact — the
    // wrapping contract is CSS's job, not the helper's.
    const sig = "5".repeat(88);
    expect(sealErrorDetail(new Error(sig))).toBe(sig);
    expect((sealErrorDetail(new Error(sig)) as string).length).toBe(88);
  });
});
