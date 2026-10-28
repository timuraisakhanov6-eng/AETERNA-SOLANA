// @vitest-environment jsdom
/**
 * AETERNA — TRANSIENT-SEALED FIX regression suite (capsule open state machine).
 *
 * =========================================================
 * DEFECT (Production, observed on reload of an existing capsule)
 * =========================================================
 *
 *   CRYPTOGRAPHIC OPENING IN PROGRESS…
 *      → SEALED card (Recipient Link / Creator Link / Confirm Presence)
 *      → Capsule Opened
 *
 * The SEALED card was the INITIAL state of the open pipeline: `init()`
 * committed `status: "preview"` as soon as manifest + heartbeat
 * resolved, i.e. BEFORE `tryOpen()` had compared the open boundary
 * against TRUSTED time. Every reload therefore rendered a full SEALED
 * card that was not an outcome — it was a placeholder.
 *
 * =========================================================
 * FIX UNDER TEST
 * =========================================================
 *
 *  - `init()` commits a NEUTRAL `checking` state, never `preview`.
 *  - `preview` (SEALED) is reached ONLY as an authoritative outcome:
 *    still sealed, no capability in this tab, trusted time
 *    unavailable, or a fail-closed read/decode failure.
 *  - `opened` is reached ONLY after a proven successful open.
 *  - `checking` is strictly transient: every non-success resolution
 *    leaves it (no infinite neutral loader).
 *
 * =========================================================
 * SCOPE / SAFETY
 * =========================================================
 *
 * All network, crypto, storage and vault layers are mocked. No real
 * manifest fetch, no capability, no secret, no signing, no payment, no
 * Irys upload. The Confirm-Presence handler and the heartbeat math are
 * NOT reimplemented here — they are pinned as untouched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createElement, type FunctionComponent } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/* ============================================================
   render-sequence recorder (hoisted so the vi.mock factory can
   reach it — vi.mock calls are hoisted above the imports)
   ============================================================ */

const rec = vi.hoisted(() => ({ statuses: [] as string[] }));

/* ============================================================
   MODULE MOCKS — every boundary of the open pipeline
   ============================================================ */

vi.mock("./CapsuleView", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./CapsuleView")>();

  const Real =
    actual.default as unknown as FunctionComponent<{
      state: { status: string };
    }>;

  const Recorder = (props: { state: { status: string } }) => {
    // Records the status the CONTROLLER committed on every render.
    rec.statuses.push(props.state.status);
    return createElement(Real, props);
  };

  return { ...actual, default: Recorder };
});

vi.mock("./CapsuleOpened", () => ({
  default: () =>
    createElement("div", { "data-testid": "capsule-opened" }, "Capsule Opened"),
}));

// Avoid animation timers / layout work in jsdom.
vi.mock("framer-motion", async () => {
  const passthrough = (tag: string) => {
    const C = (props: Record<string, unknown>) => {
      const {
        initial: _i,
        animate: _a,
        transition: _t,
        whileHover: _h,
        whileTap: _p,
        exit: _e,
        layout: _l,
        variants: _v,
        ...domProps
      } = props;
      return createElement(tag, domProps as never);
    };
    return C;
  };
  const cache = new Map<string, unknown>();
  const motion = new Proxy(
    {},
    {
      get: (_t, key) => {
        const k = String(key);
        if (!cache.has(k)) cache.set(k, passthrough(k));
        return cache.get(k);
      },
    }
  );
  return {
    motion,
    AnimatePresence: (p: { children?: unknown }) => p.children,
  };
});

// jsdom has no canvas; the real QR generator would only ever reject.
vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn(async () => "data:image/png;base64,AAAA") },
}));

vi.mock("@/lib/capsule/loadManifest", () => ({
  loadManifest: vi.fn(),
}));

vi.mock("@/lib/capsule/loadHeartbeatRecord", () => ({
  loadHeartbeatRecord: vi.fn(),
}));

vi.mock("@/lib/capsule/openCapsule", () => ({
  openCapsule: vi.fn(),
}));

vi.mock("@/shared/time/getTrustedTime", () => ({
  getTrustedTime: vi.fn(),
}));

import CapsuleController from "./CapsuleController";
import { loadManifest } from "@/lib/capsule/loadManifest";
import { loadHeartbeatRecord } from "@/lib/capsule/loadHeartbeatRecord";
import { openCapsule } from "@/lib/capsule/openCapsule";
import { getTrustedTime } from "@/shared/time/getTrustedTime";
import {
  retryableOpenError,
  terminalOpenError,
  notOpenError,
} from "@/lib/capsule/openFailure";

/* ============================================================
   fixtures
   ============================================================ */

const CAPSULE_ID =
  "327c0425565b5801d112c87a43e6651f07eabb9afde8831562c44b4ec3702b40";

