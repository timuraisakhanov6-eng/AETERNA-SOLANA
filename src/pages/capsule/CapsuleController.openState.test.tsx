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
import { render, screen, waitFor, cleanup } from "@testing-library/react";
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

function renderController(props: { secret?: string } = {}) {
  return render(
    createElement(
      MemoryRouter,
      null,
      createElement(CapsuleController, {
        capsuleId: CAPSULE_ID,
        ...(props.secret !== undefined ? { secret: props.secret } : {}),
      } as never)
    )
  );
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

  it("a generic open failure → fail-closed SEALED, never opened", async () => {
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      nowUtc: OPEN_AT + 1000,
    });
    (openCapsule as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("[AETERNA] Range read failed")
    );

    renderController({ secret: SECRET });

    await waitFor(() =>
      expect(screen.getByLabelText("Capsule sealed")).toBeTruthy()
    );

    expectFailClosedSealed();
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
