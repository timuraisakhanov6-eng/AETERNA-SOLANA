// @vitest-environment jsdom
/**
 * AETERNA — CapsuleHold seal retry loop regression (terminal vs transient).
 *
 * SCOPE: the REAL CapsuleHold retry loop around sealCapsuleCore. Every
 * boundary crossing the component is mocked (contexts, runtime registry,
 * upload-token fetch); sealCapsuleCore itself is a mock so the loop's
 * retry/terminal decision is observed directly:
 *
 *  - a deterministic 402 PAYMENT_REQUIRED / PAYMENT_INVALID refusal
 *    performs EXACTLY ONE seal attempt, propagates the allowlisted
 *    server code to the error UI, runs the existing cleanup (runtime
 *    destroy, seal-lock removal, TRY AGAIN surface) and does NOT
 *    remove the unfinished-lifecycle hint;
 *  - a transient failure keeps the existing bounded 3-attempt retry.
 *
 * No network, no wallet, no payment, no Irys, no blockchain.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";

const CAPSULE_ID =
  "327c0425565b5801d112c87a43e6651f07eabb9afde8831562c44b4ec3702b40";
const LIFECYCLE_ID = "lifecycle-1";
const CREATOR_IDENTITY_ID = "creator-1";
const STORAGE_PAYMENT_ID = "storage-payment-1";
const UPLOAD_TOKEN = "u".repeat(32);
const WALLET_ACCOUNT = "WALLET-ACCOUNT";

vi.mock("@/lib/capsule/sealCapsuleCore", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/capsule/sealCapsuleCore")>();
  return { ...actual, sealCapsuleCore: vi.fn() };
});

vi.mock("@/lib/storage/creatorIrysStorage", () => ({
  createCreatorIrysStorage: vi.fn(() => ({ name: "mock-creator-irys" })),
}));

vi.mock("@/lib/storage/creatorIrys", () => ({
  toCreatorIrysWallet: vi.fn(() => ({})),
}));

vi.mock("@/lib/runtime/runtimeRegistry", () => ({
  getRuntime: vi.fn(async () => ({})),
  destroyRuntime: vi.fn(async () => {}),
}));

vi.mock("@/lib/access/unfinishedLifecycle", () => ({
  removeUnfinishedLifecycle: vi.fn(),
}));

vi.mock("../../context/CapsuleContext", () => ({
  useCapsule: () => ({
    resetCapsule: vi.fn(),
    capsuleId: CAPSULE_ID,
  }),
}));

vi.mock("@/context/CreateAccessContext", () => ({
  useCreateAccess: () => ({
    clearAccess: vi.fn(),
    admission: undefined,
    grantAccess: vi.fn(),
  }),
}));

// The wallet context module pulls the heavy wallet stack; the component
// only needs a React context whose value exposes `wallet.account`.
vi.mock("../../context/AETERNAWalletContext", async () => {
  const { createContext } = await import("react");
  return {
    AETERNAWalletContext: createContext<{
      wallet?: { account?: string };
    } | null>(null),
  };
});

import CapsuleHold from "./CapsuleHold";
import { AETERNAWalletContext } from "../../context/AETERNAWalletContext";
import {
  classifySealHttpResponse,
  isTerminalSealFailure,
  sealCapsuleCore,
} from "@/lib/capsule/sealCapsuleCore";
import { destroyRuntime } from "@/lib/runtime/runtimeRegistry";
import { removeUnfinishedLifecycle } from "@/lib/access/unfinishedLifecycle";
import { createCreatorIrysStorage } from "@/lib/storage/creatorIrysStorage";
import { toCreatorIrysWallet } from "@/lib/storage/creatorIrys";

const sealMock = sealCapsuleCore as unknown as ReturnType<typeof vi.fn>;
const destroyRuntimeMock = destroyRuntime as unknown as ReturnType<typeof vi.fn>;
const removeUnfinishedLifecycleMock =
  removeUnfinishedLifecycle as unknown as ReturnType<typeof vi.fn>;
const createCreatorIrysStorageMock =
  createCreatorIrysStorage as unknown as ReturnType<typeof vi.fn>;
const toCreatorIrysWalletMock =
  toCreatorIrysWallet as unknown as ReturnType<typeof vi.fn>;

const LOCATION_STATE = {
  holdState: {
    billableSizeBytes: 1024,
    expectedAmount: 1,
    openAt: 1_900_000_000_000,
    itemIds: ["item-1"],
    prepared: {
      capsuleId: CAPSULE_ID,
      encryptedVaultPointer: `aeterna-local-vault:${CAPSULE_ID}`,
      encryptedSizeBytes: 4096,
      vaultSha256: "a".repeat(64),
      saltBase: "a".repeat(32),
      recipientSecret: "c".repeat(64),
      creatorAuthority: "d".repeat(64),
      chunkMetadata: [],
    },
  },
  canonicalLifecycleId: LIFECYCLE_ID,
  creatorIdentityId: CREATOR_IDENTITY_ID,
  creatorCreditId: "credit-1",
  storagePaymentId: STORAGE_PAYMENT_ID,
  correlationTransactionId: "corr-1",
};

function walletProvider(children: React.ReactNode) {
  return createElement(
    AETERNAWalletContext.Provider,
    { value: { wallet: { account: WALLET_ACCOUNT } } as never },
    children
  );
}

/** A wallet context WITHOUT an account: the dropped-session resume case. */
function walletProviderNoAccount(children: React.ReactNode) {
  return createElement(
    AETERNAWalletContext.Provider,
    { value: { wallet: { account: null } } as never },
    children
  );
}

