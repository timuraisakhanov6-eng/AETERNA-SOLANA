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

import type {
  StorageAdapter,
  StoragePointer,
  UploadToken,
  ContainerUploadOutcome,
} from "./storageAdapter";
import { assertStoragePointer } from "./storageAdapter";
import {
  uploadCreatorData,
  buildCreatorChunkingUploader,
  type CreatorIrysWallet,
} from "./creatorIrys";
import type { RuntimeStorage } from "@/lib/runtime/runtimeStorage";
import type { ChunkMetadata } from "@/types/vault";
import { uploadPreparedContainer } from "./uploadPreparedContainer";
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
 * Server 409 reasons that mean "the publication claim ALREADY holds for
 * exactly this txId / this capsule" — i.e. a benign idempotent replay.
 *
 * These are NOT success by default. A replay is only accepted when the
 * server's own response explicitly reports the ALREADY-claimed outcome
 * (`claimed:true` / `state`), which `classifyClaimFailure` checks. Anything
 * else — including a same-code response we cannot positively corroborate
 * — fails closed with the original error, because the client cache must
 * never be able to promote a publication to a verified state on its own.
 */
const BENIGN_REPLAY_409 = new Set([
  // Container: the coordinator holds the byte-equal container record.
  "ALREADY_CLAIMED",
  // Container: the capsule already has a container publication record.
  "CONTAINER_ALREADY_PUBLISHED",
  // Vault: an identical replay of the same lifecycle+tx is idempotent.
  "ALREADY_BOUND",
]);

/**
 * Server 409 reasons that are a GENUINE CONFLICT — the request is
 * coherent but the authoritative state forbids it. These must NEVER be
 * treated as success; the caller fails closed and the seal is retried
 * only after the conflict is resolved server-side.
 *
 * Enumerated from `functions/api/publication/claim.ts` and
 * `functions/lib/containerPublicationClaim.ts`:
 *   LIFECYCLE_NOT_RESERVED          — no lifecycle record for this identity
 *   CREDIT_NOT_CONSUMING            — lifecycle is not in CONSUMING state
 *   IDENTITY_MISMATCH               — lifecycle belongs to another creator
 *   CAPSULE_MISMATCH                — lifecycle is bound to another capsule
 *   STORAGE_PAYMENT_NOT_VERIFIED    — payment record missing / not verified
 *   STORAGE_PAYMENT_BINDING_MISMATCH— payment bound to other identity/lifecycle/capsule
 *   TX_ALREADY_CLAIMED              — this txId is already spent on another capsule
 *   PUBLICATION_NOT_CONFIRMED       — Irys node does not yet confirm the tx
 *   PUBLICATION_ALREADY_BOUND       — lifecycle already claimed a DIFFERENT tx
 */
const CONFLICT_409 = new Set([
  "LIFECYCLE_NOT_RESERVED",
  "CREDIT_NOT_CONSUMING",
  "IDENTITY_MISMATCH",
  "CAPSULE_MISMATCH",
  "STORAGE_PAYMENT_NOT_VERIFIED",
  "STORAGE_PAYMENT_BINDING_MISMATCH",
  "TX_ALREADY_CLAIMED",
  "PUBLICATION_NOT_CONFIRMED",
  "PUBLICATION_ALREADY_BOUND",
]);

/**
 * Classification of a server claim failure. `replay` is the ONLY outcome
 * that callers may treat as a completed claim without re-issuing it;
 * everything else propagates as a failure (fail closed).
 */
type ClaimFailureClass = "replay" | "conflict" | "unknown";

/**
 * Classifies a parsed claim error body. A benign replay is recognised
 * ONLY when the server positively reports the already-claimed outcome
 * (`claimed === true`, or a terminal `state` of PENDING/VERIFIED). A bare
 * 409 code that merely happens to match the benign set is NOT enough:
 * without corroboration it degrades to "unknown" and fails closed.
 */
