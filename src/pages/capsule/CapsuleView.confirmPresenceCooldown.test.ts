/**
 * AETERNA — CONFIRM PRESENCE client-side cooldown guard (v2, node env).
 *
 * SCOPE: the client-side cooldown state machine ONLY. No server,
 * no network, no wallet, no payment, no crypto.
 *
 * ROOT CAUSE FIXED: the click handler previously armed the 15-min
 * cooldown and persisted its timestamp on ANY outcome, because
 * `onConfirmPresence` returned `Promise<void>` and the result was
 * discarded. A rejected / expired / network-error / thrown attempt
 * therefore showed "WAIT 15 MIN" and wrote a cooldown timestamp
 * while `lastConfirmedAt` stayed null on the server.
 *
 * HARDENING (v2): the cooldown marker is now VERSIONED + NAMESPACED
 * and stores `{ v: 2, at }` as JSON. A legacy key written by an
 * earlier buggy build (`aeterna-heartbeat-${capsuleId}`, bare number)
 * is NEVER trusted, can never arm a cooldown, and is best-effort
 * purged. Only `aeterna-heartbeat-confirmed-v2-${capsuleId}` with a
 * valid v2 payload may arm WAIT 15 MIN.
 *
 * Rendering strategy mirrors CapsuleBuilder.waitingState.test.ts: the
 * repo's node runtime is used, so the interactive state machine is
 * exercised through the pure exported helpers with an injected clock
 * and an in-memory storage double — no DOM, no fetch.
 */

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  HEARTBEAT_COOLDOWN_MS,
  HEARTBEAT_CONFIRMATION_SCHEMA_VERSION,
  heartbeatCooldownKey,
  legacyHeartbeatCooldownKey,
  isCooldownActive,
  isConfirmedResult,
  readConfirmedRecord,
  remainingCooldownMs,
  runConfirmPresenceAttempt,
  purgeLegacyCooldown,
  clearInvalidConfirmedRecord,
} from "@/lib/heartbeat/confirmPresenceCooldown";

import type { ConfirmPresenceResult } from "@/lib/heartbeat/confirmPresence";

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEW_SRC = readFileSync(resolve(HERE, "CapsuleView.tsx"), "utf8");
const CONTROLLER_SRC = readFileSync(resolve(HERE, "CapsuleController.tsx"), "utf8");
const MODULE_SRC = readFileSync(
  resolve(HERE, "../../lib/heartbeat/confirmPresenceCooldown.ts"),
  "utf8"
);

/* ===== in-memory Storage double ===== */

function makeStorage(initial?: Record<string, string>) {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    _dump: () => Object.fromEntries(map),
    _has: (k: string) => map.has(k),
  };
}

const CID = "327c0425565b5801d112c87a43e6651f07eabb9afde8831562c44b4ec3702b40";
const KEY = heartbeatCooldownKey(CID);            // v2 namespaced
const LEGACY_KEY = legacyHeartbeatCooldownKey(CID); // old unversioned
const T = 1_790_000_000_000; // arbitrary finite clock

function v2(at: number): string {
  return JSON.stringify({ v: HEARTBEAT_CONFIRMATION_SCHEMA_VERSION, at });
}

/* ============================================================
   A. legacy old numeric key present → NO cooldown
   ============================================================ */

describe("A. a legacy unversioned numeric key never arms a cooldown", () => {
  it("a bare numeric value under the OLD key yields no cooldown", () => {
    const s = makeStorage({ [LEGACY_KEY]: String(T) });
    expect(isCooldownActive(s, KEY, T)).toBe(false);
    expect(remainingCooldownMs(s, KEY, T)).toBe(0);
  });

  it("the new key is distinct from the legacy key", () => {
    expect(KEY).not.toBe(LEGACY_KEY);
    expect(KEY).toContain("confirmed-v2");
  });

  it("purgeLegacyCooldown removes the legacy key and leaves the v2 key intact", () => {
    const s = makeStorage({ [LEGACY_KEY]: String(T), [KEY]: v2(T) });
    purgeLegacyCooldown(s, CID);
    expect(s._has(LEGACY_KEY)).toBe(false);
    expect(s._has(KEY)).toBe(true);
  });
});

/* ============================================================
   B. legacy old numeric key does NOT block click
   ============================================================ */