const SECRET = "b".repeat(64);

const SEALED_AT = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN_AT = SEALED_AT + 30 * DAY_MS; // sealed 30 days ahead

function makeManifest() {
  return {
    version: 1 as const,
    capsuleId: CAPSULE_ID,
    openAt: OPEN_AT,
    sealedAt: SEALED_AT,
    saltBase: "c2FsdA",
    vaultTxId: "d".repeat(43),
    encryptedSizeBytes: 4096,
    heartbeatInterval: 30 * DAY_MS,
    ext: { vaultSha256: "e".repeat(64) },
  };
}

const FAKE_VAULT = { version: 2, capsule: { capsuleId: CAPSULE_ID, items: [] } };
const FAKE_CRYPTO_KEY = { type: "secret" } as unknown as CryptoKey;

/** Collapse consecutive duplicates → the ordered committed sequence. */
function sequence(): string[] {
  const out: string[] = [];
  for (const s of rec.statuses) {
    if (out[out.length - 1] !== s) out.push(s);
  }
  return out;
}

/**
 * Invariant A — the fail-closed SEALED outcome.
 *
 * The pipeline starts neutral, ends on the SEALED card, and NEVER
 * reports the capsule as opened.
 */
function expectFailClosedSealed(): void {
  const seq = sequence();
  expect(seq[0]).toBe("opening"); // neutral while the pipeline runs
  expect(seq).not.toContain("opened");
  expect(seq[seq.length - 1]).toBe("preview");
  expect(screen.getByLabelText("Capsule sealed")).toBeTruthy();
}

/** Retryable recipient recovery stays closed without the SEALED landing card. */
function expectFailClosedRecovering(): void {
  const seq = sequence();
  expect(seq).not.toContain("opened");
  expect(seq).not.toContain("preview");
  expect(seq[seq.length - 1]).toBe("recovering");
  expect(screen.getByRole("status").textContent).toContain(
    "Capsule could not be loaded. Retrying…"
  );
  expect(screen.queryByLabelText("Capsule sealed")).toBeNull();
  expect(screen.queryByTestId("capsule-opened")).toBeNull();
}

/**
 * Invariant B — the successful-open path.
 *
 * THE REGRESSION UNDER TEST: the Production sequence was
 * `opening → preview → opened`. `preview` (the full SEALED card with
 * Recipient Link / Creator Link / Confirm Presence) must not appear on
 * this path AT ALL.
 */
function expectOpenedWithoutSealed(): void {
  const seq = sequence();
  expect(seq[0]).toBe("opening");
  expect(seq).not.toContain("preview");
  expect(seq[seq.length - 1]).toBe("opened");
}

/** Invariant C — a terminal error is never disguised as opened/sealed. */
function expectTerminalError(): void {
  expect(screen.getByText(/Could not load capsule/i)).toBeTruthy();
  const seq = sequence();
  expect(seq).not.toContain("opened");
  expect(seq).not.toContain("preview");
}

function renderController(
  props: { secret?: string; creatorAuthorityFragment?: string } = {}
) {
  return render(
    createElement(
      MemoryRouter,
      null,
      createElement(CapsuleController, {
        capsuleId: CAPSULE_ID,
        ...(props.secret !== undefined ? { secret: props.secret } : {}),
        ...(props.creatorAuthorityFragment !== undefined
          ? { creatorAuthorityFragment: props.creatorAuthorityFragment }
          : {}),
      } as never)
    )
  );
}

/**
 * Advance the EXISTING 5 s retry interval by `ticks` fires.
 *
 * Used only by the section-6 tests (fake timers). `advanceTimersByTime`
 * fires the interval synchronously and the following bare `await` lets
 * the un-faked async tryOpen body settle without a `waitFor` (which
 * would deadlock: waitFor's polling uses the very timers that are
 * faked).
 */
async function advanceRetryInterval(
  ticks: number
): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
  }
}

/** Wait until the pipeline has stopped writing statuses. */
async function settle(): Promise<void> {
  const before = rec.statuses.length;
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  if (rec.statuses.length !== before) await settle();
}

/**
 * A promise the test resolves explicitly.
 *
 * REQUIRED for the anti-flash assertions: the Production defect only
 * manifests when the async gaps are real (network latency), because
 * React 18 flushes the intermediate state during the gap. If every
 * mocked call settles synchronously the intermediate render is
 * coalesced away and the test would be VACUOUS.
 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  rec.statuses.length = 0;
  vi.clearAllMocks();
  (loadManifest as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
    makeManifest()
  );
  (loadHeartbeatRecord as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
    null
  );
});

afterEach(() => {
  cleanup();
});

/* ============================================================
   1. STILL SEALED → SEALED, and only AFTER checking
   ============================================================ */

