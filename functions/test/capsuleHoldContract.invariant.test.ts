// @vitest-environment jsdom

/**
 * CapsuleHold ↔ /api/upload-token request contract (blocker #1)
 *
 * Regression scope: the canonical upload-token request emitted by the
 * REAL CapsuleHold component must identify the creator by
 * `creatorIdentityId`. Pre-fix the payload sent `capsuleId` instead.
 *
 * The component is mounted for real (real effects, real fetch call
 * shape); only its external collaborators are mocked:
 *   - global fetch (upload-token + trusted time),
 *   - runtime registry, creator storage adapter, Irys wallet bridge,
 *   - seal core (not under test here),
 *   - wallet context (structural value only).
 *
 * No live network, no Irys funding, no blockchain, no production KV.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const hoisted = vi.hoisted(() => ({
  sealCapsuleCore: vi.fn(),
}));

vi.mock("@/context/CapsuleContext", () => ({
  useCapsule: () => ({ resetCapsule: vi.fn(), capsuleId: "a".repeat(64) }),
}));

vi.mock("@/context/AETERNAWalletContext", async () => {
  const ReactModule = await import("react");
  return {
    AETERNAWalletContext: ReactModule.createContext(null),
  };
});

vi.mock("@/lib/capsule/sealCapsuleCore", () => ({
  sealCapsuleCore: hoisted.sealCapsuleCore,
}));

vi.mock("@/lib/storage/creatorIrysStorage", () => ({
  createCreatorIrysStorage: vi.fn(() => ({
    name: "mock-storage",
    upload: vi.fn(),
    uploadChunk: vi.fn(),
    download: vi.fn(),
  })),
}));

vi.mock("@/lib/storage/creatorIrys", () => ({
  toCreatorIrysWallet: vi.fn(() => ({ publicKey: {} })),
}));

vi.mock("@/lib/runtime/runtimeRegistry", () => ({
  getRuntime: vi.fn(async () => ({
    readVault: async () => new Uint8Array(0),
    removeVault: async () => {},
  })),
  destroyRuntime: vi.fn(async () => {}),
}));

import CapsuleHold from "@/pages/capsule/CapsuleHold";
import { AETERNAWalletContext } from "@/context/AETERNAWalletContext";

/* ───────────────── fixtures ───────────────── */

const CAPSULE_ID = "a".repeat(64);
const SALT_BASE = "b".repeat(32);
const RECIPIENT_SECRET = "c".repeat(64);
const CREATOR_AUTHORITY = "d".repeat(64);
const VAULT_SHA256 = "e".repeat(64);
const LIFECYCLE_ID = "lifecycle-1";
const CREATOR_IDENTITY_ID = "creator-1";
const STORAGE_PAYMENT_ID = "storage-payment-1";
const CORRELATION_TRANSACTION_ID = "0x" + "1".repeat(64);
const WALLET_ACCOUNT = "wallet-account-1";

const SEALED_AT = 1755000000000;
const OPEN_AT = SEALED_AT + 3_600_000;

function buildHoldState() {
  return {
    billableSizeBytes: 1024,
    expectedAmount: 1,
    openAt: OPEN_AT,
    itemIds: ["item-1"],
    creatorAuthority: CREATOR_AUTHORITY,
    prepared: {
      capsuleId: CAPSULE_ID,
      encryptedVaultPointer: `aeterna-local-vault:${CAPSULE_ID}`,
      encryptedSizeBytes: 1024,
      vaultSha256: VAULT_SHA256,
      saltBase: SALT_BASE,
      recipientSecret: RECIPIENT_SECRET,
      creatorAuthority: CREATOR_AUTHORITY,
      chunkMetadata: [],
    },
  };
}

function locationState() {
  return {
    holdState: buildHoldState(),
    canonicalLifecycleId: LIFECYCLE_ID,
    creatorIdentityId: CREATOR_IDENTITY_ID,
    storagePaymentId: STORAGE_PAYMENT_ID,
    correlationTransactionId: CORRELATION_TRANSACTION_ID,
  };
}

function installFetchMock() {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/upload-token") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ uploadToken: "t".repeat(32) }),
      };
    }
    if (url === "/api/time") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ nowUtc: SEALED_AT }),
      };
    }
    throw new Error("UNEXPECTED_FETCH:" + url);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderHold() {
  const walletValue = {
    state: { account: WALLET_ACCOUNT, connected: true },
    wallet: { account: WALLET_ACCOUNT },
  };

  return render(
    React.createElement(
      MemoryRouter,
      {
        initialEntries: [
          { pathname: "/capsule/hold", state: locationState() },
        ],
      },
      React.createElement(
        AETERNAWalletContext.Provider,
        { value: walletValue },
        React.createElement(CapsuleHold)
      )
    )
  );
}

describe("CapsuleHold upload-token request contract", () => {
  beforeEach(() => {
    hoisted.sealCapsuleCore.mockReset();
    hoisted.sealCapsuleCore.mockImplementation(
      async (params: { capsuleId: string }) => ({
        capsuleId: params.capsuleId,
        manifest: {},
        recipientLink: "",
        confirmationLink: "/confirmation",
        finalized: true,
        finalizationPending: false,
      })
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("POST /api/upload-token identifies the creator via creatorIdentityId, not capsuleId", async () => {
    const fetchMock = installFetchMock();

    renderHold();

    await waitFor(() => {
      const called = fetchMock.mock.calls.some(
        ([url]) => url === "/api/upload-token"
      );
      expect(called).toBe(true);
    });

    const tokenCall = fetchMock.mock.calls.find(
      ([url]) => url === "/api/upload-token"
    );
    expect(tokenCall).toBeTruthy();

    const init = tokenCall![1] as { body?: string } | undefined;
    const body = JSON.parse(String(init?.body));

    expect(body.creatorIdentityId).toBe(CREATOR_IDENTITY_ID);
    expect(body.canonicalLifecycleId).toBe(LIFECYCLE_ID);
    expect(body.correlationTransactionId).toBe(
      CORRELATION_TRANSACTION_ID
    );
    expect(body).not.toHaveProperty("capsuleId");
  });
});
