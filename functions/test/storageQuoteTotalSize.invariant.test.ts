/**
 * AETERNA — Complete Irys Storage Quote (encrypted Vault + ALL media chunks)
 *
 * Regression suite for the canonical/implementation gap proven on
 * 2026-09-27: the storage quote previously priced ONLY
 * `projection.encryptedSizeBytes` (the encrypted Vault blob, metadata
 * JSON only) and silently excluded every encrypted media chunk.
 *
 * Canonical model (AETERNA_IRYS_DIRECT_CREATOR_PAYMENT_AND_CHUNK_PAYMENT_POLICY_SPEC.md
 * §3 + AETERNA_COMPLETE_SYSTEM_LOGIC.md "Capsule Storage Quote Authority"):
 * the Capsule Storage Quote covers the PERMANENT STORAGE of the whole
 * capsule, so the single byte count handed to the Irys price endpoint
 * must be
 *
 *     totalIrysStorageBytes =
 *         projection.encryptedSizeBytes      // encrypted VAULT
 *       + projection.totalChunkSizeBytes     // Σ encrypted MEDIA chunks
 *
 * Byte semantics (constants.ts):
 *   encryptedSizeBytes  = encryptVault output length  (metadata JSON only)
 *   totalChunkSizeBytes = Σ chunkMetadata[].size      (encryptChunk output)
 * Each chunk's `size` is its CIPHERTEXT length, i.e. plaintext +
 * 12-byte IV + 16-byte auth tag (MAX_ENCRYPTED_CHUNK_SIZE =
 * MAX_CHUNK_SIZE + 28). The AES-GCM overhead is therefore ALREADY part
 * of totalChunkSizeBytes and must NOT be added again.
 *
 * These tests drive the REAL /api/storage/quote handler against the
 * REAL Irys price helper (only global fetch is stubbed), so they pin the
 * exact request path `/price/usdc-solana/<total>` and the resulting
 * atomic amount.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createFakeKV, createFakeRequest, makeEventContext } from "./harness";
import { onRequestPost as storageQuotePost } from "./../api/storage/quote";
import { onRequestPost as preparedPost } from "./../api/capsule/prepared";
import { onRequestPost as serviceQuotePost } from "./../api/service-payment/create-quote";
import {
  AES_GCM_IV_LENGTH,
  AES_GCM_TAG_LENGTH,
  MAX_CHUNK_SIZE,
  MAX_ENCRYPTED_CHUNK_SIZE,
} from "../../src/lib/crypto/constants";

/* ================= CONSTANTS ================= */

const ORIGIN = "https://aeternacapsule.com";

const IDENTITY_ID = "f".repeat(32);
const WALLET_ACCOUNT = "CreatorWalletAccount111111111111111111111111";
const CAPSULE_ID = "a".repeat(64);
const LIFECYCLE_ID = "lifecycle-1";

const LOCAL_VAULT_POINTER = `aeterna-local-vault:${CAPSULE_ID}`;
const VAULT_SHA256 = "c".repeat(64);
const SALT_BASE = "d".repeat(32);

const IRYS_DESTINATION = "9NERQjLetzquGwdKt3X4gZ8fE8fPfSkj2xo2esmUjWsz";

const USDC_DECIMALS = 1_000_000;

const PRICE_URL_PREFIX = "https://uploader.irys.xyz/price/usdc-solana/";
const IRYS_INFO_URL = "https://uploader.irys.xyz/info";

/** AES-GCM per-chunk overhead already embedded in every chunk ciphertext. */
const AES_GCM_OVERHEAD = AES_GCM_IV_LENGTH + AES_GCM_TAG_LENGTH / 8; // 28

/* ================= IRYS FETCH STUB ================= */

let priceRequests: string[] = [];

/**
 * Stubs ONLY global fetch, letting the real storageQuoteIrys helpers
 * build the request. Every price request is recorded verbatim so the
 * exact byte count in the path can be asserted.
 */
function stubIrys(atomic: string) {
  const routing = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.startsWith(PRICE_URL_PREFIX)) {
      priceRequests.push(url);
      return new Response(atomic, { status: 200 });
    }

    if (url === IRYS_INFO_URL) {
      return new Response(
        JSON.stringify({ addresses: { "usdc-solana": IRYS_DESTINATION } }),
        { status: 200 }
      );
    }

    return new Response("unexpected", { status: 500 });
  });

  vi.stubGlobal("fetch", routing);
  return routing;
}

/* ================= PROJECTION + ENV FIXTURES ================= */

