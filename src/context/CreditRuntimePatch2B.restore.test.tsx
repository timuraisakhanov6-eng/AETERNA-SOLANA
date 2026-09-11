// @vitest-environment jsdom
/**
 * AETERNA — PATCH-2B restore-flow regression test.
 *
 * Verifies the PATCH-2 CapsuleBuilder entitlement-restore flow passes
 * the connected AETERNA wallet account into issueChallenge, so the
 * issue-challenge request carries { network: "solana", publicKey }.
 *
 * jsdom component test — same convention as CreditRuntimePatch2.test.tsx.
 * NOTE: requires a jsdom runtime that loads in this sandbox
 * (jsdom 30.0.1 + undici 8.10.0 currently crash on Node 20; see
 * CreditRuntimePatch2.test.tsx — the whole .test.tsx set shares this).
 *
 * All network access is mocked. No production calls.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import {
  CreatorIdentityProvider,
  CreatorCreditProvider,
} from "@/context/CreatorRuntimeContext";
import CapsuleBuilder from "@/components/capsule/CapsuleBuilder";

const WALLET_ACCOUNT = "7XkWqBase58WalletAccountFor2BTest";

const { signMessageMock } = vi.hoisted(() => ({
  signMessageMock: vi.fn(async (_message: Uint8Array) => ({
    signature: new Uint8Array(64),
  })),
}));

vi.mock("@/context/AETERNAWalletContext", () => ({
  useAeternaWallet: () => ({
    connected: true,
    account: WALLET_ACCOUNT,
    walletName: "Test Wallet",
    openWalletPicker: vi.fn(),
    changeWallet: vi.fn(),
    signMessage: signMessageMock,
    signAndSendTransaction: vi.fn(),
    disconnect: vi.fn(),
  }),
}));

vi.mock("@/context/LandingPaymentGateContext", () => ({
  useLandingPaymentGate: () => ({ entitlement: null }),
}));

vi.mock("@/context/CapsuleContext", () => ({
  useCapsule: () => ({
    items: [],
    capsuleId: "capsule-2b-test",
    addTextItem: vi.fn(),
    addMediaItem: vi.fn(),
    description: "",
    setDescription: vi.fn(),
    unlockAt: 1798761600000,
    setUnlockAt: vi.fn(),
    getMediaFile: vi.fn(),
    resetCapsule: vi.fn(),
  }),
}));

vi.mock("@/components/capsule/ActionMenu", () => ({ default: () => null }));
vi.mock("@/components/capsule/MediaCapture", () => ({ default: () => null }));
vi.mock("@/components/capsule/CapsuleInput", () => ({ default: () => null }));
vi.mock("@/components/capsule/HorizontalCapsule", () => ({
  default: () => null,
}));
vi.mock("@/components/capsule/DateTimePicker", () => ({
  DateTimePicker: () => null,
  normalizeOpenAt: (value: unknown) => value,
}));
vi.mock("@/lib/capsule/preparePreparedCapsule", () => ({
  preparePreparedCapsule: vi.fn(),
}));
vi.mock("@/lib/storage/creatorIrys", () => ({
  fundCreatorPaidStorage: vi.fn(),
  toCreatorIrysWallet: vi.fn(),
}));

describe("PATCH-2B CapsuleBuilder restore flow", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("passes the connected wallet account into issue-challenge", async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/creator/issue-challenge")) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            challengeId: "challenge-1",
            challenge: "abc",
            message: "AETERNA identity challenge",
          }),
        };
      }
      if (url.includes("/api/creator/credit-status")) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            status: "none",
            creatorCreditId: null,
            creatorIdentityId: null,
          }),
        };
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    });

    render(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(
          CreatorIdentityProvider,
          null,
          React.createElement(
            CreatorCreditProvider,
            null,
            React.createElement(CapsuleBuilder, {
              onOpenServicePayment: () => undefined,
            })
          )
        )
      )
    );

    // Reaching the signature step proves the challenge was issued.
    await waitFor(() => {
      expect(signMessageMock).toHaveBeenCalledTimes(1);
    });

    const challengeCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("/api/creator/issue-challenge")
    );
    expect(challengeCall).toBeDefined();

    const body = JSON.parse(String(challengeCall![1].body));
    expect(body).toEqual({ network: "solana", publicKey: WALLET_ACCOUNT });
  });
});
