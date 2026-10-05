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
  currentItems: [] as unknown[],
}));

vi.mock("@/lib/storage/storage", () => ({
  getChunkPointerReadout: hoisted.getChunkPointerReadout,
}));

vi.mock("@/lib/capsule/open/resolveContainerChunks", () => ({
  resolveContainerChunks: hoisted.resolveContainerChunks,
}));

vi.mock("@/lib/capsule/parseCapsuleCapability", () => ({
  parseCapsuleCapability: () => ({ recipientSecret: "s".repeat(64) }),
}));

vi.mock("@/lib/capsule/loadManifest", () => ({
  loadManifest: async () => ({
    capsuleId: "a".repeat(64),
    openAt: 0,
    sealedAt: 0,
    heartbeatInterval: 0,
  }),
}));

vi.mock("@/shared/time/getTrustedTime", () => ({
  getTrustedTime: async () => ({ nowUtc: Number.MAX_SAFE_INTEGER }),
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
  }),
}));

export async function runEmergencyCase(args: {
  publication: unknown;
  items: unknown[];
}): Promise<{ status: string }> {
  hoisted.currentItems = args.items;
  hoisted.getChunkPointerReadout.mockReset();
  hoisted.resolveContainerChunks.mockReset();
  hoisted.getChunkPointerReadout.mockResolvedValue({
    container: args.publication,
  });
  hoisted.resolveContainerChunks.mockResolvedValue([]);

  const { initEmergencyRuntime } = await import(
    "@/emergency/emergencyRuntime"
  );

  const root = document.createElement("div");
  const status = document.createElement("div");

  await initEmergencyRuntime({ root, status });

  return { status: status.textContent ?? "" };
}