function makeProjection(overrides: Record<string, unknown> = {}) {
  return {
    preparedProjectionId: "prep-1",
    creatorIdentityId: IDENTITY_ID,
    walletAccount: WALLET_ACCOUNT,
    lifecycleId: LIFECYCLE_ID,
    capsuleId: CAPSULE_ID,
    encryptedSizeBytes: 1700,
    vaultSha256: VAULT_SHA256,
    saltBase: SALT_BASE,
    encryptedVaultPointer: LOCAL_VAULT_POINTER,
    chunkCount: 0,
    totalChunkSizeBytes: 0,
    createdAt: 1_800_000_000_000,
    expiresAt: Date.now() + 600_000,
    state: "ACTIVE",
    ...overrides,
  };
}

async function buildQuoteEnv(proj: Record<string, unknown>) {
  const PREPARED_PROJECTIONS = createFakeKV();
  await PREPARED_PROJECTIONS.put(
    `prepared-projection:${CAPSULE_ID}`,
    JSON.stringify(proj)
  );
  return { PREPARED_PROJECTIONS, STORAGE_QUOTES: createFakeKV() };
}

interface QuoteBody {
  ok: boolean;
  billableSizeBytes: number;
  expectedAmountAtomic: string;
  displayAmountUSDC: string;
  capsuleId: string;
  storagePaymentId: string;
  state: string;
  error?: string;
}

const postStorageQuote = storageQuotePost as unknown as (
  ctx: unknown
) => Promise<Response>;

async function submitQuote(env: unknown): Promise<QuoteBody & { status: number }> {
  const request = createFakeRequest({
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: {
      creatorIdentityId: IDENTITY_ID,
      lifecycleId: LIFECYCLE_ID,
      capsuleId: CAPSULE_ID,
      preparedProjectionId: "prep-1",
    },
  });
  const res = await postStorageQuote(makeEventContext({ request, env: env as never }));
  return { status: res.status, ...((await res.json()) as QuoteBody) };
}