describe("1. still sealed — SEALED is reached only after the trusted-time check", () => {
  it("renders a neutral state first, then the SEALED card", async () => {
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      nowUtc: SEALED_AT + 1000, // < OPEN_AT
    });

    renderController({ secret: SECRET });

    await waitFor(() =>
      expect(screen.getByLabelText("Capsule sealed")).toBeTruthy()
    );

    expectFailClosedSealed();
  });

  it("never commits `preview` before `checking` (no placeholder SEALED)", async () => {
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      nowUtc: SEALED_AT + 1000,
    });

    renderController({ secret: SECRET });

    await waitFor(() =>
      expect(screen.getByLabelText("Capsule sealed")).toBeTruthy()
    );

    const seq = sequence();
    // React 18 auto-batching may coalesce the `checking` render with the
    // decision render when the trusted-time call settles synchronously.
    // What must NEVER happen is `preview` being the first status, or the
    // SEALED decision preceding the neutral check.
    expect(seq[0]).not.toBe("preview");
    if (seq.includes("checking")) {
      expect(seq.indexOf("checking")).toBeLessThan(seq.indexOf("preview"));
    }
  });

  it("the SEALED card is never displayed while the neutral check runs", async () => {
    let releaseTime: (v: { nowUtc: number }) => void = () => {};
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((r) => {
        releaseTime = r;
      })
    );

    renderController({ secret: SECRET });

    // Manifest + heartbeat are resolved → the pipeline is in `checking`
    // while trusted time is still outstanding.
    await waitFor(() => expect(sequence()).toContain("checking"));
    await settle();

    expect(screen.getByText("Opening capsule…")).toBeTruthy();
    expect(screen.queryByLabelText("Capsule sealed")).toBeNull();

    releaseTime({ nowUtc: SEALED_AT + 1000 });
    await waitFor(() =>
      expect(screen.getByLabelText("Capsule sealed")).toBeTruthy()
    );
  });
});

/* ============================================================
   2. SUCCESSFUL OPEN → Opened, SEALED never rendered
   ============================================================ */

describe("2. successful open — Opened is shown, SEALED is never rendered", () => {
  it("never renders the SEALED card on the way to Opened (reload regression)", async () => {
    // Real async gaps: trusted time, then the vault read.
    const time = deferred<{ nowUtc: number }>();
    const open = deferred<{ vault: unknown; cryptoKey: CryptoKey }>();

    (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      time.promise
    );
    (openCapsule as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      open.promise
    );

    renderController({ secret: SECRET });

    // (1) manifest + heartbeat resolved; trusted time STILL IN FLIGHT.
    //     The committed state must be the NEUTRAL one — a `preview`
    //     here is exactly the Production defect.
    await waitFor(() => expect(sequence()).toContain("checking"));
    await settle();
    expect(screen.getByText("Opening capsule…")).toBeTruthy();
    expect(screen.queryByLabelText("Capsule sealed")).toBeNull();

    // (2) trusted time says the capsule IS open; the vault read is now
    //     in flight. This is the window in which Production used to
    //     show the full SEALED card.
    time.resolve({ nowUtc: OPEN_AT + 1000 });
    await waitFor(() => expect(openCapsule).toHaveBeenCalledTimes(1));
    await settle();
    expect(screen.queryByLabelText("Capsule sealed")).toBeNull();
    expect(screen.getByText("Opening capsule…")).toBeTruthy();

    // (3) the vault is delivered → Opened.
    open.resolve({ vault: FAKE_VAULT, cryptoKey: FAKE_CRYPTO_KEY });
    await waitFor(() =>
      expect(screen.getByTestId("capsule-opened")).toBeTruthy()
    );

    const seq = sequence();
    expect(seq).toContain("checking"); // the neutral state really rendered
    expect(seq).not.toContain("preview"); // THE REGRESSION
    expect(seq[seq.length - 1]).toBe("opened");
    expect(screen.queryByLabelText("Capsule sealed")).toBeNull();
  });

  it("goes straight from the neutral state to Opened (no SEALED in the sequence)", async () => {
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      nowUtc: OPEN_AT + 1000, // >= effectiveOpenAt
    });
    (openCapsule as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      vault: FAKE_VAULT,
      cryptoKey: FAKE_CRYPTO_KEY,
    });

    renderController({ secret: SECRET });

    await waitFor(() =>
      expect(screen.getByTestId("capsule-opened")).toBeTruthy()
    );

    expectOpenedWithoutSealed();
    expect(screen.queryByLabelText("Capsule sealed")).toBeNull();
  });

  it("opens exactly once and never re-enters the check afterwards", async () => {
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      nowUtc: OPEN_AT + 1000,
    });
    (openCapsule as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      vault: FAKE_VAULT,
      cryptoKey: FAKE_CRYPTO_KEY,
    });

    renderController({ secret: SECRET });

    await waitFor(() =>
      expect(screen.getByTestId("capsule-opened")).toBeTruthy()
    );
    await settle();

    expect(openCapsule).toHaveBeenCalledTimes(1);
    expectOpenedWithoutSealed();
  });

  it("passes the trusted-time decision through: a not-yet-open boundary never opens", async () => {
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      nowUtc: OPEN_AT - 1, // one millisecond early
    });

    renderController({ secret: SECRET });

    await waitFor(() =>
      expect(screen.getByLabelText("Capsule sealed")).toBeTruthy()
    );

    expect(openCapsule).not.toHaveBeenCalled();
    expect(sequence()).not.toContain("opened");
  });
});

