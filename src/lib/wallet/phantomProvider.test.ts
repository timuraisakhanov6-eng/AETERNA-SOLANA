// @vitest-environment jsdom
/**
 * AETERNA — Model 01 Phantom availability detection.
 *
 * `isPhantomAvailable()` is a UX GATE ONLY. These tests pin:
 * - it reads the Phantom-specific `window.phantom.solana` namespace, not
 *   the generic `window.solana` (another injected wallet may claim that);
 * - it fails closed for every malformed/absent shape;
 * - the installation copy is exact and the install URL is the official
 *   Phantom download page with no referral parameter.
 *
 * No protocol, identity, payment or Creator Credit authority is involved.
 */

import { describe, expect, it, afterEach, vi } from "vitest";
import fs from "node:fs";

/**
 * Mock the PUBLIC AppKit boundary (`MobileWalletUtil` / `CoreHelperUtil`),
 * not the code under test — the real phantomProvider logic runs.
 */
const { isMobileMock, deeplinkMock } = vi.hoisted(() => ({
  isMobileMock: vi.fn(() => false),
  deeplinkMock: vi.fn(),
}));

vi.mock("@reown/appkit-controllers", () => ({
  CoreHelperUtil: { isMobile: isMobileMock },
  MobileWalletUtil: { handleMobileDeeplinkRedirect: deeplinkMock },
}));

import {
  PHANTOM_EXPLORER_ID,
  PHANTOM_INSTALL_URL,
  PHANTOM_MOBILE_BODY,
  PHANTOM_MOBILE_OPEN_LABEL,
  PHANTOM_MOBILE_TITLE,
  PHANTOM_REQUIRED_BODY,
  PHANTOM_REQUIRED_TITLE,
  findPhantomWalletItem,
  isMobileBrowser,
  isPhantomAvailable,
  openAeternaInPhantomMobile,
} from "@/lib/wallet/phantomProvider";
import type { WalletItem } from "@reown/appkit-controllers";

function walletItem(overrides: Partial<WalletItem>): WalletItem {
  return {
    id: "unknown",
    name: "Unknown",
    imageUrl: "",
    connectors: [],
    walletInfo: {},
    isInjected: false,
    isRecent: false,
    ...overrides,
  } as WalletItem;
}

function setPhantom(value: unknown): void {
  const w = window as unknown as { phantom?: unknown };
  if (value === undefined) {
    delete w.phantom;
  } else {
    w.phantom = value;
  }
}

afterEach(() => {
  setPhantom(undefined);
  delete (window as unknown as { solana?: unknown }).solana;
});

describe("isPhantomAvailable", () => {
  it("returns false when no Phantom namespace is injected", () => {
    setPhantom(undefined);
    expect(isPhantomAvailable()).toBe(false);
  });

  it("returns true when window.phantom.solana is present", () => {
    setPhantom({ solana: {} });
    expect(isPhantomAvailable()).toBe(true);
  });

  it("fails closed when window.phantom exists without a solana provider", () => {
    setPhantom({});
    expect(isPhantomAvailable()).toBe(false);
    setPhantom({ solana: null });
    expect(isPhantomAvailable()).toBe(false);
    setPhantom({ solana: "not-a-provider" });
    expect(isPhantomAvailable()).toBe(false);
  });

  it("fails closed for a malformed window.phantom value", () => {
    setPhantom("phantom");
    expect(isPhantomAvailable()).toBe(false);
    setPhantom(42);
    expect(isPhantomAvailable()).toBe(false);
  });

  it("does NOT treat a generic window.solana provider as Phantom", () => {
    // Another injected wallet may claim the generic namespace; the Model 01
    // gate must not accept it as Phantom.
    setPhantom(undefined);
    (window as unknown as { solana?: unknown }).solana = {
      isPhantom: false,
      signMessage: async () => ({ signature: new Uint8Array(64) }),
    };
    expect(isPhantomAvailable()).toBe(false);
  });
});

describe("Model 01 installation copy", () => {
  it("uses the exact required wording", () => {
    expect(PHANTOM_REQUIRED_TITLE).toBe("Phantom Wallet Required");
    expect(PHANTOM_REQUIRED_BODY).toBe(
      "Install Phantom to create an AETERNA capsule."
    );
  });

  it("points at the official Phantom download page with no referral URL", () => {
    expect(PHANTOM_INSTALL_URL).toBe("https://phantom.com/download");
    expect(PHANTOM_INSTALL_URL).not.toMatch(/ref=|referral|affiliate|utm_/i);
  });
});