describe("B. a legacy value does not block the click", () => {
  it("runConfirmPresenceAttempt invokes the handler despite a legacy value", async () => {
    const s = makeStorage({ [LEGACY_KEY]: String(T) });
    const handler = vi.fn(async (): Promise<ConfirmPresenceResult> => "confirmed");
    const outcome = await runConfirmPresenceAttempt({
      handler,
      storage: s,
      key: KEY,
      nowMs: () => T,
      legacyCapsuleId: CID,
    });
    expect(outcome.blocked).toBe(false);
    expect(outcome.invoked).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    // The legacy key is purged as a side effect.
    expect(s._has(LEGACY_KEY)).toBe(false);
  });
});

/* ============================================================
   C. fresh successful confirmation → v2 key written
   ============================================================ */

describe("C. a successful confirmation writes the v2 record", () => {
  it("stores exactly { v: 2, at } under the namespaced key", async () => {
    const s = makeStorage();
    const outcome = await runConfirmPresenceAttempt({
      handler: async () => "confirmed",
      storage: s,
      key: KEY,
      nowMs: () => T,
    });
    expect(outcome.confirmed).toBe(true);
    expect(s._dump()[KEY]).toBe(v2(T));
    const parsed = JSON.parse(s._dump()[KEY] as string);
    expect(parsed).toEqual({ v: 2, at: T });
    expect(s._has(LEGACY_KEY)).toBe(false);
  });
});

/* ============================================================
   D. v2 valid timestamp < 15 min → WAIT 15 MIN
   ============================================================ */

describe("D. a valid v2 record within 15 min arms WAIT 15 MIN", () => {
  it("the cooldown is active immediately after success", async () => {
    const s = makeStorage();
    await runConfirmPresenceAttempt({
      handler: async () => "confirmed",
      storage: s,
      key: KEY,
      nowMs: () => T,
    });
    expect(isCooldownActive(s, KEY, T)).toBe(true);
    expect(remainingCooldownMs(s, KEY, T)).toBe(HEARTBEAT_COOLDOWN_MS);
  });

  it("a v2 record 5 min old leaves 10 min remaining", () => {
    const s = makeStorage({ [KEY]: v2(T) });
    expect(remainingCooldownMs(s, KEY, T + 5 * 60 * 1000)).toBe(
      HEARTBEAT_COOLDOWN_MS - 5 * 60 * 1000
    );
  });

  it("just under the boundary (14:59.999) still blocks", () => {
    const s = makeStorage({ [KEY]: v2(T) });
    expect(isCooldownActive(s, KEY, T + HEARTBEAT_COOLDOWN_MS - 1)).toBe(true);
  });
});

/* ============================================================
   E. v2 timestamp >= 15 min → click allowed
   ============================================================ */