beforeEach(() => {
  priceRequests = [];
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ================= 1-3, 5: quote total = vault + chunks ================= */

describe("Irys quote total = encrypted Vault + ALL encrypted media chunks", () => {
  it("1. VAULT-ONLY capsule quotes exactly the encrypted vault size", async () => {
    stubIrys("235");
    const env = await buildQuoteEnv(
      makeProjection({
        encryptedSizeBytes: 1700,
        chunkCount: 0,
        totalChunkSizeBytes: 0,
      })
    );

    const body = await submitQuote(env);

    expect(body.status).toBe(200);
    expect(body.billableSizeBytes).toBe(1700);
    // The single size handed to Irys is the vault size (no chunks).
    expect(priceRequests).toEqual([`${PRICE_URL_PREFIX}1700`]);
  });

  it("2. ONE MEDIA CHUNK quotes vault + that chunk's encrypted bytes", async () => {
    stubIrys("900");

    const vaultBytes = 1700;
    const plaintext = 1_048_576; // 1 MiB
    const encryptedChunk = plaintext + AES_GCM_OVERHEAD; // 1_048_604

    const env = await buildQuoteEnv(
      makeProjection({
        encryptedSizeBytes: vaultBytes,
        chunkCount: 1,
        totalChunkSizeBytes: encryptedChunk,
      })
    );

    const body = await submitQuote(env);

    expect(body.status).toBe(200);
    expect(body.billableSizeBytes).toBe(vaultBytes + encryptedChunk);
    expect(priceRequests).toEqual([
      `${PRICE_URL_PREFIX}${vaultBytes + encryptedChunk}`,
    ]);
  });

  it("3. MULTIPLE MEDIA CHUNKS quote vault + Σ(all encrypted chunk bytes)", async () => {
    stubIrys("42000");

    const vaultBytes = 1700;
    const chunks = [
      4_194_304 + AES_GCM_OVERHEAD, // 4 MiB video part
      2_097_152 + AES_GCM_OVERHEAD, // 2 MiB video part
      524_288 + AES_GCM_OVERHEAD, //   512 KiB image
    ];
    const chunkSum = chunks.reduce((sum, size) => sum + size, 0);

    const env = await buildQuoteEnv(
      makeProjection({
        encryptedSizeBytes: vaultBytes,
        chunkCount: chunks.length,
        totalChunkSizeBytes: chunkSum,
      })
    );

    const body = await submitQuote(env);

    expect(body.status).toBe(200);
    expect(body.billableSizeBytes).toBe(vaultBytes + chunkSum);
    expect(priceRequests).toEqual([
      `${PRICE_URL_PREFIX}${vaultBytes + chunkSum}`,
    ]);
  });

  it("5. EXACT BYTE COUNT — no rounding of the summed total", async () => {
    stubIrys("27482");

    const vaultBytes = 1689;
    const chunkSum = 9_594_470; // 2 videos + 1 image (real production figure)
    const expectedTotal = vaultBytes + chunkSum; // 9_596_159

    const env = await buildQuoteEnv(
      makeProjection({
        encryptedSizeBytes: vaultBytes,
        chunkCount: 3,
        totalChunkSizeBytes: chunkSum,
      })
    );

    const body = await submitQuote(env);

    expect(body.status).toBe(200);
    expect(body.billableSizeBytes).toBe(expectedTotal);
    expect(priceRequests).toEqual([`${PRICE_URL_PREFIX}${expectedTotal}`]);
    // Not rounded to a power of two / MiB boundary.
    expect(expectedTotal % 1024).not.toBe(0);
  });
});

/* ================= 4: 2 VIDEO + 1 IMAGE + 1 TEXT ================= */

describe("4. 2 videos + 1 image + 1 text — text excluded, 3 media chunks included", () => {
  async function buildCombinedEnv() {
    const CREATOR_IDENTITIES = createFakeKV();
    await CREATOR_IDENTITIES.put(
      `creator:identity:solana:${WALLET_ACCOUNT}`,
      JSON.stringify({
        id: IDENTITY_ID,
        network: "solana",
        account: WALLET_ACCOUNT,
        firstVerifiedAt: 1_800_000_000_000,
        lastVerifiedAt: 1_800_000_000_000,
      })
    );
    await CREATOR_IDENTITIES.put(
      `creator:identity:id:${IDENTITY_ID}`,
      `solana:${WALLET_ACCOUNT}`
    );
    return {
      CREATOR_IDENTITIES,
      PREPARED_PROJECTIONS: createFakeKV(),
      CREATOR_CREDITS: createFakeKV(),
      STORAGE_QUOTES: createFakeKV(),
    };
  }

  it("sums only the 3 media chunk ciphertexts and quotes vault + that sum", async () => {
    stubIrys("27482");

    const env = await buildCombinedEnv();

    // The client's chunkMetadata carries ONLY media chunks: the text
    // item is skipped upstream (prepareMediaChunks: `if (item.type !==
    // "media") continue;`) and therefore contributes no chunk entry.
    const video1 = 4_194_304 + AES_GCM_OVERHEAD;
    const video2 = 2_097_152 + AES_GCM_OVERHEAD;
    const image = 524_288 + AES_GCM_OVERHEAD;
    const expectedChunkSum = video1 + video2 + image;

    const preparedRequest = createFakeRequest({
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: {
        creatorIdentityId: IDENTITY_ID,
        lifecycleId: LIFECYCLE_ID,
        capsuleId: CAPSULE_ID,
        encryptedSizeBytes: 1700,
        vaultSha256: VAULT_SHA256,
        saltBase: SALT_BASE,
        encryptedVaultPointer: LOCAL_VAULT_POINTER,
        chunkMetadata: [
          { chunkId: "1".repeat(64), mediaId: "video-1", index: 0, size: video1 },
          { chunkId: "2".repeat(64), mediaId: "video-2", index: 0, size: video2 },
          { chunkId: "3".repeat(64), mediaId: "image-1", index: 0, size: image },
        ],
      },
    });

    const preparedRes = await (preparedPost as unknown as (
      ctx: unknown
    ) => Promise<Response>)(makeEventContext({ request: preparedRequest, env: env as never }));

    expect(preparedRes.status).toBe(200);

    const stored = JSON.parse(
      (await env.PREPARED_PROJECTIONS.get(
        `prepared-projection:${CAPSULE_ID}`
      )) as string
    ) as { chunkCount: number; totalChunkSizeBytes: number; encryptedSizeBytes: number };

    // Text contributes no chunk: exactly 3 media chunks, and the sum is
    // the 3 encrypted chunk ciphertexts only.
    expect(stored.chunkCount).toBe(3);
    expect(stored.totalChunkSizeBytes).toBe(expectedChunkSum);

    const body = await submitQuote(env);

    expect(body.status).toBe(200);
    expect(body.billableSizeBytes).toBe(1700 + expectedChunkSum);
    expect(priceRequests).toEqual([
      `${PRICE_URL_PREFIX}${1700 + expectedChunkSum}`,
    ]);
  });
});

/* ================= 6: AES-GCM overhead included exactly once ================= */

describe("6. AES-GCM overhead is already inside totalChunkSizeBytes", () => {
  it("the stored chunk size includes IV + auth tag (28 bytes)", () => {
    expect(AES_GCM_OVERHEAD).toBe(28);
    expect(MAX_ENCRYPTED_CHUNK_SIZE - MAX_CHUNK_SIZE).toBe(AES_GCM_OVERHEAD);
  });

  it("quotes vault + stored chunk size WITHOUT adding the 28 bytes again", async () => {
    stubIrys("9999");

    const vaultBytes = 1700;
    // A full-size chunk is stored as MAX_ENCRYPTED_CHUNK_SIZE, i.e.
    // plaintext + 12-byte IV + 16-byte tag.
    const env = await buildQuoteEnv(
      makeProjection({
        encryptedSizeBytes: vaultBytes,
        chunkCount: 1,
        totalChunkSizeBytes: MAX_ENCRYPTED_CHUNK_SIZE,
      })
    );

    const body = await submitQuote(env);

    expect(body.status).toBe(200);
    expect(body.billableSizeBytes).toBe(vaultBytes + MAX_ENCRYPTED_CHUNK_SIZE);
    // Must NOT double-count the per-chunk AES-GCM overhead.
    expect(body.billableSizeBytes).not.toBe(
      vaultBytes + MAX_ENCRYPTED_CHUNK_SIZE + AES_GCM_OVERHEAD
    );
    expect(priceRequests).toEqual([
      `${PRICE_URL_PREFIX}${vaultBytes + MAX_ENCRYPTED_CHUNK_SIZE}`,
    ]);
  });
});

/* ================= 7-9: Irys price call / atomic / display ================= */

describe("7-9. Irys price call, expected amount and display", () => {
  it("7. passes the EXACT total byte count to /price/usdc-solana/<total>", async () => {
    stubIrys("27482");

    const vaultBytes = 1700;
    const chunkSum = 7_340_116;
    const total = vaultBytes + chunkSum;

    const env = await buildQuoteEnv(
      makeProjection({
        encryptedSizeBytes: vaultBytes,
        chunkCount: 3,
        totalChunkSizeBytes: chunkSum,
      })
    );

    await submitQuote(env);

    expect(priceRequests).toHaveLength(1);
    expect(priceRequests[0]).toBe(`${PRICE_URL_PREFIX}${total}`);
    // No second, independent price request (single pricing formula).
    expect(new Set(priceRequests).size).toBe(1);
  });

  it("8. expectedAmountAtomic equals the Irys price returned for the total", async () => {
    stubIrys("27482");

    const env = await buildQuoteEnv(
      makeProjection({
        encryptedSizeBytes: 1700,
        chunkCount: 1,
        totalChunkSizeBytes: 7_340_116,
      })
    );

    const body = await submitQuote(env);

    expect(body.status).toBe(200);
    expect(body.expectedAmountAtomic).toBe("27482");
  });

  it("9. display amount derives from the SAME atomic amount", async () => {
    stubIrys("27482");

    const env = await buildQuoteEnv(
      makeProjection({
        encryptedSizeBytes: 1700,
        chunkCount: 1,
        totalChunkSizeBytes: 7_340_116,
      })
    );

    const body = await submitQuote(env);

    expect(body.status).toBe(200);
    expect(body.displayAmountUSDC).toBe(
      (Number("27482") / USDC_DECIMALS).toFixed(6)
    );
    expect(body.displayAmountUSDC).toBe("0.027482");
  });
});

/* ================= fail-closed guard on the new total ================= */

describe("quote total fail-closed guard", () => {
  it("rejects a projection whose chunk size makes the total non-finite", async () => {
    stubIrys("235");

    // A malformed/legacy projection missing totalChunkSizeBytes yields
    // NaN — the quote must fail closed, never price a malformed size.
    const env = await buildQuoteEnv(
      makeProjection({
        encryptedSizeBytes: 1700,
        chunkCount: 0,
        totalChunkSizeBytes: undefined,
      })
    );

    const body = await submitQuote(env);

    expect(body.status).toBe(409);
    expect(body.error).toBe("PREPARED_PROJECTION_INVALID_SIZE");
    // No malformed price request was ever issued.
    expect(priceRequests).toEqual([]);
  });
});

/* ================= 10: $1 service payment unchanged ================= */

describe("10. $1 AETERNA service payment is unchanged", () => {
  it("service-payment/create-quote still returns exactly 1 USDC", async () => {
    const request = createFakeRequest({
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: { paymentIntentId: "intent-1" },
    });

    const res = await (serviceQuotePost as unknown as (
      ctx: unknown
    ) => Promise<Response>)(
      makeEventContext({
        request,
        env: { BUSINESS_QUOTES: createFakeKV() } as never,
      })
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      expectedAmount: number;
      currency: string;
    };

    expect(body.ok).toBe(true);
    expect(body.expectedAmount).toBe(1);
    expect(body.currency).toBe("USDC");
  });
});
