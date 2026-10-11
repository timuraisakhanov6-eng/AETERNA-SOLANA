/**
 * AETERNA — `openCapsule` boundary classification (integration).
 *
 * =========================================================
 * WHY THIS TEST EXISTS
 * =========================================================
 *
 * The retry fix in `CapsuleController` is only as reliable as the
 * CATEGORIES emitted by the open pipeline. Before this change every
 * rejection was a bare `Error` carrying no category, so a transient
 * gateway failure and a terminal AES-GCM authentication failure were
 * indistinguishable — the caller had to guess.
 *
 * This suite drives the REAL `openCapsule` (not a mock) through each
 * boundary with every external dependency mocked, and asserts the
 * emitted `CapsuleOpenError.severity`:
 *
 *   • storage transport failure            → retryable
 *   • trusted-time endpoint failure        → retryable
 *   • trusted time < effectiveOpenAt       → not-open
 *   • size continuation violation          → terminal
 *   • SHA-256 integrity violation          → terminal
 *   • AES-GCM authentication failure       → terminal
 *   • key-derivation / capability reject   → terminal
 *
 * No real capsule, capability, upload, or network is used. Storage,
 * trusted time, heartbeat and the crypto primitives are all mocked; the
 * AES-GCM path is mocked to throw the SAME shared `SEALED_ERROR` message
 * `decryptVault` throws, so the classification is exercised exactly as
 * in Production.
 *
 * NOTE: the SHA-256 boundary is exercised through the REAL `sha256`
 * helper (it is not mocked), so the "valid" fixture must carry the true
 * digest of its ciphertext — otherwise even the happy path would be a
 * terminal integrity violation. `VALID_SHA256` is computed once below.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { classifyOpenFailure, CapsuleOpenError } from "@/lib/capsule/openFailure";
import { sha256 } from "@/lib/crypto/sha256";
import type { ManifestV1 } from "@/types/manifest";

/* ── module mocks: every external boundary of openCapsule ─────────── */

vi.mock("@/lib/storage", () => ({
  storage: { download: vi.fn() },
}));

vi.mock("@/shared/time/getTrustedTime", () => ({
  getTrustedTime: vi.fn(),
}));

vi.mock("@/lib/capsule/loadHeartbeatRecord", () => ({
  loadHeartbeatRecord: vi.fn(),
}));

vi.mock("@/lib/crypto/generateVaultKey", () => ({
  generateVaultKey: vi.fn(),
}));

vi.mock("@/lib/crypto/decryptVault", () => ({
  decryptVault: vi.fn(),
}));

import { openCapsule } from "./openCapsule";
import { storage } from "@/lib/storage";
import { getTrustedTime } from "@/shared/time/getTrustedTime";
import { loadHeartbeatRecord } from "@/lib/capsule/loadHeartbeatRecord";
import { generateVaultKey } from "@/lib/crypto/generateVaultKey";
import { decryptVault } from "@/lib/crypto/decryptVault";

/* ── fixtures ─────────────────────────────────────────────────────── */

const CAPSULE_ID =
  "327c0425565b5801d112c87a43e6651f07eabb9afde8831562c44b4ec3702b40";
const SECRET = "b".repeat(64);
const SEALED_AT = 1_700_000_000_000;
const OPEN_AT = SEALED_AT + 30 * 24 * 60 * 60 * 1000;
const VAULT_POINTER = "d".repeat(43);
const VAULT_BYTES_LEN = 4096;

/** The exact ciphertext the mocked storage returns. */
function makeEncrypted(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(VAULT_BYTES_LEN).fill(7);
}

/**
 * The REAL SHA-256 of the fixture ciphertext. Required so the valid
 * manifest passes `verifyVaultSha256` (which is NOT mocked).
 */
const VALID_SHA256 = await sha256(makeEncrypted());

/** A manifest that passes every structural check in openCapsule. */
function makeManifest(overrides: Record<string, unknown> = {}): ManifestV1 {
  return {
    version: 1 as const,
    capsuleId: CAPSULE_ID,
    openAt: OPEN_AT,
    sealedAt: SEALED_AT,
    // SALT_BASE_REGEX = /^[a-f0-9]{32}$/ — 32 lowercase hex chars.
    saltBase: "c0".repeat(16),
    vaultTxId: VAULT_POINTER,
    encryptedSizeBytes: VAULT_BYTES_LEN,
    heartbeatInterval: 30 * 24 * 60 * 60 * 1000,
    ext: { vaultSha256: VALID_SHA256 },
    ...overrides,
  } as unknown as ManifestV1;
}

/** Canonical VaultV2 shape (mirrors canonicalSerializeVaultV2 output). */
function canonicalVault() {
  return {
    version: 2,
    createdAt: new Date(SEALED_AT).toISOString(),
    capsule: { capsuleId: CAPSULE_ID, items: [] },
  };
}

const FAKE_KEY = { type: "secret" } as unknown as CryptoKey;