/* ============================================================
   3. FAIL-CLOSED OUTCOMES
   ============================================================ */

describe("3. fail-closed — never `opened` without a proven successful open", () => {
  it("trusted time unavailable → fail-closed SEALED (and never opened)", async () => {
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("[AETERNA] Trusted time unavailable")
    );

    renderController({ secret: SECRET });

    await waitFor(() =>
      expect(screen.getByLabelText("Capsule sealed")).toBeTruthy()
    );

    expectFailClosedSealed();
    expect(sequence()).not.toContain("recovering");
    expect(openCapsule).not.toHaveBeenCalled();
  });

  it("trusted time violation (malformed payload) → fail-closed SEALED", async () => {
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("[AETERNA] Trusted time violation")
    );

    renderController({ secret: SECRET });

    await waitFor(() =>
      expect(screen.getByLabelText("Capsule sealed")).toBeTruthy()
    );

    expectFailClosedSealed();
    expect(sequence()).not.toContain("recovering");
    expect(openCapsule).not.toHaveBeenCalled();
  });

  it("no capability in this tab → fail-closed SEALED, not a permanent loader", async () => {
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      nowUtc: OPEN_AT + 1000,
    });

    renderController(); // no secret

    await waitFor(() =>
      expect(screen.getByLabelText("Capsule sealed")).toBeTruthy()
    );

    expectFailClosedSealed();
    expect(openCapsule).not.toHaveBeenCalled();
  });

  it("a retryable expired-recipient read failure → recovery UI, never SEALED or opened", async () => {
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      nowUtc: OPEN_AT + 1000,
    });
    (openCapsule as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      retryableOpenError("STORAGE_READ_FAILED")
    );

    renderController({ secret: SECRET });

    await waitFor(() => expect(sequence()).toContain("recovering"));

    expectFailClosedRecovering();
    expect(openCapsule).toHaveBeenCalledTimes(1);
  });

  it("a retryable failure in the creator/authority view keeps the SEALED management card", async () => {
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      nowUtc: OPEN_AT + 1000,
    });
    (openCapsule as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      retryableOpenError("STORAGE_READ_FAILED")
    );

    renderController({
      secret: SECRET,
      creatorAuthorityFragment: "a".repeat(64),
    });

    await waitFor(() =>
      expect(screen.getByLabelText("Capsule sealed")).toBeTruthy()
    );

    expectFailClosedSealed();
    expect(sequence()).not.toContain("recovering");
  });

  it("INVALID_SECRET stays terminal — the error view, not SEALED", async () => {
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      nowUtc: OPEN_AT + 1000,
    });
    (openCapsule as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("bad secret"), { code: "INVALID_SECRET" })
    );

    renderController({ secret: SECRET });

    await waitFor(() =>
      expect(
        screen.getByText(/Could not load capsule/i)
      ).toBeTruthy()
    );

    expectTerminalError();
  });

  it("a manifest load failure stays terminal — the error view", async () => {
    (loadManifest as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("[AETERNA] Capsule is sealed")
    );

    renderController({ secret: SECRET });

    await waitFor(() =>
      expect(screen.getByText(/Could not load capsule/i)).toBeTruthy()
    );

    expectTerminalError();
  });
});

/* ============================================================
   4. `checking` is strictly transient
   ============================================================ */

describe("4. `checking` is transient — it always resolves", () => {
  it("every non-success resolution leaves `checking`", async () => {
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("offline")
    );

    renderController({ secret: SECRET });

    await waitFor(() => expect(sequence()).toContain("preview"));
    expect(sequence()[sequence().length - 1]).toBe("preview");
    expect(screen.getByLabelText("Capsule sealed")).toBeTruthy();
  });
});

/* ============================================================
   5. protocol surface unchanged (Confirm Presence / heartbeat / time)
   ============================================================ */

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTROLLER_SRC = readFileSync(
  resolve(HERE, "CapsuleController.tsx"),
  "utf8"
);
const VIEW_SRC = readFileSync(resolve(HERE, "CapsuleView.tsx"), "utf8");

