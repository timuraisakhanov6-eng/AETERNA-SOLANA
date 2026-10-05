// @vitest-environment jsdom

/**
 * TEXT-ONLY VAULT-ONLY — open-path branch proof (D) + emergency path (E).
 *
 * D. `CapsuleOpened`:
 *      • no container + ZERO chunk-bearing items → VALID (Vault-only); the
 *        Vault renders, no error state.
 *      • no container + chunk-bearing items       → FAIL CLOSED exactly as
 *        before (error state).
 *
 * E. `initEmergencyRuntime`:
 *      • no publication + ZERO chunk-bearing items → Vault-only, opens.
 *      • no publication + chunk-bearing items      → fail closed
 *        ("Capsule publication unavailable.").
 *
 * The rule is content-based; "missing container" alone is NEVER valid.
 * No live network, no Irys, no payment, no KV.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { configure } from "@testing-library/dom";

configure({ asyncUtilTimeout: 5000 });

/* ───────────────────────── shared hoisted mocks ───────────────────────── */

const hoisted = vi.hoisted(() => ({
  getChunkPointerReadout: vi.fn(),
  resolveContainerChunks: vi.fn(),
}));

vi.mock("@/lib/storage/storage", () => ({
  storage: {
    getChunkPointerReadout: hoisted.getChunkPointerReadout,
  },
}));

vi.mock("@/lib/capsule/open/resolveContainerChunks", () => ({
  resolveContainerChunks: hoisted.resolveContainerChunks,
}));

// VaultRenderer pulls in media runtimes; render a stable marker instead.
vi.mock("@/pages/capsule/VaultRenderer", () => ({
  default: () =>
    React.createElement("div", { "data-testid": "vault-renderer" }),
}));

import CapsuleOpened from "@/pages/capsule/CapsuleOpened";
import type { ManifestV1 } from "@/types/manifest";
import type { Vault } from "@/types/vault";

/* ───────────────────────── fixtures ───────────────────────── */

const CAPSULE_ID = "a".repeat(64);

const MANIFEST = {
  capsuleId: CAPSULE_ID,
} as unknown as ManifestV1;

function vaultWith(items: unknown[]): Vault {
  return {
    version: 2,
    createdAt: "2026-09-27T12:00:00.000Z",
    capsule: { capsuleId: CAPSULE_ID, items },
  } as unknown as Vault;
}

/** A CryptoKey instance is required for CapsuleOpened to enter "opened". */
async function realCryptoKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

beforeEach(() => {
  hoisted.getChunkPointerReadout.mockReset();
  hoisted.resolveContainerChunks.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CapsuleOpened — open path (D)", () => {
  it("no container + ZERO chunk-bearing items → VALID vault-only (no error)", async () => {
    hoisted.getChunkPointerReadout.mockResolvedValue({ container: null });

    const key = await realCryptoKey();
    const vault = vaultWith([
      { type: "text", text: "hello", createdAt: "2026-09-27T12:00:00.000Z" },
    ]);

    render(
      React.createElement(CapsuleOpened, {
        manifest: MANIFEST,
        capsuleId: CAPSULE_ID,
        initialVault: vault,
        initialCryptoKey: key,
      })
    );

    await waitFor(() =>
      expect(screen.getByTestId("vault-renderer")).toBeTruthy()
    );

    // Must NOT have fallen into the fail-closed error state.
    expect(
      screen.queryByText(/Capsule content unavailable/i)
    ).toBeNull();

    // The container resolver is never consulted without a container.
    expect(hoisted.resolveContainerChunks).not.toHaveBeenCalled();
  });

  it("no container + chunk-bearing items → FAIL CLOSED (error state)", async () => {
    hoisted.getChunkPointerReadout.mockResolvedValue({ container: null });

    const key = await realCryptoKey();
    const vault = vaultWith([
      {
        type: "media",
        mediaType: "file",
        filename: "a.bin",
        mimeType: "application/octet-stream",
        size: 10,
        createdAt: "2026-09-27T12:00:00.000Z",
        chunks: [
          { chunkId: "c1".padEnd(64, "x"), mediaId: "m1", index: 0, size: 10 },
        ],
      },
    ]);

    render(
      React.createElement(CapsuleOpened, {
        manifest: MANIFEST,
        capsuleId: CAPSULE_ID,
        initialVault: vault,
        initialCryptoKey: key,
      })
    );

    await waitFor(() =>
      expect(
        screen.getByText(/Capsule content unavailable/i)
      ).toBeTruthy()
    );

    expect(screen.queryByTestId("vault-renderer")).toBeNull();
  });
});

/* ───────────────────────── E. emergency path ───────────────────────── */

describe("initEmergencyRuntime — emergency path (E)", () => {
  it("no publication + ZERO chunk-bearing items → Vault-only, opens", async () => {
    const { runEmergencyCase } = await import("./textOnly.open.emergencyHarness");
    const out = await runEmergencyCase({
      publication: null,
      items: [{ type: "text", text: "hi" }],
    });
    expect(out.status).toBe("Capsule opened.");
  });

  it("no publication + chunk-bearing items → fail closed", async () => {
    const { runEmergencyCase } = await import("./textOnly.open.emergencyHarness");
    const out = await runEmergencyCase({
      publication: null,
      items: [
        {
          type: "media",
          chunks: [{ chunkId: "c1", mediaId: "m1", index: 0, size: 1 }],
        },
      ],
    });
    expect(out.status).toBe("Capsule publication unavailable.");
  });
});