async function attempt(overrides?: {
  manifest?: ReturnType<typeof makeManifest>;
  secret?: string;
}) {
  try {
    await openCapsule({
      capsuleId: CAPSULE_ID,
      secret: overrides?.secret ?? SECRET,
      manifest: overrides?.manifest ?? makeManifest(),
    });
    return { threw: false as const };
  } catch (err) {
    return { threw: true as const, err };
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    nowUtc: OPEN_AT + 1000,
  });
  (loadHeartbeatRecord as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
    null
  );
  (storage.download as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
    makeEncrypted()
  );
  (generateVaultKey as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
    FAKE_KEY
  );
  (decryptVault as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
    canonicalVault()
  );
});

/* ── happy path (control) — establishes the fixture is truly valid ── */

describe("openCapsule — happy path control", () => {
  it("a fully-valid open succeeds and yields a canonical vault", async () => {
    const result = await openCapsule({
      capsuleId: CAPSULE_ID,
      secret: SECRET,
      manifest: makeManifest(),
    });

    expect(result.vault.capsule.capsuleId).toBe(CAPSULE_ID);
    expect(result.cryptoKey).toBe(FAKE_KEY);
    expect(decryptVault).toHaveBeenCalledTimes(1);
  });
});

/* ── retryable boundaries ─────────────────────────────────────────── */

describe("openCapsule — retryable infrastructure boundaries", () => {
  it("classifies a trusted-time endpoint failure as retryable", async () => {
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("[AETERNA] Trusted time unavailable")
    );

    const { threw, err } = await attempt();

    expect(threw).toBe(true);
    expect(classifyOpenFailure(err)).toBe("retryable");
  });

  it("classifies a trusted-time payload violation as retryable", async () => {
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("[AETERNA] Trusted time violation")
    );

    expect(classifyOpenFailure((await attempt()).err)).toBe("retryable");
  });

  it("classifies a non-numeric trusted-time payload as retryable", async () => {
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      nowUtc: Number.NaN,
    });

    expect(classifyOpenFailure((await attempt()).err)).toBe("retryable");
  });

  it("classifies a storage/gateway read failure as retryable", async () => {
    (storage.download as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("[AETERNA] Range read failed")
    );

    expect(classifyOpenFailure((await attempt()).err)).toBe("retryable");
  });

  it("classifies a range-read DEADLINE as retryable", async () => {
    (storage.download as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("[AETERNA] Range read timed out")
    );

    expect(classifyOpenFailure((await attempt()).err)).toBe("retryable");
  });

  it("classifies a bare network error as retryable (fail-closed default)", async () => {
    (storage.download as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new TypeError("Failed to fetch")
    );

    expect(classifyOpenFailure((await attempt()).err)).toBe("retryable");
  });
});

/* ── not-open boundary ────────────────────────────────────────────── */

describe("openCapsule — not-yet-open condition", () => {
  it("classifies trusted time before effectiveOpenAt as not-open", async () => {
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      nowUtc: OPEN_AT - 1,
    });

    const { threw, err } = await attempt();

    expect(threw).toBe(true);
    expect(classifyOpenFailure(err)).toBe("not-open");
    // The vault was never even read.
    expect(storage.download).not.toHaveBeenCalled();
  });

  it("a not-open condition never reaches decryption", async () => {
    (getTrustedTime as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      nowUtc: SEALED_AT,
    });

    await attempt();

    expect(storage.download).not.toHaveBeenCalled();
    expect(generateVaultKey).not.toHaveBeenCalled();
    expect(decryptVault).not.toHaveBeenCalled();
  });
});

/* ── terminal integrity boundaries ────────────────────────────────── */

describe("openCapsule — terminal integrity boundaries", () => {
  it("classifies a size-continuity violation as terminal", async () => {
    // Wrong length vs manifest.encryptedSizeBytes.
    (storage.download as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Uint8Array(1024).fill(7)
    );

    const { threw, err } = await attempt();

    expect(threw).toBe(true);
    expect(classifyOpenFailure(err)).toBe("terminal");
    // Never reached key derivation / decryption.
    expect(generateVaultKey).not.toHaveBeenCalled();
    expect(decryptVault).not.toHaveBeenCalled();
  });

  it("classifies a SHA-256 integrity violation as terminal", async () => {
    // Correct length, but the digest will not match ext.vaultSha256.
    // Force the mismatch deterministically by mocking crypto.subtle.digest
    // to a value that cannot equal the real digest.
    const digestSpy = vi
      .spyOn(globalThis.crypto.subtle, "digest")
      .mockResolvedValue(new Uint8Array(32).fill(0).buffer);

    try {
      const { threw, err } = await attempt();

      expect(threw).toBe(true);
      expect(classifyOpenFailure(err)).toBe("terminal");
      expect(generateVaultKey).not.toHaveBeenCalled();
    } finally {
      digestSpy.mockRestore();
    }
  });

  it("classifies a non-Uint8Array download as a terminal integrity violation", async () => {
    (storage.download as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      "not-bytes"
    );

    expect(classifyOpenFailure((await attempt()).err)).toBe("terminal");
  });

  it("classifies an empty download as a terminal integrity violation", async () => {
    (storage.download as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Uint8Array(0)
    );

    expect(classifyOpenFailure((await attempt()).err)).toBe("terminal");
  });
});