describe("findPhantomWalletItem — Phantom-only selection", () => {
  it("selects the injected Phantom entry by explorer id", () => {
    const phantom = walletItem({
      id: PHANTOM_EXPLORER_ID,
      name: "Phantom",
      isInjected: true,
      connectors: [{ id: PHANTOM_EXPLORER_ID, chain: "solana" }],
    });

    expect(findPhantomWalletItem([phantom])).toBe(phantom);
  });

  it("selects the injected Phantom entry by name (case-insensitive)", () => {
    const phantom = walletItem({
      id: "Phantom",
      name: "phantom",
      isInjected: true,
      connectors: [{ id: "Phantom", chain: "solana" }],
    });

    expect(findPhantomWalletItem([phantom])).toBe(phantom);
  });

  it("never selects the WalletConnect entry (not injected)", () => {
    const walletConnect = walletItem({
      id: "walletConnect",
      name: "WalletConnect",
      isInjected: false,
    });

    expect(findPhantomWalletItem([walletConnect])).toBeNull();
  });

  it("never selects a non-Phantom injected wallet", () => {
    const solflare = walletItem({
      id: "1ca0bdd4747578705b1939af023d120677c64fe6ca76add81fda36e350605e79",
      name: "Solflare",
      isInjected: true,
      connectors: [
        {
          id: "1ca0bdd4747578705b1939af023d120677c64fe6ca76add81fda36e350605e79",
          chain: "solana",
        },
      ],
    });

    expect(findPhantomWalletItem([solflare])).toBeNull();
  });

  it("skips WalletConnect and unrelated wallets but still finds Phantom", () => {
    const walletConnect = walletItem({ id: "walletConnect", name: "WalletConnect" });
    const solflare = walletItem({ id: "solflare", name: "Solflare", isInjected: true });
    const phantom = walletItem({ id: PHANTOM_EXPLORER_ID, name: "Phantom", isInjected: true });

    expect(findPhantomWalletItem([walletConnect, solflare, phantom])).toBe(phantom);
  });

  it("fails closed for empty / undefined lists", () => {
    expect(findPhantomWalletItem([])).toBeNull();
    expect(findPhantomWalletItem(undefined)).toBeNull();
  });
});

describe("mobile Phantom flow", () => {
  afterEach(() => {
    isMobileMock.mockReset();
    isMobileMock.mockReturnValue(false);
    deeplinkMock.mockReset();
  });

  it("reports mobile via AppKit's own detector", () => {
    isMobileMock.mockReturnValue(true);
    expect(isMobileBrowser()).toBe(true);

    isMobileMock.mockReturnValue(false);
    expect(isMobileBrowser()).toBe(false);
  });

  it("fails closed (desktop) when the detector throws", () => {
    isMobileMock.mockImplementation(() => {
      throw new Error("no window");
    });

    expect(isMobileBrowser()).toBe(false);
  });

  it("opens Phantom through the installed public deeplink utility", () => {
    openAeternaInPhantomMobile();

    expect(deeplinkMock).toHaveBeenCalledTimes(1);
    expect(deeplinkMock).toHaveBeenCalledWith(PHANTOM_EXPLORER_ID, "solana");
  });

  it("does not hand-roll any Phantom deeplink / intent URL", () => {
    const source = fs.readFileSync("src/lib/wallet/phantomProvider.ts", "utf8");

    // The redirect must go through MobileWalletUtil, never a literal URL.
    expect(source).not.toMatch(/phantom:\/\//);
    expect(source).not.toMatch(/intent:\/\//);
    expect(source).not.toMatch(/phantom\.app/);
    expect(source).not.toMatch(/ul\/browse/);
    expect(source).not.toMatch(/app\.phantom/);
  });

  it("uses exact mobile copy and keeps the official install URL", () => {
    expect(PHANTOM_MOBILE_TITLE).toBe("Open AETERNA in Phantom");
    expect(PHANTOM_MOBILE_BODY).toBe(
      "On mobile, Phantom connects through the Phantom app."
    );
    expect(PHANTOM_MOBILE_OPEN_LABEL).toBe("Open in Phantom");
    expect(PHANTOM_INSTALL_URL).toBe("https://phantom.com/download");
  });
});