describe("5. Confirm Presence, heartbeat and trusted-time surfaces are untouched", () => {
  it("Confirm Presence is still wired through the preview state only", () => {
    expect(CONTROLLER_SRC).toMatch(/onConfirmPresence:/);
    expect(CONTROLLER_SRC).toMatch(/confirmPresence\(\{/);
    expect(CONTROLLER_SRC).toMatch(/creatorAuthorityFragment:\s*\n?\s*fragment/);
    expect(VIEW_SRC).toMatch(
      /authorityMode\s*&&\s*handleConfirmPresence\s*&&\s*\(/
    );
  });

  it("the heartbeat surface is unchanged (record load + poll + resolver)", () => {
    expect(CONTROLLER_SRC).toMatch(/loadHeartbeatRecord\(/);
    expect(CONTROLLER_SRC).toMatch(/heartbeatPollRef\.current\s*=/);
    expect(CONTROLLER_SRC).toMatch(/resolveEffectiveOpenAt\(/);
    expect(CONTROLLER_SRC).toMatch(/lastConfirmedAt:\s*\n?\s*heartbeatRef\.current/);
  });

  it("trusted time remains the ONLY open-boundary authority", () => {
    expect(CONTROLLER_SRC).toMatch(/getTrustedTime\(\)/);
    // No ambient clock anywhere in the controller: local time must
    // never substitute for trusted time.
    expect(CONTROLLER_SRC).not.toMatch(/Date\.now\(/);
    expect(CONTROLLER_SRC).not.toMatch(/performance\.now\(/);
    // The open decision still compares nowUtc against the resolver.
    expect(CONTROLLER_SRC).toMatch(/nowUtc\s*<\s*effectiveOpenAt/);
  });

  it("`preview` is committed from exactly one decision point (source pin)", () => {
    // `commitSealed` is the single writer of the SEALED display, and
    // `init()` must never commit `preview`.
    expect(CONTROLLER_SRC).toMatch(
      /commitSealed\s*=\s*\(manifest: ManifestV1\)/
    );
    expect(CONTROLLER_SRC).toMatch(/commit\(\{\s*\n?\s*status: "checking"/);
    expect(CONTROLLER_SRC).not.toMatch(/status: "preview",\s*\n?\s*manifest: manifestRef\.current!/);
  });

  it("CapsuleView keeps a dedicated neutral `checking` branch", () => {
    expect(VIEW_SRC).toMatch(/state\.status === "checking"/);
    expect(VIEW_SRC).toMatch(/Opening capsule…/);
  });
});

/* ============================================================
   6. CAPABILITY-RETRY FIX — the secret survives a retryable failure
   ============================================================
 *
 * Root cause pinned here: `tryOpen` clears `secretRef.current` at the
 * ownership handoff. Before the fix the secret was NEVER restored, so a
 * single transient infrastructure failure destroyed the only capability
 * in the tab; every subsequent automatic retry read an empty ref and
 * could never recover without a full page reload (which re-parses the
 * capability from the URL fragment).
 *
 * These tests use fake timers to drive the EXISTING bounded retry
 * mechanism (the 5 s interval / focus / visibilitychange). Awaiting
 * `openCapsule(...)` is a plain microtask — only the interval needs a
 * timer — so no `waitFor`/`setTimeout` polling is required.
 */

describe("6. capability-retry — a transient failure recovers WITHOUT a page reload", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Deterministic non-empty capability fragment. This satisfies the
    // controller's known length-based `!secretLocal` guard so the retry
    // path is reached, while `openCapsule` stays a mock (no real secret
    // is ever used for crypto in this suite).
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        href: "http://localhost/capsule/" + CAPSULE_ID + "#" + SECRET,
        origin: "http://localhost",
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reaches `opened` on a later retry tick (transient read failure → recovery)", async () => {
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      nowUtc: OPEN_AT + 1000,
    });

    // Attempt #1: TRANSIENT infrastructure failure.
    // Attempt #2: success — the recovery WITHOUT a page reload.
    const open = openCapsule as unknown as ReturnType<typeof vi.fn>;
    open
      .mockRejectedValueOnce(new Error("[AETERNA] Range read failed"))
      .mockResolvedValueOnce({ vault: FAKE_VAULT, cryptoKey: FAKE_CRYPTO_KEY });

    renderController({ secret: SECRET });

    await act(async () => {});
    expect(openCapsule).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("capsule-opened")).toBeNull();

    // Fire the EXISTING 5 s retry interval. Attempt #2 must find the
    // RETAINED capability; before the fix `secretRef.current` was "".
    await advanceRetryInterval(1);

    expect(openCapsule).toHaveBeenCalledTimes(2);

    // The retry passes the SAME capability (and it is never transmitted:
    // openCapsule is the only consumer, a local mock).
    const firstCall = open.mock.calls[0]?.[0] as { secret: string };
    const secondCall = open.mock.calls[1]?.[0] as { secret: string };
    expect(firstCall.secret).toBe(SECRET);
    expect(secondCall.secret).toBe(SECRET);

    expect(screen.getByTestId("capsule-opened")).toBeTruthy();
    expect(sequence()).not.toContain("error");
  });

  it("a terminal failure WIPES the capability — no retry, no endless PBKDF2", async () => {
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      nowUtc: OPEN_AT + 1000,
    });
    (openCapsule as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("bad secret"), { code: "INVALID_SECRET" })
    );

    renderController({ secret: SECRET });

    await act(async () => {});
    expect(screen.getByText(/Could not load capsule/i)).toBeTruthy();
    expect(openCapsule).toHaveBeenCalledTimes(1);

    // Several retry windows pass; the terminated pipeline must NOT
    // re-run the expensive open.
    await advanceRetryInterval(5);

    expect(openCapsule).toHaveBeenCalledTimes(1);
    expect(sequence()).not.toContain("opened");
  });

  it("repeated retry triggers never create concurrent openCapsule calls", async () => {
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      nowUtc: OPEN_AT + 1000,
    });

    // Attempt #1 hangs until released — the in-flight window.
    const pending = deferred<{ vault: unknown; cryptoKey: CryptoKey }>();
    (openCapsule as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      pending.promise
    );

    renderController({ secret: SECRET });

    await act(async () => {});
    expect(openCapsule).toHaveBeenCalledTimes(1);

    // Hammer the retry triggers while attempt #1 is still in flight:
    // interval ticks + focus + visibilitychange.
    for (let i = 0; i < 3; i++) {
      await advanceRetryInterval(1);
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
      });
    }

    // Single-flight preserved — still exactly one open.
    expect(openCapsule).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({ vault: FAKE_VAULT, cryptoKey: FAKE_CRYPTO_KEY });
    });

    expect(screen.getByTestId("capsule-opened")).toBeTruthy();
    // The success path never re-enters the pipeline.
    expect(openCapsule).toHaveBeenCalledTimes(1);
  });

  it("a trusted-time OUTAGE stays fail-closed but permits a later retry", async () => {
    // Trusted time fails on attempt #1, then recovers. The capability was
    // never consumed (no openCapsule call happened), so the pipeline must
    // remain retryable.
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("[AETERNA] Trusted time unavailable"))
      .mockResolvedValue({ nowUtc: OPEN_AT + 1000 });
    (openCapsule as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      vault: FAKE_VAULT,
      cryptoKey: FAKE_CRYPTO_KEY,
    });

    renderController({ secret: SECRET });

    await act(async () => {});

    // Fail-closed: SEALED, never opened, and no open was attempted
    // (the capability was never consumed by the time outage).
    expect(screen.getByLabelText("Capsule sealed")).toBeTruthy();
    expect(openCapsule).not.toHaveBeenCalled();
    expect(sequence()).not.toContain("opened");

    // A later retry with a recovered time endpoint opens the capsule.
    await advanceRetryInterval(1);

    expect(screen.getByTestId("capsule-opened")).toBeTruthy();
    expect(openCapsule).toHaveBeenCalledTimes(1);
    expect(sequence()[sequence().length - 1]).toBe("opened");
  });

  it("a still-closed capsule NEVER transitions to `opened` across retry ticks", async () => {
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      nowUtc: OPEN_AT - 1, // one millisecond early — still sealed
    });

    renderController({ secret: SECRET });

    await act(async () => {});
    expect(screen.getByLabelText("Capsule sealed")).toBeTruthy();

    await advanceRetryInterval(3);

    expect(openCapsule).not.toHaveBeenCalled();
    expect(sequence()).not.toContain("opened");
    expect(screen.queryByTestId("capsule-opened")).toBeNull();
  });

  it("retains the capability WITHOUT logging or transmitting it", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("{}"));

    try {
      (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        nowUtc: OPEN_AT + 1000,
      });
      (openCapsule as unknown as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(
          Object.assign(new Error("[AETERNA] Range read failed"), {
            // A hostile payload that must never be surfaced.
            detail: SECRET,
          })
        )
        .mockResolvedValueOnce({
          vault: FAKE_VAULT,
          cryptoKey: FAKE_CRYPTO_KEY,
        });

      renderController({ secret: SECRET });

      await act(async () => {});
      await advanceRetryInterval(1);

      expect(screen.getByTestId("capsule-opened")).toBeTruthy();

      // No console call carried the capability.
      const allArgs = [
        ...logSpy.mock.calls,
        ...warnSpy.mock.calls,
        ...errorSpy.mock.calls,
      ]
        .flat()
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a ?? "")))
        .join(" ");
      expect(allArgs).not.toContain(SECRET);

      // Nothing was sent to the network with the capability in the URL.
      for (const call of fetchSpy.mock.calls) {
        expect(String(call[0])).not.toContain(SECRET);
      }
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });
});