/* ── terminal crypto boundaries ───────────────────────────────────── */

describe("openCapsule — terminal cryptographic boundaries", () => {
  it("classifies an AES-GCM authentication failure as terminal", async () => {
    // The canonical shared message decryptVault throws on auth failure.
    (decryptVault as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("[AETERNA] Cryptographic failure")
    );

    const { threw, err } = await attempt();

    expect(threw).toBe(true);
    expect(classifyOpenFailure(err)).toBe("terminal");
  });

  it("classifies a key-derivation (capability) rejection as terminal", async () => {
    (generateVaultKey as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("[AETERNA] Cryptographic failure")
    );

    const { threw, err } = await attempt();

    expect(threw).toBe(true);
    expect(classifyOpenFailure(err)).toBe("terminal");
    expect(decryptVault).not.toHaveBeenCalled();
  });

  it("classifies a successfully-decrypted but non-canonical vault as terminal", async () => {
    (decryptVault as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...canonicalVault(),
      // Injected top-level field — not permitted by the key whitelist.
      injected: true,
    });

    const { threw, err } = await attempt();

    expect(threw).toBe(true);
    expect(classifyOpenFailure(err)).toBe("terminal");
  });

  it("classifies a vault missing createdAt as terminal", async () => {
    (decryptVault as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      version: 2,
      capsule: { capsuleId: CAPSULE_ID, items: [] },
    });

    const { threw, err } = await attempt();

    expect(threw).toBe(true);
    expect(classifyOpenFailure(err)).toBe("terminal");
  });
});

/* ── structural / capability boundary ─────────────────────────────── */

describe("openCapsule — structural rejection boundary", () => {
  it("rejects a malformed secret as terminal (invalid capability)", async () => {
    const bad = await attempt({ secret: "not-a-valid-secret" });

    expect(bad.threw).toBe(true);
    expect(classifyOpenFailure(bad.err)).toBe("terminal");
  });

  it("rejects a manifest whose saltBase is not 32 hex chars", async () => {
    const bad = await attempt({
      manifest: makeManifest({ saltBase: "c2FsdA" }),
    });

    expect(bad.threw).toBe(true);
    expect(classifyOpenFailure(bad.err)).toBe("terminal");
  });

  it("rejects an identity mismatch between capsuleId and manifest", async () => {
    const bad = await attempt({
      manifest: makeManifest({ capsuleId: "a".repeat(64) }),
    });

    expect(bad.threw).toBe(true);
    expect(classifyOpenFailure(bad.err)).toBe("terminal");
  });
});

/* ── manifest-metadata terminal boundary (latent-gap closure) ─────── */

/**
 * These two boundaries (`assertStoragePointer(manifest.vaultTxId)` and
 * `resolveEffectiveOpenAt({ heartbeatInterval })`) throw a BARE `Error`
 * from libraries outside `openCapsule`. Without an explicit wrap they
 * would fall through to the `retryable` fail-closed DEFAULT — retaining
 * the capability for an endless 5 s retry against IMMUTABLE metadata
 * that can never become valid.
 *
 * The tests drive the REAL `openCapsule` with a manifest that passes
 * every earlier structural check so the invalid field is genuinely the
 * one that reaches the boundary. Both must classify as `terminal`, and
 * specifically as `INVALID_MANIFEST` — NOT `INVALID_CAPABILITY`.
 */

describe("openCapsule — manifest-metadata boundaries are TERMINAL", () => {
  it("classifies an invalid storage pointer as terminal INVALID_MANIFEST", async () => {
    // `vaultTxId` is not validated by any earlier check in openCapsule,
    // so this value reaches `assertStoragePointer` at the boundary.
    const { threw, err } = await attempt({
      manifest: makeManifest({ vaultTxId: "not-a-valid-pointer" }),
    });

    expect(threw).toBe(true);
    expect(classifyOpenFailure(err)).toBe("terminal");
    expect(err).toBeInstanceOf(CapsuleOpenError);
    expect((err as CapsuleOpenError).reason).toBe("INVALID_MANIFEST");
    // The vault was never read: the rejection precedes the download.
    expect(storage.download).not.toHaveBeenCalled();
  });

  it("classifies an invalid heartbeatInterval as terminal INVALID_MANIFEST", async () => {
    // A non-integer interval passes every earlier openCapsule check and
    // reaches `resolveEffectiveOpenAt`, which rejects it.
    const { threw, err } = await attempt({
      manifest: makeManifest({ heartbeatInterval: 1.5 }),
    });

    expect(threw).toBe(true);
    expect(classifyOpenFailure(err)).toBe("terminal");
    expect(err).toBeInstanceOf(CapsuleOpenError);
    expect((err as CapsuleOpenError).reason).toBe("INVALID_MANIFEST");
    // Never reached storage read or decryption.
    expect(storage.download).not.toHaveBeenCalled();
    expect(decryptVault).not.toHaveBeenCalled();
  });
});
