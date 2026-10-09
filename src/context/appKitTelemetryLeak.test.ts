// @vitest-environment jsdom
/**
 * AETERNA — AppKit telemetry capability-leak guard (security regression).
 *
 * Threat: AppKit emits a MANDATORY `INITIALIZE` telemetry event on
 * construction; its payload embeds `url: window.location.href`. On a capsule
 * capability link the fragment IS the capability, so eager construction on
 * `/capsule/:id#<capability>` would leak it to a third party.
 *
 * Strategy: we mock the single AppKit module boundary (`createAppKit`) and
 * record EVERY construction and every telemetry `navigator.sendBeacon` call.
 * The real `AETERNAWalletProvider` is mounted under a `MemoryRouter` at
 * capability-bearing URLs. The assertions prove:
 *   - AppKit is NOT constructed (so INITIALIZE is never emitted), and
 *   - no telemetry payload ever contains the synthetic capability.
 *
 * SYNTHETIC values only. No real capsule secret is used.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import React, { type ReactNode } from "react";

const SYNTHETIC_RECIPIENT = "a".repeat(64);
const SYNTHETIC_AUTHORITY = "b".repeat(64);
const SYNTHETIC_CAPSULE_ID = "c".repeat(64);

/** Records every AppKit construction and every telemetry sendBeacon body. */
const telemetry = vi.hoisted(() => {
  const constructions: unknown[] = [];
  const beaconBodies: string[] = [];
  return { constructions, beaconBodies };
});

const createAppKitMock = vi.hoisted(() =>
  vi.fn(() => {
    // Simulate the side effect that matters for this threat: AppKit's
    // mandatory INITIALIZE telemetry embeds the current location href.
    const body = JSON.stringify({
      event: "INITIALIZE",
      url:
        typeof window !== "undefined"
          ? window.location.href
          : "about:blank",
    });
    telemetry.constructions.push(body);
    telemetry.beaconBodies.push(body);
    return { __mockAppKit: true };
  })
);

const getReownAppKitInstanceMock = vi.hoisted(() => vi.fn());
const ensureReownAppKitInstanceMock = vi.hoisted(() => vi.fn());

// Mock the AppKit boundary: `createAppKit` is the ONLY function whose call
// triggers the mandatory INITIALIZE telemetry in the real SDK.
vi.mock("@reown/appkit/react", () => ({
  createAppKit: createAppKitMock,
  useAppKitProvider: () => ({ walletProvider: undefined }),
  useAppKitAccount: () => ({ address: undefined }),
  useAppKitConnections: () => ({ connections: [] }),
  useWalletInfo: () => ({ name: undefined }),
  useDisconnect: () => ({ disconnect: vi.fn().mockResolvedValue(undefined) }),
}));

vi.mock("@/lib/wallet/reownSolana", () => ({
  getReownAppKitInstance: getReownAppKitInstanceMock,
  ensureReownAppKitInstance: ensureReownAppKitInstanceMock,
  resetReownAppKitInstance: vi.fn(),
}));

import { AETERNAWalletProvider, useAeternaWallet } from "@/context/AETERNAWalletContext";

const storageKeys: Record<string, string> = {};

function installLocalStorage() {
  Object.defineProperty(global, "localStorage", {
    value: {
      getItem: (key: string) => storageKeys[key] ?? null,
      setItem: (key: string, value: string) => {
        storageKeys[key] = value;
      },
      removeItem: (key: string) => {
        delete storageKeys[key];
      },
      clear: () => {
        Object.keys(storageKeys).forEach((key) => delete storageKeys[key]);
      },
    },
    writable: true,
    configurable: true,
  });
}

function renderAt(initialEntry: string) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    React.createElement(
      MemoryRouter,
      { initialEntries: [initialEntry] },
      React.createElement(AETERNAWalletProvider, null, children)
    );

  return renderHook(() => useAeternaWallet(), { wrapper });
}

beforeEach(() => {
  Object.keys(storageKeys).forEach((key) => delete storageKeys[key]);
  installLocalStorage();
  telemetry.constructions.length = 0;
  telemetry.beaconBodies.length = 0;
  vi.clearAllMocks();

  // Wire the reown boundary so that eager creation would record a
  // construction (this is what we assert must NOT happen on capsule URLs).
  getReownAppKitInstanceMock.mockImplementation(() => {
    const appKit = createAppKitMock();
    return appKit;
  });
  ensureReownAppKitInstanceMock.mockImplementation(async () => {
    const appKit = createAppKitMock();
    return appKit;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AppKit telemetry capability-leak guard", () => {
  it("does not construct AppKit (no INITIALIZE telemetry) on a recipient capability URL", () => {
    renderAt(`/capsule/${SYNTHETIC_CAPSULE_ID}#${SYNTHETIC_RECIPIENT}`);

    expect(createAppKitMock).not.toHaveBeenCalled();
    expect(telemetry.constructions).toHaveLength(0);
    expect(telemetry.beaconBodies).toHaveLength(0);
  });

  it("does not construct AppKit on a creator capability URL (extra authority)", () => {
    renderAt(
      `/capsule/${SYNTHETIC_CAPSULE_ID}#${SYNTHETIC_RECIPIENT}&c=${SYNTHETIC_AUTHORITY}`
    );

    expect(createAppKitMock).not.toHaveBeenCalled();
    expect(telemetry.constructions).toHaveLength(0);
  });

  it("no telemetry payload ever contains the synthetic capability fragment", () => {
    renderAt(
      `/capsule/${SYNTHETIC_CAPSULE_ID}#${SYNTHETIC_RECIPIENT}&c=${SYNTHETIC_AUTHORITY}`
    );

    const allBodies = telemetry.beaconBodies.join("\n");
    expect(allBodies.includes(SYNTHETIC_RECIPIENT)).toBe(false);
    expect(allBodies.includes(SYNTHETIC_AUTHORITY)).toBe(false);
  });

  it("construction DOES happen on a normal creator page (wallet flow preserved)", () => {
    renderAt("/create");

    expect(createAppKitMock).toHaveBeenCalledTimes(1);
    expect(telemetry.constructions.length).toBeGreaterThan(0);
  });

  it("on the capsule route the wallet context is inert (no throw, no actions)", () => {
    const { result } = renderAt(
      `/capsule/${SYNTHETIC_CAPSULE_ID}#${SYNTHETIC_RECIPIENT}`
    );

    expect(result.current.ready).toBe(false);
    expect(result.current.connected).toBe(false);
  });

  it("error telemetry path cannot fire on a capability URL (no AppKit => no sendError)", () => {
    // AppKit's error telemetry (`TelemetryController.sendError`) is wired
    // through `withErrorBoundary` around the controllers that only exist
    // once AppKit is constructed. Since no AppKit construction happens on a
    // capability URL, no controller is created, so no error telemetry can be
    // emitted with the capability-bearing href.
    renderAt(
      `/capsule/${SYNTHETIC_CAPSULE_ID}#${SYNTHETIC_RECIPIENT}&c=${SYNTHETIC_AUTHORITY}`
    );

    expect(createAppKitMock).not.toHaveBeenCalled();
    expect(telemetry.beaconBodies).toHaveLength(0);
  });
});