/* ============================================================
   7. TYPED BOUNDARY CLASSIFICATION — the controller obeys the
      error categories produced by `openCapsule`'s boundaries
   ============================================================
 *
 * Section 6 exercised the retry mechanism with BARE `Error`s (the
 * fail-closed default → retryable). This section pins the OTHER half of
 * the contract: when the open boundary raises a TYPED category, the
 * controller must honour it — terminal failures must NOT be retried,
 * retryable failures MUST be.
 *
 * Every rejection below is a `CapsuleOpenError` produced by
 * `terminalOpenError` / `retryableOpenError` / `notOpenError` — i.e.
 * exactly what `openCapsule` now throws at its real boundaries.
 */

describe("7. typed boundary classification drives the retry decision", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        href: "http://localhost/capsule/" + CAPSULE_ID + "#" + SECRET,
        origin: "http://localhost",
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a TRANSIENT network failure (retryable) then success reaches `opened`", async () => {
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      nowUtc: OPEN_AT + 1000,
    });
    (openCapsule as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(retryableOpenError("STORAGE_READ_FAILED"))
      .mockResolvedValueOnce({ vault: FAKE_VAULT, cryptoKey: FAKE_CRYPTO_KEY });

    renderController({ secret: SECRET });

    await act(async () => {});
    expect(openCapsule).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("capsule-opened")).toBeNull();

    await advanceRetryInterval(1);

    expect(openCapsule).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("capsule-opened")).toBeTruthy();
    expect(sequence()).not.toContain("error");
  });

  it("an INVALID capability (terminal) stops the pipeline — no endless retries", async () => {
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      nowUtc: OPEN_AT + 1000,
    });
    (openCapsule as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      terminalOpenError("INVALID_CAPABILITY")
    );

    renderController({ secret: SECRET });

    await act(async () => {});
    expect(screen.getByText(/Could not load capsule/i)).toBeTruthy();
    expect(openCapsule).toHaveBeenCalledTimes(1);

    await advanceRetryInterval(6);

    expect(openCapsule).toHaveBeenCalledTimes(1);
    expect(sequence()).not.toContain("opened");
    expect(sequence()).not.toContain("preview");
  });

  it("a CRYPTOGRAPHIC failure (terminal) stops the pipeline — no PBKDF2 loop", async () => {
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      nowUtc: OPEN_AT + 1000,
    });
    (openCapsule as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      terminalOpenError("CRYPTO_FAILURE")
    );

    renderController({ secret: SECRET });

    await act(async () => {});
    expect(screen.getByText(/Could not load capsule/i)).toBeTruthy();

    await advanceRetryInterval(6);

    expect(openCapsule).toHaveBeenCalledTimes(1);
    expect(sequence()).not.toContain("opened");
  });

  it("an INTEGRITY violation (terminal) never opens and never retries", async () => {
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      nowUtc: OPEN_AT + 1000,
    });
    (openCapsule as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      terminalOpenError("INTEGRITY_VIOLATION")
    );

    renderController({ secret: SECRET });

    await act(async () => {});
    expect(screen.getByText(/Could not load capsule/i)).toBeTruthy();

    await advanceRetryInterval(6);

    expect(openCapsule).toHaveBeenCalledTimes(1);
    expect(sequence()).not.toContain("opened");
    expect(screen.queryByTestId("capsule-opened")).toBeNull();
  });

  it("a NOT-OPEN result (trusted time) stays SEALED and never opens — even across retries", async () => {
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      nowUtc: OPEN_AT + 1000,
    });
    // The boundary itself reports not-open (as `openCapsule` does when
    // nowUtc < effectiveOpenAt) while the controller's own pre-check
    // lets the call through.
    (openCapsule as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      notOpenError("nowUtc < effectiveOpenAt")
    );

    renderController({ secret: SECRET });

    await act(async () => {});
    // not-open is neither terminal (no error view) nor a success.
    expect(screen.queryByTestId("capsule-opened")).toBeNull();

    await advanceRetryInterval(3);

    expect(sequence()).not.toContain("opened");
    expect(screen.queryByTestId("capsule-opened")).toBeNull();
  });

  it("trusted-time UNAVAILABLE (retryable) is fail-closed but retryable to success", async () => {
    // The controller's own getTrustedTime is mocked here; the point is
    // that a retryable classification never terminates the pipeline.
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(retryableOpenError("TRUSTED_TIME_UNAVAILABLE"))
      .mockResolvedValue({ nowUtc: OPEN_AT + 1000 });
    (openCapsule as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      vault: FAKE_VAULT,
      cryptoKey: FAKE_CRYPTO_KEY,
    });

    renderController({ secret: SECRET });

    await act(async () => {});
    expect(screen.getByLabelText("Capsule sealed")).toBeTruthy();
    expect(openCapsule).not.toHaveBeenCalled();

    await advanceRetryInterval(1);

    expect(screen.getByTestId("capsule-opened")).toBeTruthy();
    expect(openCapsule).toHaveBeenCalledTimes(1);
  });

  it("a still-closed capsule (controller pre-check) never opens across retries", async () => {
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      nowUtc: OPEN_AT - 1,
    });

    renderController({ secret: SECRET });

    await act(async () => {});
    expect(screen.getByLabelText("Capsule sealed")).toBeTruthy();

    await advanceRetryInterval(4);

    expect(openCapsule).not.toHaveBeenCalled();
    expect(sequence()).not.toContain("opened");
  });
});

