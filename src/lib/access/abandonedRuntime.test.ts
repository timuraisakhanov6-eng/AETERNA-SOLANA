/**
 * R9-A92.1 — the abandonment guard around local Runtime cleanup.
 *
 * Only the Durable Object's authoritative `ABORT_AND_RESTORE_AVAILABLE`
 * decision (`kind === "restored"`) may discard the prepared ciphertext.
 * Every other recovery outcome leaves the attempt resumable/recoverable and
 * therefore MUST keep its Runtime.
 *
 * Local deletion is best effort: a browser that refuses it must never turn
 * an already-successful server-side restore into a failure.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const hoisted = vi.hoisted(() => ({
  discardRuntime: vi.fn(),
}));

vi.mock("@/lib/runtime/runtimeRegistry", () => ({
  discardRuntime: hoisted.discardRuntime,
}));

import { discardAbandonedRuntime } from "./abandonedRuntime";

const CAPSULE_ID = "a".repeat(64);

describe("discardAbandonedRuntime", () => {
  beforeEach(() => {
    hoisted.discardRuntime.mockReset();
  });

  it("clears the EXACT capsule of the authoritative abandonment", async () => {
    hoisted.discardRuntime.mockResolvedValue(undefined);

    await discardAbandonedRuntime("restored", CAPSULE_ID);

    expect(hoisted.discardRuntime).toHaveBeenCalledTimes(1);
    expect(hoisted.discardRuntime).toHaveBeenCalledWith(CAPSULE_ID);
  });

  it.each([
    "resolved",
    "blocked",
    "unauthorized",
    "unknown",
    "resume-unavailable",
  ] as const)("does NOT touch the Runtime on a %s outcome", async (kind) => {
    await discardAbandonedRuntime(kind, CAPSULE_ID);

    expect(hoisted.discardRuntime).not.toHaveBeenCalled();
  });

  it("never fails the successful restore when local deletion fails", async () => {
    hoisted.discardRuntime.mockRejectedValue(new Error("[test] IDB denied"));

    await expect(
      discardAbandonedRuntime("restored", CAPSULE_ID)
    ).resolves.toBeUndefined();
  });

  it("is wired to the RESTORED branch of the recovery gate only", () => {
    const source = readFileSync(
      resolve(__dirname, "../../components/access/CreateAccessGate.tsx"),
      "utf8"
    ).replace(/\r\n/g, "\n");

    const restoredStart = source.indexOf('outcome.kind === "restored"');
    const resolvedStart = source.indexOf('outcome.kind === "resolved"');

    expect(restoredStart).toBeGreaterThan(-1);
    expect(resolvedStart).toBeGreaterThan(restoredStart);

    const restoredBranch = source.slice(restoredStart, resolvedStart);
    expect(restoredBranch).toContain("discardAbandonedRuntime(");
    expect(restoredBranch).toContain("record.capsuleId");

    // The resolved (consumed/published) branch must NOT discard anything.
    const resolvedBranch = source.slice(
      resolvedStart,
      source.indexOf("// \"blocked\" / \"unauthorized\" / \"unknown\"")
    );
    expect(resolvedBranch).not.toContain("discardAbandonedRuntime(");
  });
});
