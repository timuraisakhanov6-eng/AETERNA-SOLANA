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

import { describe, expect, it, afterEach } from "vitest";
import {
  PHANTOM_INSTALL_URL,
  PHANTOM_REQUIRED_BODY,
  PHANTOM_REQUIRED_TITLE,
  isPhantomAvailable,
} from "@/lib/wallet/phantomProvider";

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
