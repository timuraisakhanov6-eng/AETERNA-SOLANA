/**
 * AETERNA — Creator-paid Irys Storage Adapter (Phase D2a)
 *
 * Implements the canonical StorageAdapter boundary for the
 * Creator-paid Irys architecture: the creator wallet signs the Irys
 * upload directly (upload-only, NO fund — the storage payment is
 * already PAYMENT_VERIFIED via Phase B), and every upload is followed
 * by a server-side publication claim (Irys Node confirmation) that
 * creates the authoritative publication state / chunk pointer.
 *
 * Executor Hot is NOT used. No keys, no funding, no balance checks.
 * The uploadToken capability is accepted (StorageAdapter contract)
 * but is never sent to Irys or to the claim endpoint.
 *
 * Production callers: none until Phase D2b wiring.
 */

import type { ChunkId } from "@/types/manifest";
import type {
  StorageAdapter,
  StoragePointer,
  UploadToken,
} from "./storageAdapter";
import { assertStoragePointer } from "./storageAdapter";
import { uploadCreatorData, type CreatorIrysWallet } from "./creatorIrys";
import { executorStorage } from "./executorStorage";

export interface CreatorIrysStorageContext {
  /** Creator wallet bound to the $1 payment and this lifecycle. */
  wallet: CreatorIrysWallet;
  creatorIdentityId: string;
  lifecycleId: string;
  capsuleId: string;
  /** Server-quoted storage payment, already PAYMENT_VERIFIED. */
  storagePaymentId: string;
  rpcUrl?: string;
}

interface ClaimResponse {
  ok?: boolean;
  claimed?: boolean;
  state?: string;
  error?: string;
}

/**
 * Operation-level deadline for the discrete `POST /api/publication/claim`.
 *
 * Bounds ONE request only — not the Irys upload, not the capsule
 * preparation, not the page. The claim endpoint's own outbound Irys
 * node confirmation is already internally bounded
 * (`IRYS_NODE_TIMEOUT_MS = 8000` in functions/lib/irys/node.ts), so
 * 15 s gives the Function generous headroom over its own internal
 * budget while still converting a genuinely non-settling request into
 * a rejection. The value matches the project's canonical external
 * HTTP bound (`IRYS_HTTP_TIMEOUT_MS`).
 *
 * The claim is idempotent server-side (Node confirmation + pointer
 * assertion), so an aborted request can be retried safely by the
 * existing callers' retry paths.
 */
const CLAIM_REQUEST_TIMEOUT_MS = 15_000;

async function claimPublication(
  ctx: CreatorIrysStorageContext,
  txId: string,
  kind: "vault" | "chunk",
  chunkId?: string
): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CLAIM_REQUEST_TIMEOUT_MS);

  let res: Response;

  try {
    res = await fetch("/api/publication/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        creatorIdentityId: ctx.creatorIdentityId,
        lifecycleId: ctx.lifecycleId,
        capsuleId: ctx.capsuleId,
        storagePaymentId: ctx.storagePaymentId,
        txId,
        kind,
        ...(chunkId !== undefined ? { chunkId } : {}),
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { error?: string; reason?: string }
      | null;
    const detail = body?.error ?? body?.reason ?? `HTTP_${res.status}`;
    throw new Error(`[AETERNA] creatorIrys: publication claim failed: ${detail}`);
  }

  const json = (await res.json().catch(() => null)) as ClaimResponse | null;
  if (!json || json.ok !== true) {
    throw new Error("[AETERNA] creatorIrys: publication claim malformed response");
  }
}

/**
 * Creates the Creator-paid Irys StorageAdapter. The wallet is
 * injected by the caller (the bound $1/lifecycle wallet) — this
 * module never opens a wallet picker and never substitutes wallets.
 */
export function createCreatorIrysStorage(
  ctx: CreatorIrysStorageContext
): StorageAdapter {
  if (!ctx || typeof ctx !== "object") {
    throw new Error("[AETERNA] creatorIrysStorage: context is required");
  }
  for (const key of [
    "wallet",
    "creatorIdentityId",
    "lifecycleId",
    "capsuleId",
    "storagePaymentId",
  ] as const) {
    if (!ctx[key]) {
      throw new Error(`[AETERNA] creatorIrysStorage: ctx.${key} is required`);
    }
  }

  return {
    name: "creator-irys",

    async upload(data: Uint8Array, _uploadToken: UploadToken) {
      // Upload-only (no fund): the storage payment is already
      // PAYMENT_VERIFIED. The original buffer is passed through
      // without cloning.
      const { dataTxId } = await uploadCreatorData(
        data,
        ctx.wallet,
        ctx.rpcUrl
      );

      await claimPublication(ctx, dataTxId, "vault");

      return { txId: assertStoragePointer(dataTxId) };
    },

    async uploadChunk(data: Uint8Array, chunkId: ChunkId, _uploadToken: UploadToken) {
      const { dataTxId } = await uploadCreatorData(
        data,
        ctx.wallet,
        ctx.rpcUrl
      );

      await claimPublication(ctx, dataTxId, "chunk", chunkId);

      return { txId: assertStoragePointer(dataTxId) };
    },

    // Read path is storage-provider independent (canonical gateways)
    // and does not involve any Executor payment/funding logic — the
    // existing read-only implementation is reused.
    download(pointer: StoragePointer) {
      return executorStorage.download(pointer);
    },
  };
}