describe("E. an expired v2 cooldown allows the click", () => {
  it("exactly at the boundary the click is allowed", async () => {
    const s = makeStorage({ [KEY]: v2(T) });
    const handler = vi.fn(async (): Promise<ConfirmPresenceResult> => "confirmed");
    const outcome = await runConfirmPresenceAttempt({
      handler,
      storage: s,
      key: KEY,
      nowMs: () => T + HEARTBEAT_COOLDOWN_MS,
    });
    expect(outcome.blocked).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("well past the boundary the click is allowed", () => {
    const s = makeStorage({ [KEY]: v2(T) });
    expect(isCooldownActive(s, KEY, T + HEARTBEAT_COOLDOWN_MS + 1000)).toBe(false);
  });
});

/* ============================================================
   F. malformed JSON → ignored/cleared, no cooldown
   ============================================================ */

describe("F. malformed JSON is ignored and cleared", () => {
  it("a non-JSON value yields no cooldown", () => {
    const s = makeStorage({ [KEY]: "not-json-at-all" });
    expect(readConfirmedRecord(s, KEY)).toBeNull();
    expect(isCooldownActive(s, KEY, T)).toBe(false);
  });

  it("clearInvalidConfirmedRecord removes a malformed value", () => {
    const s = makeStorage({ [KEY]: "{oops" });
    expect(clearInvalidConfirmedRecord(s, KEY)).toBe(true);
    expect(s._has(KEY)).toBe(false);
  });

  it("runConfirmPresenceAttempt clears a malformed value before proceeding", async () => {
    const s = makeStorage({ [KEY]: "{oops" });
    await runConfirmPresenceAttempt({
      handler: async () => "rejected",
      storage: s,
      key: KEY,
      nowMs: () => T,
    });
    expect(s._has(KEY)).toBe(false);
  });
});

/* ============================================================
   G. wrong version → ignored/cleared, no cooldown
   ============================================================ */

describe("G. a wrong version is ignored and cleared", () => {
  it("v:1 / v:3 / missing v are not trusted", () => {
    for (const bad of [
      JSON.stringify({ v: 1, at: T }),
      JSON.stringify({ v: 3, at: T }),
      JSON.stringify({ at: T }),
    ]) {
      const s = makeStorage({ [KEY]: bad });
      expect(readConfirmedRecord(s, KEY)).toBeNull();
      expect(isCooldownActive(s, KEY, T)).toBe(false);
    }
  });

  it("clearInvalidConfirmedRecord removes a wrong-version value", () => {
    const s = makeStorage({ [KEY]: JSON.stringify({ v: 1, at: T }) });
    expect(clearInvalidConfirmedRecord(s, KEY)).toBe(true);
    expect(s._has(KEY)).toBe(false);
  });
});

/* ============================================================
   H. invalid timestamp → ignored/cleared
   ============================================================ */

describe("H. an invalid timestamp is ignored and cleared", () => {
  it("non-number / negative / non-integer / NaN / Infinity are rejected", () => {
    for (const bad of [
      JSON.stringify({ v: 2, at: "123" }),
      JSON.stringify({ v: 2, at: -1 }),
      JSON.stringify({ v: 2, at: 1.5 }),
      JSON.stringify({ v: 2, at: null }),
      '{"v":2,"at":1e999}',
    ]) {
      const s = makeStorage({ [KEY]: bad });
      expect(readConfirmedRecord(s, KEY)).toBeNull();
      expect(isCooldownActive(s, KEY, T)).toBe(false);
    }
  });

  it("a valid record is NOT cleared by clearInvalidConfirmedRecord", () => {
    const s = makeStorage({ [KEY]: v2(T) });
    expect(clearInvalidConfirmedRecord(s, KEY)).toBe(false);
    expect(s._has(KEY)).toBe(true);
  });
});

/* ============================================================
   I. failed confirmation → no v2 marker
   ============================================================ */

describe("I. a failed confirmation writes no v2 marker", () => {
  const failures: ConfirmPresenceResult[] = ["rejected", "expired", "network-error"];

  for (const result of failures) {
    it(`'${result}' stores nothing under the v2 key`, async () => {
      const s = makeStorage();
      const outcome = await runConfirmPresenceAttempt({
        handler: async () => result,
        storage: s,
        key: KEY,
        nowMs: () => T,
      });
      expect(outcome.confirmed).toBe(false);
      expect(outcome.result).toBe(result);
      expect(s._has(KEY)).toBe(false);
      expect(isCooldownActive(s, KEY, T)).toBe(false);
    });
  }

  it("a thrown handler maps to network-error and stores nothing", async () => {
    const s = makeStorage();
    const outcome = await runConfirmPresenceAttempt({
      handler: async () => {
        throw new Error("boom");
      },
      storage: s,
      key: KEY,
      nowMs: () => T,
    });
    expect(outcome.result).toBe("network-error");
    expect(s._has(KEY)).toBe(false);
  });

  it("a stale v2 value from a prior window is cleared on a failure", async () => {
    const s = makeStorage({ [KEY]: v2(T - HEARTBEAT_COOLDOWN_MS - 1) });
    await runConfirmPresenceAttempt({
      handler: async () => "rejected",
      storage: s,
      key: KEY,
      nowMs: () => T,
    });
    expect(s._has(KEY)).toBe(false);
  });

  it("a retry after a failure is possible", async () => {
    const s = makeStorage();
    const handler = vi
      .fn<[], Promise<ConfirmPresenceResult>>()
      .mockResolvedValueOnce("rejected")
      .mockResolvedValueOnce("confirmed");
    const first = await runConfirmPresenceAttempt({ handler, storage: s, key: KEY, nowMs: () => T });
    expect(first.confirmed).toBe(false);
    const second = await runConfirmPresenceAttempt({ handler, storage: s, key: KEY, nowMs: () => T + 1 });
    expect(second.confirmed).toBe(true);
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

/* ============================================================
   J. reload after a successful confirmation → v2 cooldown restored
   ============================================================ */

describe("J. reload restores the cooldown ONLY from a valid v2 record", () => {
  it("re-derives the remaining cooldown from the persisted v2 value", () => {
    const persisted = makeStorage({ [KEY]: v2(T) });
    const reloaded = makeStorage(persisted._dump());
    expect(remainingCooldownMs(reloaded, KEY, T + 1000)).toBe(
      HEARTBEAT_COOLDOWN_MS - 1000
    );
  });

  it("reload ignores a legacy value entirely", () => {
    const reloaded = makeStorage({ [LEGACY_KEY]: String(T) });
    expect(remainingCooldownMs(reloaded, KEY, T + 1000)).toBe(0);
  });
});

/* ============================================================
   K. recipient still has no Confirm Presence
   ============================================================ */

describe("K. the Recipient Link still receives no Confirm-Presence button", () => {
  it("the button is gated on authorityMode AND the handler (source pin)", () => {
    expect(VIEW_SRC).toMatch(/authorityMode\s*&&\s*handleConfirmPresence\s*&&\s*\(/);
  });

  it("authorityMode derives from state.authorityMode (source pin)", () => {
    expect(VIEW_SRC).toMatch(/const authorityMode\s*=\s*\n?\s*state\.status\s*===\s*"preview"\s*\|\|\s*state\.status\s*===\s*"opened"/);
  });

  it("the controller passes onConfirmPresence only via preview state (source pin)", () => {
    expect(CONTROLLER_SRC).toMatch(/onConfirmPresence:/);
  });
});

/* ============================================================
   L. double-click still performs only one confirmation
   ============================================================ */

describe("L. double click does not fire two confirmations", () => {
  it("a successful first attempt leaves an active v2 cooldown that blocks the second", async () => {
    const s = makeStorage();
    const handler = vi.fn(async (): Promise<ConfirmPresenceResult> => "confirmed");
    const first = await runConfirmPresenceAttempt({ handler, storage: s, key: KEY, nowMs: () => T });
    const second = await runConfirmPresenceAttempt({ handler, storage: s, key: KEY, nowMs: () => T });
    expect(first.confirmed).toBe(true);
    expect(second.blocked).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("the view guards re-entry with `confirming` (source pin)", () => {
    expect(VIEW_SRC).toMatch(/if\s*\(confirming\)\s*\n?\s*return;/);
    expect(VIEW_SRC).toMatch(/disabled=\{confirming\s*\|\|\s*heartbeatCooldownActive\}/);
  });
});

/* ============================================================
   M. the heartbeat math / server surface is untouched
   ============================================================ */

describe("M. the effectiveOpenAt logic and server surface are untouched", () => {
  it("the cooldown module does not import or reimplement the heartbeat math", () => {
    const code = MODULE_SRC
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/resolveEffectiveOpenAt/);
    expect(code).not.toMatch(/THIRTY_DAYS_MS/);
    expect(code).not.toMatch(/manifest\.openAt/);
  });

  it("CapsuleController still calls resolveEffectiveOpenAt for the display date", () => {
    expect(CONTROLLER_SRC).toMatch(/resolveEffectiveOpenAt\(/);
  });

  it("the controller does not ASSIGN to manifest.openAt", () => {
    expect(CONTROLLER_SRC).not.toMatch(/manifest\.openAt\s*=(?!=)/);
  });

  it("isConfirmedResult is true ONLY for 'confirmed'", () => {
    expect(isConfirmedResult("confirmed")).toBe(true);
    expect(isConfirmedResult("rejected")).toBe(false);
    expect(isConfirmedResult("expired")).toBe(false);
    expect(isConfirmedResult("network-error")).toBe(false);
    expect(isConfirmedResult(undefined)).toBe(false);
    expect(isConfirmedResult(null)).toBe(false);
  });
});

/* ============================================================
   non-vacuity control
   ============================================================ */

describe("non-vacuity control — the v2 hardening is falsifiable", () => {
  it("legacy vs v2 are distinguishable (control)", () => {
    const legacy = makeStorage({ [LEGACY_KEY]: String(T) });
    const v2s = makeStorage({ [KEY]: v2(T) });
    expect(isCooldownActive(legacy, KEY, T)).toBe(false); // hardened
    expect(isCooldownActive(v2s, KEY, T)).toBe(true);     // genuine
  });
});