function classifyClaimFailure(body: ClaimResponse | null): ClaimFailureClass {
  const code = body?.error;
  if (typeof code !== "string") return "unknown";

  if (BENIGN_REPLAY_409.has(code)) {
    const corroborated =
      body?.claimed === true ||
      body?.state === "PENDING" ||
      body?.state === "VERIFIED";
    return corroborated ? "replay" : "unknown";
  }

  if (CONFLICT_409.has(code)) return "conflict";

  return "unknown";
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

/**
 * Issues `POST /api/publication/claim` for one txId.
 *
 * Returns `true` when the claim is established OR is a corroborated
 * idempotent replay; throws otherwise (fail closed). The client NEVER
 * derives "published" from this call — the returned boolean only means
 * "the claim request was accepted or was already satisfied", which lets
 * the orchestrator proceed to the authoritative `/api/publication/verify`.
 */
async function claimPublication(
  ctx: CreatorIrysStorageContext,
  txId: string,
  kind: "vault" | "container",
  container?: { readonly chunkIds: readonly string[]; readonly layoutDigest: string }
): Promise<boolean> {
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
        ...(container !== undefined
          ? { chunkIds: [...container.chunkIds], layoutDigest: container.layoutDigest }
          : {}),
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { error?: string; reason?: string; claimed?: unknown; state?: unknown }
      | null;

    const detail = body?.error ?? body?.reason ?? `HTTP_${res.status}`;

    /**
     * 409 handling — deliberately conservative.
     *
     * A 409 is NEVER accepted as success merely because the code looks
     * like a replay. `classifyClaimFailure` requires positive
     * corroboration for a replay; a genuine conflict (or an
     * unrecognised / uncorroborated 409) throws and the seal fails
     * closed. Server authority is untouched: publication VERIFIED can
     * only ever come from `/api/publication/verify`.
     */
    if (res.status === 409) {
      const parsed = (body ?? null) as ClaimResponse | null;
      if (classifyClaimFailure(parsed) === "replay") {
        // Corroborated idempotent replay: the claim already holds for this
        // exact txId. Proceed to the authoritative verify step.
        return true;
      }
    }

    throw new Error(`[AETERNA] creatorIrys: publication claim failed: ${detail}`);
  }

  const json = (await res.json().catch(() => null)) as ClaimResponse | null;
  if (!json || json.ok !== true) {
    throw new Error("[AETERNA] creatorIrys: publication claim malformed response");
  }
  return true;
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

    /**
     * Canonical Container V1 — ONE container DataItem for the whole media
     * payload.
     *
     * The SAME wallet, the SAME Irys builder and the SAME claim boundary as
     * `uploadChunk`; the only difference is that the Stage 3 writer streams
     * every encrypted chunk into ONE DataItem instead of N separate ones, so
     * there is exactly ONE creator signature for it.
     *
     * UPLOAD-ONLY: this method creates the DataItem and returns its
     * outcome. It does NOT claim the publication. The orchestrator caches
     * the outcome and only then calls `claimContainerUpload`, so a later
     * claim failure can never discard (and therefore never re-sign) an
     * already-created container DataItem.
     */
    async uploadContainer(
      runtime: RuntimeStorage,
      chunkMetadata: readonly ChunkMetadata[],
      _uploadToken: UploadToken
    ): Promise<ContainerUploadOutcome> {
      const uploader = await buildCreatorChunkingUploader(
        ctx.wallet,
        ctx.rpcUrl
      );

      // No claim injected: the production seal path owns the ordering and
      // issues the claim AFTER caching the outcome.
      return uploadPreparedContainer(runtime, chunkMetadata, uploader);
    },

    /**
     * Issues the container publication claim for an ALREADY-CREATED
     * container DataItem (fresh or reused from the retry cache).
     *
     * Idempotent server-side: a corroborated already-claimed replay is
     * accepted; a genuine conflict (or an uncorroborated 409) throws and
     * the seal fails closed. Server publication authority is unchanged.
     */
    async claimContainerUpload(
      outcome: ContainerUploadOutcome,
      _uploadToken: UploadToken
    ): Promise<void> {
      await claimPublication(ctx, outcome.containerTxId, "container", {
        chunkIds: outcome.chunkIds,
        layoutDigest: outcome.layoutDigest,
      });
    },

    // Read path is storage-provider independent (canonical gateways)
    // and does not involve any Executor payment/funding logic — the
    // existing read-only implementation is reused.
    download(pointer: StoragePointer) {
      return executorStorage.download(pointer);
    },
  };
}
