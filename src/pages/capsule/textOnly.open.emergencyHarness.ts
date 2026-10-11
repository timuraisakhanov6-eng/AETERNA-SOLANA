// @vitest-environment jsdom

/**
 * Harness for testing `initEmergencyRuntime`'s text-only vs media decision in
 * isolation. It mocks ONLY the runtime's external collaborators (capability
 * parse, manifest load, trusted time, heartbeat, openCapsule, storage readout,
 * container resolver) and drives the REAL `initEmergencyRuntime`.
 *
 * No live network, no Irys, no payment, no KV.
 */

import { vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  getChunkPointerReadout: vi.fn(),
  resolveContainerChunks: vi.fn(),
  loadManifest: vi.fn(),
  parseCapability: vi.fn(),
  getTrustedTime: vi.fn(),
  currentItems: [] as unknown[],
}));

vi.mock("@/lib/storage/storage", () => ({
  getChunkPointerReadout: hoisted.getChunkPointerReadout,
}));

vi.mock("@/lib/capsule/open/resolveContainerChunks", () => ({
  resolveContainerChunks: hoisted.resolveContainerChunks,
}));

vi.mock("@/lib/capsule/parseCapsuleCapability", () => ({
  parseCapsuleCapability: hoisted.parseCapability,
}));

vi.mock("@/lib/capsule/loadManifest", () => ({
  loadManifest: hoisted.loadManifest,
}));

vi.mock("@/shared/time/getTrustedTime", () => ({
  getTrustedTime: hoisted.getTrustedTime,
}));

vi.mock("@/shared/heartbeat/resolveEffectiveOpenAt", () => ({
  resolveEffectiveOpenAt: ({ manifestOpenAt }: { manifestOpenAt: number }) =>
    manifestOpenAt,
}));

vi.mock("@/lib/capsule/loadHeartbeatRecord", () => ({
  loadHeartbeatRecord: async () => null,
}));

vi.mock("@/lib/capsule/sendHeartbeat", () => ({
  sendHeartbeat: async () => ({ ok: true }),
}));

vi.mock("@/lib/capsule/openCapsule", () => ({
  openCapsule: async () => ({
    vault: {
      version: 2,
      createdAt: "2026-09-27T12:00:00.000Z",
      capsule: { capsuleId: "a".repeat(64), items: hoisted.currentItems },
    },
    cryptoKey: {} as CryptoKey,
  }),
}));

export async function runEmergencyCase(args: {
  publication: unknown;
  items: unknown[];
  /** Sets `location` (path + search + hash) before the run. */
  url?: string;
  /** "recipient" (default) yields a secret; "none" yields an invalid link. */
  capability?: "recipient" | "none";
  /** Manifest openAt (ms). Default 0 (already open). */
  openAt?: number;
  /** Trusted time nowUtc (ms). Default MAX_SAFE_INTEGER (open). */
  nowUtc?: number;
}): Promise<{ status: string; outcome: string; manifestCapsuleId: string }> {
  if (typeof window !== "undefined") {
    window.history.replaceState({}, "", args.url ?? "/emergency");
  }

  hoisted.currentItems = args.items;

  hoisted.getChunkPointerReadout.mockReset();
  hoisted.resolveContainerChunks.mockReset();
  hoisted.loadManifest.mockReset();
  hoisted.parseCapability.mockReset();
  hoisted.getTrustedTime.mockReset();

  hoisted.getChunkPointerReadout.mockResolvedValue({
    container: args.publication,
  });
  hoisted.resolveContainerChunks.mockResolvedValue([]);

  hoisted.loadManifest.mockResolvedValue({
    capsuleId: "a".repeat(64),
    openAt: args.openAt ?? 0,
    sealedAt: 0,
    heartbeatInterval: 0,
  });

  hoisted.parseCapability.mockImplementation(() =>
    args.capability === "none"
      ? null
      : { recipientSecret: "s".repeat(64) }
  );

  hoisted.getTrustedTime.mockResolvedValue({
    nowUtc: args.nowUtc ?? Number.MAX_SAFE_INTEGER,
  });

  const { initEmergencyRuntime } = await import(
    "@/emergency/emergencyRuntime"
  );

  const root = document.createElement("div");
  const status = document.createElement("div");

  const outcome = await initEmergencyRuntime({ root, status });

  const manifestCapsuleId =
    (hoisted.loadManifest.mock.calls[0]?.[0] as string | undefined) ?? "";

  return { status: status.textContent ?? "", outcome, manifestCapsuleId };
}