/* ============================================================
   8. creator presence → recipient effective date (UI)

   The recipient card date is the EFFECTIVE opening date derived
   from the persisted heartbeat (CapsuleController [В]/[Г]), and the
   30 s heartbeat poll updates an already-open page without reload.
   ============================================================ */

describe("8. creator presence → recipient effective date and notice", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Mirrors CapsuleView.formatUTCDate exactly (en-US, UTC). */
  function expectedOpenDate(ts: number): string {
    return new Date(ts).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "2-digit",
      timeZone: "UTC",
    });
  }

  it("renders the heartbeat-shifted effective date on the recipient card (initial load)", async () => {
    // The creator confirmed presence 10 days before the sealed boundary:
    // effective = lastConfirmedAt + 30d = OPEN_AT + 20d (interval <= 30d).
    const confirmedAt = OPEN_AT - 10 * DAY_MS;
    (loadHeartbeatRecord as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      capsuleId: CAPSULE_ID,
      lastConfirmedAt: confirmedAt,
    });
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      nowUtc: confirmedAt + 1000, // still inside the confirmation window
    });

    renderController(); // recipient: no secret, no authority fragment

    await waitFor(() =>
      expect(
        screen.getByText(`Opens on ${expectedOpenDate(OPEN_AT + 20 * DAY_MS)} (UTC)`)
      ).toBeTruthy()
    );
    // The immutable manifest.openAt string is NOT displayed instead.
    expect(
      screen.queryByText(`Opens on ${expectedOpenDate(OPEN_AT)} (UTC)`)
    ).toBeNull();
  });

  it("shows the recipient explanatory notice with the Learn-why link", async () => {
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      nowUtc: SEALED_AT + 1000,
    });

    renderController(); // recipient

    await waitFor(() =>
      expect(
        screen.getByText("The opening date of this capsule may change over time.")
      ).toBeTruthy()
    );
    const link = screen.getByText("Learn why →").closest("a");
    expect(link?.getAttribute("href")).toBe("/protocol#creator-presence");
  });

  it("does NOT show the recipient notice on the creator/authority card", async () => {
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      nowUtc: SEALED_AT + 1000,
    });

    renderController({ creatorAuthorityFragment: "f".repeat(64) });

    await waitFor(() =>
      expect(screen.getByLabelText("Capsule sealed")).toBeTruthy()
    );
    expect(
      screen.queryByText("The opening date of this capsule may change over time.")
    ).toBeNull();
    // The creator sees the authority security text instead.
    expect(
      screen.getByText(/This link contains a capability fragment/)
    ).toBeTruthy();
  });

  it("an already-open (preview) recipient page auto-updates the date via the 30 s heartbeat poll", async () => {
    vi.useFakeTimers();

    let lastConfirmedAt: number | null = OPEN_AT - 10 * DAY_MS;
    (
      loadHeartbeatRecord as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(async () => ({
      capsuleId: CAPSULE_ID,
      lastConfirmedAt,
    }));
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      nowUtc: SEALED_AT + 1000,
    });

    renderController(); // recipient

    await act(async () => {});
    expect(
      screen.getByText(`Opens on ${expectedOpenDate(OPEN_AT + 20 * DAY_MS)} (UTC)`)
    ).toBeTruthy();

    // The creator confirms again: the persisted heartbeat moves.
    lastConfirmedAt = OPEN_AT - 5 * DAY_MS; // effective = OPEN_AT + 25d

    // Fire the EXISTING 30 s heartbeat poll — no reload, no navigation.
    await act(async () => {
      vi.advanceTimersByTime(30000);
    });

    expect(
      screen.getByText(`Opens on ${expectedOpenDate(OPEN_AT + 25 * DAY_MS)} (UTC)`)
    ).toBeTruthy();
    expect(
      screen.queryByText(`Opens on ${expectedOpenDate(OPEN_AT + 20 * DAY_MS)} (UTC)`)
    ).toBeNull();
  });
});