function renderHoldNoAccount() {
  return render(
    walletProviderNoAccount(
      createElement(
        MemoryRouter,
        {
          initialEntries: [
            { pathname: "/create/hold", state: LOCATION_STATE },
          ] as never,
        },
        createElement(CapsuleHold)
      )
    )
  );
}

function renderHold() {
  return render(
    walletProvider(
      createElement(
        MemoryRouter,
        {
          initialEntries: [
            { pathname: "/create/hold", state: LOCATION_STATE },
          ] as never,
        },
        createElement(CapsuleHold)
      )
    )
  );
}

function stubUploadTokenFetch() {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/upload-token")) {
      return new Response(
        JSON.stringify({ ok: true, uploadToken: UPLOAD_TOKEN }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    }
    if (url.includes("/api/time")) {
      // Trusted time strictly BEFORE the fixture's openAt: the hold
      // guard rejects openAt <= trustedNow.
      return new Response(
        JSON.stringify({ nowUtc: LOCATION_STATE.holdState.openAt - 60000 }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    }
    throw new Error("UNEXPECTED_FETCH:" + url);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function terminal402(code: "PAYMENT_REQUIRED" | "PAYMENT_INVALID") {
  const classified = classifySealHttpResponse(
    402,
    JSON.stringify({ ok: false, error: code })
  );
  if (!classified.terminal) throw new Error("fixture must be terminal");
  return classified.error;
}

describe("CapsuleHold seal retry loop — terminal vs transient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("a deterministic 402 PAYMENT_REQUIRED performs EXACTLY ONE seal attempt and surfaces the code", async () => {
    stubUploadTokenFetch();
    sealMock.mockRejectedValueOnce(terminal402("PAYMENT_REQUIRED"));

    renderHold();

    await act(async () => {});
    await screen.findByText(/We couldn't finish preparing your capsule/);

    expect(sealMock).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText(/Capsule sealing failed: PAYMENT_REQUIRED/)
    ).toBeTruthy();
    expect(screen.getByText("TRY AGAIN")).toBeTruthy();
    // The existing cleanup still ran on the terminal failure.
    expect(destroyRuntimeMock).toHaveBeenCalled();
    expect(window.sessionStorage.getItem("aeterna-seal-lock")).toBeNull();
    // The unfinished-lifecycle hint is NOT removed: the attempt is not
    // finalized, so the recovery surface must stay intact.
    expect(removeUnfinishedLifecycleMock).not.toHaveBeenCalled();
  });

  it("a deterministic 402 PAYMENT_INVALID is terminal too (one attempt)", async () => {
    stubUploadTokenFetch();
    sealMock.mockRejectedValueOnce(terminal402("PAYMENT_INVALID"));

    renderHold();

    await act(async () => {});
    await screen.findByText(/We couldn't finish preparing your capsule/);

    expect(sealMock).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText(/Capsule sealing failed: PAYMENT_INVALID/)
    ).toBeTruthy();
  });

  it("a transient failure keeps the bounded 3-attempt retry", async () => {
    stubUploadTokenFetch();
    vi.useFakeTimers();
    sealMock.mockRejectedValue(new Error("rpc blip"));

    renderHold();

    await act(async () => {});
    expect(sealMock).toHaveBeenCalledTimes(1);

    // Exponential backoff: 1000 * 2^attempt → 2 s, then 4 s, then the
    // final refusal (SEALING_FAILED_FINAL after the 3rd attempt).
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(sealMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(4000);
    });
    expect(sealMock).toHaveBeenCalledTimes(3);

    await act(async () => {});
    expect(
      screen.getByText(/We couldn't finish preparing your capsule/)
    ).toBeTruthy();
  });

  it("the terminal failure leaves the persisted seal lock cleared for a later restart", async () => {
    stubUploadTokenFetch();
    sealMock.mockRejectedValueOnce(terminal402("PAYMENT_REQUIRED"));

    renderHold();

    await act(async () => {});
    await screen.findByText(/We couldn't finish preparing your capsule/);

    expect(window.sessionStorage.getItem("aeterna-seal-lock")).toBeNull();
  });

  it("the resume state issues upload-token and seal with the ORIGINAL authoritative identity", async () => {
    // Own fetch stub so the upload-token REQUEST BODY is observable: the
    // resume path must carry the same creatorCreditId / lifecycleId /
    // creatorIdentityId the attempt was started with.
    const fetchMock = vi.fn(async (input: unknown, init?: { body?: string }) => {
      const url = String(input);
      if (url.includes("/api/upload-token")) {
        return new Response(
          JSON.stringify({ ok: true, uploadToken: UPLOAD_TOKEN }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      }
      if (url.includes("/api/time")) {
        return new Response(
          JSON.stringify({ nowUtc: LOCATION_STATE.holdState.openAt - 60000 }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      }
      throw new Error("UNEXPECTED_FETCH:" + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    sealMock.mockResolvedValue({
      capsuleId: CAPSULE_ID,
      confirmationLink: `/capsule/${CAPSULE_ID}#frag`,
      recipientLink: `/capsule/${CAPSULE_ID}#frag`,
      finalized: true,
      finalizationPending: false,
      manifest: {},
    });

    renderHold();

    await act(async () => {});

    const tokenCall = fetchMock.mock.calls.find(([u]) =>
      String(u).includes("/api/upload-token")
    );
    expect(tokenCall).toBeTruthy();
    const tokenBody = JSON.parse(
      String((tokenCall![1] as { body: string }).body)
    ) as Record<string, unknown>;
    expect(tokenBody.creatorIdentityId).toBe(CREATOR_IDENTITY_ID);
    expect(tokenBody.canonicalLifecycleId).toBe(LIFECYCLE_ID);
    expect(tokenBody.creatorCreditId).toBe("credit-1");

    expect(sealMock).toHaveBeenCalledTimes(1);
    expect(sealMock.mock.calls[0][0]).toMatchObject({
      capsuleId: CAPSULE_ID,
      canonicalLifecycleId: LIFECYCLE_ID,
      creatorIdentityId: CREATOR_IDENTITY_ID,
      uploadToken: UPLOAD_TOKEN,
    });
  });

  it("the cached resume proceeds WITHOUT a wallet account (wallet:null adapter) and reaches the seal", async () => {
    stubUploadTokenFetch();
    sealMock.mockResolvedValueOnce({
      capsuleId: CAPSULE_ID,
      confirmationLink: `/capsule/${CAPSULE_ID}#frag`,
      recipientLink: `/capsule/${CAPSULE_ID}#frag`,
      finalized: true,
      finalizationPending: false,
      manifest: {},
    });

    // Both retry caches present: the fully cached path performs ZERO
    // wallet interactions (3BM-R7-F1).
    window.sessionStorage.setItem(
      `aeterna-vault-txid:${CAPSULE_ID}`,
      "v".repeat(43)
    );
    window.sessionStorage.setItem(
      `aeterna-container-upload:${CAPSULE_ID}`,
      JSON.stringify({
        containerTxId: "C".repeat(43),
        chunkIds: ["chunk-1"],
        layoutDigest: "b".repeat(64),
      })
    );

    renderHoldNoAccount();

    await act(async () => {});

    // The previous early-guard location is passed: the core ran with the
    // wallet:null adapter and the ORIGINAL identity.
    expect(sealMock).toHaveBeenCalledTimes(1);
    expect(sealMock.mock.calls[0]![0]).toMatchObject({
      capsuleId: CAPSULE_ID,
      canonicalLifecycleId: LIFECYCLE_ID,
      creatorIdentityId: CREATOR_IDENTITY_ID,
    });
    expect(createCreatorIrysStorageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        wallet: null,
        creatorIdentityId: CREATOR_IDENTITY_ID,
        lifecycleId: LIFECYCLE_ID,
        capsuleId: CAPSULE_ID,
        storagePaymentId: STORAGE_PAYMENT_ID,
      })
    );
    // No wallet conversion happened: nothing on this path needs one.
    expect(toCreatorIrysWalletMock).not.toHaveBeenCalled();

    // No failure surface, no STORAGE_WALLET_UNAVAILABLE anywhere.
    expect(
      screen.queryByText(/We couldn't finish preparing your capsule/)
    ).toBeNull();
    expect(screen.queryByText(/STORAGE_WALLET_UNAVAILABLE/)).toBeNull();
  });
});
