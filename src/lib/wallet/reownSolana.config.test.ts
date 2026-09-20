/**
 * AETERNA — Model 01 Phantom-only AppKit configuration.
 *
 * Model 01 supports Phantom only at the wallet UX/integration layer
 * (docs/canonical/AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md §4.1).
 *
 * These tests pin the AppKit options that produce that surface:
 * - `allWallets: 'HIDE'` removes the generic "All Wallets" entry point
 *   (the previous value `'ALL'` was invalid for AppKit 1.8.23, whose
 *   union is `'SHOW' | 'HIDE' | 'ONLY_MOBILE'`).
 * - `includeWalletIds` lists ONLY Phantom, and AppKit's ConnectorUtil
 *   removes every connector whose wallet id is not listed.
 *
 * They also pin that no other wallet brand (e.g. MetaMask) is introduced,
 * and that the Solana adapter / network configuration is untouched.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const { createAppKitMock, captured } = vi.hoisted(() => {
  const captured: { options?: Record<string, unknown> | undefined } = {};
  const createAppKitMock = vi.fn((options: Record<string, unknown>) => {
    captured.options = options;
    return { __mockAppKit: true } as unknown;
  });
  return { createAppKitMock, captured };
});

vi.mock("@reown/appkit/react", () => ({ createAppKit: createAppKitMock }));
vi.mock("@reown/appkit-adapter-solana", () => ({ SolanaAdapter: class {} }));
vi.mock("@reown/appkit/networks", () => ({
  solana: { id: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", name: "Solana" },
}));

import {
  getReownAppKitInstance,
  resetReownAppKitInstance,
} from "@/lib/wallet/reownSolana";

/** WalletConnect explorer id for Phantom (installed AppKit registry). */
const PHANTOM_EXPLORER_ID =
  "a797aa35c0fadbfc1a53e7f675162ed5226968b44a19ee3d24385c64d1d3c393";

/** WalletConnect explorer id for MetaMask — must NOT be present. */
const METAMASK_EXPLORER_ID =
  "c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96";

describe("Model 01 Phantom-only AppKit configuration", () => {
  beforeEach(() => {
    captured.options = undefined;
    createAppKitMock.mockClear();
    resetReownAppKitInstance();
  });

  it("5: hides the generic wallet list and restricts includeWalletIds to Phantom only", () => {
    getReownAppKitInstance();

    const options = captured.options;
    expect(options).toBeDefined();

    // Generic wallet picker surface removed.
    expect(options?.["allWallets"]).toBe("HIDE");
    expect(options?.["allWallets"]).not.toBe("ALL");

    // Phantom only.
    expect(options?.["includeWalletIds"]).toEqual([PHANTOM_EXPLORER_ID]);
    expect((options?.["includeWalletIds"] as string[]).length).toBe(1);
  });

  it("6: no other wallet provider is allowlisted", () => {
    getReownAppKitInstance();

    const includeWalletIds = (captured.options?.["includeWalletIds"] ?? []) as string[];

    expect(includeWalletIds).not.toContain(METAMASK_EXPLORER_ID);
    expect(includeWalletIds.some((id) => /metamask/i.test(id))).toBe(false);
    // Exactly one provider entry, and it is Phantom.
    expect(includeWalletIds).toEqual([PHANTOM_EXPLORER_ID]);
  });

  it("preserves the Solana adapter, network scope and provider abstraction", () => {
    getReownAppKitInstance();

    const options = captured.options;
    expect(Array.isArray(options?.["adapters"])).toBe(true);
    expect((options?.["adapters"] as unknown[]).length).toBe(1);
    expect(Array.isArray(options?.["networks"])).toBe(true);
    expect((options?.["networks"] as unknown[]).length).toBe(1);
    expect(options?.["defaultNetwork"]).toBeDefined();
    // Provider-neutral behaviour preserved: reconnect stays disabled.
    expect(options?.["enableReconnect"]).toBe(false);
  });
});
