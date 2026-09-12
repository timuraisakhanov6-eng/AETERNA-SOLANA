import { useState, useRef, useEffect, useCallback } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Link, useNavigate } from "react-router-dom";
import { ChevronLeft, Lock, Loader2 } from "lucide-react";
import { useCapsule } from "../../context/CapsuleContext";
import { useCreatorIdentity } from "@/context/CreatorRuntimeContext";
import { useAeternaWallet } from "@/context/AETERNAWalletContext";
import { useLandingPaymentGate } from "@/context/LandingPaymentGateContext";
import ActionMenu from "./ActionMenu";
import MediaCapture from "./MediaCapture";
import CapsuleInput from "./CapsuleInput";
import HorizontalCapsule from "./HorizontalCapsule";
import { DateTimePicker, normalizeOpenAt } from "./DateTimePicker";
import { Button } from "@/components/ui/button";
import { CapsuleItem } from "@/types/capsule";
import { preparePreparedCapsule } from "@/lib/capsule/preparePreparedCapsule";
import {
  CAPSULE_ID_REGEX,
  SECRET_REGEX,
  SALT_BASE_REGEX,
  SHA256_REGEX,
} from "@/lib/crypto/validators";
import type {
  CapsuleHoldState,
  MediaItem,
} from "@/types/capsule";
import type { OpenAtUtc } from "@/types/manifest";
import type { ChunkMetadata } from "@/types/vault";
import {
  fundCreatorPaidStorage,
  toCreatorIrysWallet,
} from "@/lib/storage/creatorIrys";

/* 🚨 КРИТИЧЕСКОЕ ПРАВИЛО:
  Импорты streamEncryptUpload и encryptChunk УДАЛЕНЫ.
  CapsuleBuilder готовит метаданные и резервирует lifecycle.
*/

const HEADER_HEIGHT = 64;
const MAX_DESCRIPTION = 140;

/**
 * PATCH-2F: shape of CreatorRuntimeContext.discoverAvailableCredit's
 * resolution, narrowed to the fields the entitlement-restore decision
 * may read.
 */
export interface DiscoveryOutcome {
  status: "available" | "none";
  creatorCreditId: string | null;
}

/**
 * PATCH-2F: a discovered AVAILABLE Creator Credit with an id restores
 * the paid workspace (servicePaymentState = "paid") AND closes the
 * app-root payment modal — no second-$1 path may stay visible under an
 * existing entitlement. Any other discovery outcome leaves both the
 * payment state and the modal untouched.
 *
 * Exported for the node-env regression test — kept in this file by design.
 */
export function hasRestorableEntitlement(discovery: DiscoveryOutcome): boolean {
  return (
    discovery.status === "available" &&
    typeof discovery.creatorCreditId === "string" &&
    discovery.creatorCreditId.length > 0
  );
}

/* ================= PATCH-2G DISCOVERY GUARD ================= */

export type DiscoveryOutcomeKind = "start" | "available" | "no-credit" | "error";

/**
 * PATCH-2G: whether a new entitlement-discovery attempt may start.
 * Requires a connected wallet with an account, a non-paid payment state,
 * no in-flight attempt — and no attempt already made for THIS account
 * (one attempt per account per component session; a no-credit/error
 * outcome must not loop into repeated signMessage requests for the same
 * wallet).
 */
export function shouldStartDiscovery(
  connected: boolean,
  account: string | null,
  current: ServicePaymentState,
  attemptedForAccount: string | null,
  inFlight: boolean
): boolean {
  if (!connected || !account) return false;
  if (current === "paid") return false;
  if (inFlight) return false;
  return attemptedForAccount !== account;
}

/**
 * PATCH-2G: service-payment state machine for the discovery lifecycle.
 * Returns the next state, or null when the outcome must not change the
 * current state:
 * - "start" arms the discovering phase only from "ready" (the pay click
 *   is blocked while discovering, so payment_in_progress never races it);
 * - "available" always restores "paid" (PATCH-2F semantics, idempotent);
 * - "no-credit"/"error" un-block the canonical $1 path by returning to
 *   "ready" — but only from "discovering", never clobbering a paid or
 *   payment-in-progress state.
 */
export function discoveryNextState(
  current: ServicePaymentState,
  outcome: DiscoveryOutcomeKind
): ServicePaymentState | null {
  if (outcome === "start") {
    return current === "ready" ? "discovering" : null;
  }
  if (outcome === "available") {
    return current === "paid" ? null : "paid";
  }
  return current === "discovering" ? "ready" : null;
}

/**
 * PATCH-2G: primary create-button disable matrix, extracted from the
 * inline ternary so the "discovering" lock (and the unchanged behavior
 * of every other state) is node-testable. Semantics are identical to
 * the previous inline expression for all inputs.
 */
export function createPrimaryDisabled(
  storageReviewPresent: boolean,
  state: ServicePaymentState,
  canSeal: boolean,
  sealPhaseIdle: boolean
): boolean {
  if (storageReviewPresent) return !sealPhaseIdle;
  if (state === "ready") return !canSeal;
  if (state === "paid") return !canSeal || !sealPhaseIdle;
  return true;
}

/**
 * Whether an app-root payment-modal close must reset the service-payment
 * state to "ready". "payment_in_progress" has exactly two exits: a
 * granted credit, or an abandoned modal close (X / Esc). Without the
 * reset, a creator who closes the $1 modal without paying permanently
 * disables the create button until a full page reload. A close that
 * accompanies a granted credit (in-session entitlement or a discovery
 * restore) must never reset the paid path.
 *
 * Exported for the node-env regression test — kept in this file by design.
 */
export function shouldResetPaymentOnModalClose(
  modalOpen: boolean,
  hasEntitlement: boolean,
  state: ServicePaymentState
): boolean {
  return !modalOpen && !hasEntitlement && state === "payment_in_progress";
}

type SealPhase = "idle" | "preparing";



/* ================= MIME NORMALIZATION ================= */

// Canonical mimeType guard — MAX_MIMETYPE_LENGTH = 255 per canonicalSerializeVaultV2.ts.
// Applied at every media entry point: file select, capture, and audio record.
function normalizeMimeType(raw: string | undefined): string {
  return typeof raw === "string" && raw.length <= 255
    ? raw
    : "application/octet-stream";
}


/* ================= SESSION STORAGE (recoverable continuation fallback; includes recipientSecret/creatorAuthority for Hold restoration, без vaultBytes) ================= */

// recipientSecret и creatorAuthority персистируются для Hold-восстановления после MetaMask interruption.
// По MASTER DOCUMENT §9 encrypted envelope живёт в памяти через preparedRef;
// sessionStorage используется только как recoverable continuation fallback.
type SessionCapsuleData = {
  billableSizeBytes: number;
  expectedAmount: number;
  openAt: number;
  description?: string;

  /**
   * Deterministic fingerprint of the preparation-defining inputs
   * (items + openAt) that produced this PREPARED identity. Used to
   * reuse the identity when inputs are unchanged and to require a NEW
   * capsule identity when they change — never regenerated under the
   * same capsuleId.
   */
  inputsFingerprint?: string;

  capsuleId: string;
  itemIds: readonly string[];

  /**
   * Recovery metadata.
   *
   * Used only to restore the PreparedCapsule
   * after browser interruption.
   *
   * Runtime ciphertext is stored exclusively
   * in IndexedDB.
   */

  encryptedVaultPointer: string;

  encryptedSizeBytes: number;

  vaultSha256: string;

  saltBase: string;

  recipientSecret: string;

  creatorAuthority: string;

  chunkMetadata: readonly ChunkMetadata[];

};




// Strict shape-check for the sessionStorage recovery payload. Mirrors
// CapsuleHold.tsx isValidSessionCapsuleData.
function isValidSessionCapsuleData(
  parsed: unknown
): parsed is SessionCapsuleData {

  if (!parsed || typeof parsed !== "object") return false;

  const p = parsed as Partial<SessionCapsuleData>;

  return (
    typeof p.encryptedVaultPointer === "string" &&
    p.encryptedVaultPointer.length > 0 &&

    Number.isSafeInteger(p.encryptedSizeBytes) &&
    (p.encryptedSizeBytes as number) > 0 &&

    typeof p.vaultSha256 === "string" &&
    SHA256_REGEX.test(p.vaultSha256) &&

    typeof p.saltBase === "string" &&
    SALT_BASE_REGEX.test(p.saltBase) &&

    typeof p.recipientSecret === "string" &&
    SECRET_REGEX.test(p.recipientSecret) &&

    typeof p.creatorAuthority === "string" &&
    SECRET_REGEX.test(p.creatorAuthority) &&

    typeof p.capsuleId === "string" &&
    CAPSULE_ID_REGEX.test(p.capsuleId) &&

    Number.isSafeInteger(p.openAt) &&

    Array.isArray(p.itemIds) &&
    p.itemIds.length > 0 &&

    Array.isArray(p.chunkMetadata) &&

    Number.isSafeInteger(p.billableSizeBytes) &&
    (p.billableSizeBytes as number) > 0
  );

}


/**
 * Deterministic fingerprint of the preparation-defining inputs.
 *
 * The vault key derives from (recipientSecret, saltBase, openAt,
 * capsuleId) and the Vault V2 plaintext from (items, ordering). Items are
 * ordered exactly like toVaultItems() / canonicalSerializeVaultV2() so an
 * identical content set always yields an identical fingerprint.
 */
function buildPreparationFingerprint(
  items: CapsuleItem[],
  openAt: number
): string {

  const ordered = [...items].sort((a, b) => {
    if (a.createdAt < b.createdAt) return -1;
    if (a.createdAt > b.createdAt) return 1;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  return JSON.stringify({
    openAt,
    items: ordered.map((item) =>
      item.type === "text"
        ? {
            type: item.type,
            id: item.id,
            text: item.text,
            createdAt: item.createdAt,
          }
        : {
            type: item.type,
            id: item.id,
            mediaType: item.mediaType,
            filename: item.filename,
            size: item.size,
            mimeType: item.mimeType,
            createdAt: item.createdAt,
          }
    ),
  });
}


function sameIdSet(
  a: readonly string[],
  b: readonly string[]
): boolean {

  if (a.length !== b.length) return false;

  const sa = [...a].sort();
  const sb = [...b].sort();

  return sa.every((id, i) => id === sb[i]);

}


/**
 * Restore a previously PREPARED capsule identity from sessionStorage.
 *
 * Returns:
 *   CapsuleHoldState — a record exists for the current capsuleId and its
 *                      inputs match → reuse (no regeneration)
 *   "stale"          — a record exists for the current capsuleId but the
 *                      inputs changed → a NEW capsule identity is required
 *   null             — no usable record → fresh preparation is permitted
 */
function restorePreparedFromSession(
  capsuleId: string,
  openAt: number,
  fingerprint: string,
  snapshotItems: CapsuleItem[]
): CapsuleHoldState | "stale" | null {

  let saved: string | null = null;

  try {
    saved = sessionStorage.getItem("aeterna-prepared-capsule");
  } catch {
    return null;
  }

  if (!saved) return null;

  let parsed: unknown;

  try {
    parsed = JSON.parse(saved);
  } catch {
    return null;
  }

  if (!isValidSessionCapsuleData(parsed)) return null;

  // A record for a different capsuleId belongs to another (or an
  // already-reset) capsule — ignore it; fresh preparation is permitted.
  if (parsed.capsuleId !== capsuleId) return null;

  const unchanged =
    typeof parsed.inputsFingerprint === "string"
      ? parsed.inputsFingerprint === fingerprint
      : (
          parsed.openAt === openAt &&
          sameIdSet(
            parsed.itemIds,
            snapshotItems.map((i) => i.id)
          )
        );

  if (!unchanged) return "stale";

  return {
    billableSizeBytes: parsed.billableSizeBytes,
    expectedAmount: parsed.expectedAmount,
    openAt: parsed.openAt as OpenAtUtc,
    ...(typeof parsed.description === "string"
      ? { description: parsed.description }
      : {}),
    itemIds: parsed.itemIds,
    creatorAuthority: parsed.creatorAuthority,
    prepared: {
      capsuleId: parsed.capsuleId,
      encryptedVaultPointer: parsed.encryptedVaultPointer,
      encryptedSizeBytes: parsed.encryptedSizeBytes,
      vaultSha256: parsed.vaultSha256,
      saltBase: parsed.saltBase,
      recipientSecret: parsed.recipientSecret,
      creatorAuthority: parsed.creatorAuthority,
      chunkMetadata: parsed.chunkMetadata,
    },
  };

}

/* ================= SERVICE PAYMENT TYPES ================= */

export type ServicePaymentState =
  | "ready"
  | "payment_in_progress"
  | "paid"
  | "discovering";

/**
 * Mirror of the server's grant/discovery result. Never an authority:
 * the Creator Credit record and the challenge-proof identity remain
 * server-side authority.
 */
interface ServicePaymentResult {
  creatorCreditId: string;
  creatorIdentityId: string;
  account: string;
  paymentIntentId?: string;
}

interface CapsuleBuilderProps {
  onOpenServicePayment: () => void;
}

/* ================= COMPONENT ================= */

export default function CapsuleBuilder({
  onOpenServicePayment,
}: CapsuleBuilderProps) {
  const navigate = useNavigate();

  const {
    items,
    capsuleId,
    addTextItem,
    addMediaItem,
    description,
    setDescription,
    unlockAt,
    setUnlockAt,
    getMediaFile,
    resetCapsule,
  } = useCapsule();

  const { creatorIdentityId } = useCreatorIdentity();
  const { entitlement, closeLandingPaymentModal, isPaymentModalOpen } =
    useLandingPaymentGate();
  const wallet = useAeternaWallet();
  const walletRef = useRef(wallet);
  useEffect(() => {
    walletRef.current = wallet;
  }, [wallet]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const [isActionMenuOpen, setIsActionMenuOpen] = useState(false);
  const [mediaCaptureMode, setMediaCaptureMode] =
    useState<"photo" | "video" | null>(null);

  const [isConfirmed, setIsConfirmed] = useState(false);
  const [sealPhase, setSealPhase] = useState<SealPhase>("idle");
  const [sealError, setSealError] = useState<string | null>(null);

  const preparedRef = useRef<CapsuleHoldState | null>(null);

  // Single-shot PREPARED guard: fingerprint of the preparation-defining
  // inputs that produced preparedRef.current. A PREPARED capsule identity
  // must never be regenerated under the same capsuleId.
  const preparedInputsRef = useRef<string | null>(null);

  // 🛡️ StrictMode / double-click guard
  const sealingRef = useRef(false);

  /* ================= SERVICE PAYMENT STATE ================= */

  const [servicePaymentState, setServicePaymentState] =
    useState<ServicePaymentState>("ready");
  const [servicePaymentResult, setServicePaymentResult] =
    useState<ServicePaymentResult | null>(null);
  // Phase B step 1 - storage review state: populated after the capsule
  // is prepared and the projection + canonical Irys quote are obtained.
  // While set, the primary action is the creator-paid storage step and
  // the real storage payment is NOT executed in this step.
  const [storageReview, setStorageReview] = useState<{
    storagePaymentId: string;
    expectedAmountAtomic: string;
    displayAmountUSDC: string;
    storageSizeBytes: number;
  } | null>(null);
  // Wallet mismatch during an ACTIVE lifecycle must never reset the
  // payment state (no second $1): identity spec forbids switching
  // wallet identity mid-lifecycle - same-wallet reconnect is required.
  const [walletMismatch, setWalletMismatch] = useState(false);
  // One lifecycleId per creation attempt - generated once and reused
  // by the prepared projection, the storage quote, and the reserve.
  const [pendingLifecycleId, setPendingLifecycleId] = useState<string | null>(null);
  const [storageReviewLoading, setStorageReviewLoading] = useState(false);
  const [servicePaymentError, setServicePaymentError] = useState<string | null>(null);

  /* ================= MEDIA ================= */

  const handleActionSelect = (action: "photo" | "video" | "file") => {
    if (action === "photo") setMediaCaptureMode("photo");
    if (action === "video") setMediaCaptureMode("video");
    if (action === "file") fileInputRef.current?.click();
  };

  // FIX 2: canonical schema — type: "media" + mediaType field
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;

    Array.from(e.target.files).forEach((file) => {
      const mediaType =
        file.type.startsWith("image/")
          ? "image"
          : file.type.startsWith("video/")
          ? "video"
          : file.type.startsWith("audio/")
          ? "audio"
          : "file";

      const mediaItem: MediaItem = {
        id: globalThis.crypto.randomUUID(),
        type: "media",
        mediaType,
        filename: file.name,
        size: file.size,
        mimeType: normalizeMimeType(file.type),
        createdAt: new Date().toISOString(),
      };

      addMediaItem(mediaItem, file);
    });

    e.target.value = "";
  };

  // FIX 3: canonical schema — type: "media" + mediaType for captured media
  // mimeType normalized via canonical guard (unified with file select path)
  const handleMediaCapture = (blob: Blob, filename: string) => {
    const file = new File([blob], filename, { type: blob.type });
    const mediaItem: MediaItem = {
      id: globalThis.crypto.randomUUID(),
      type: "media",
      mediaType:
        mediaCaptureMode === "photo"
          ? "image"
          : "video",
      filename,
      size: file.size,
      mimeType: normalizeMimeType(file.type),
      createdAt: new Date().toISOString(),
    };

    addMediaItem(mediaItem, file);
  };

  // FIX 4: canonical schema — type: "media" + mediaType: "audio"
  // mimeType normalized via canonical guard (unified with file select path)
  const handleAudioRecorded = (blob: Blob, filename: string) => {
    const file = new File([blob], filename, { type: blob.type });
    const mediaItem: MediaItem = {
      id: globalThis.crypto.randomUUID(),
      type: "media",
      mediaType: "audio",
      filename,
      size: file.size,
      mimeType: normalizeMimeType(file.type),
      createdAt: new Date().toISOString(),
    };

    addMediaItem(mediaItem, file);
  };

  /* ================= LIFECYCLE ================= */

  const reserveLifecycle = async (
    prepared: CapsuleHoldState,
    creatorCreditId: string,
    candidateLifecycleId: string,
  ) => {

    if (!creatorIdentityId) {
      throw new Error("Creator identity is required to reserve lifecycle.");
    }

    if (!creatorCreditId) {
      throw new Error("Creator credit is required to reserve lifecycle.");
    }

    const response = await fetch("/api/creator/reserve-lifecycle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        creatorIdentityId,
        creatorCreditId,
        capsuleId: prepared.prepared.capsuleId,
        lifecycleId: candidateLifecycleId,
      }),
    })

    const data = await response.json()
    if (!response.ok || !data?.ok) {
      throw new Error(data?.error || "LIFECYCLE_RESERVATION_FAILED")
    }

    return {
      ok: true,
      lifecycleId: data.lifecycleId ?? candidateLifecycleId,
      creatorCreditId,
    }
  }

  const handleReserveReady = async (result: { creatorCreditId: string; lifecycleId: string; storagePaymentId: string }) => {
    if (!preparedRef.current) return

    const prepared = preparedRef.current
    preparedRef.current = null

    try {
      const reserved = await reserveLifecycle(prepared, result.creatorCreditId, result.lifecycleId)
      const sessionData = {
        ...prepared,
        billableSizeBytes: prepared.billableSizeBytes,
        expectedAmount: prepared.expectedAmount,
        openAt: prepared.openAt,
        ...(typeof description === "string" ? { description } : {}),
        capsuleId: prepared.prepared.capsuleId,
        itemIds: prepared.itemIds,
        encryptedVaultPointer:
          prepared.prepared.encryptedVaultPointer,
        encryptedSizeBytes: prepared.prepared.encryptedSizeBytes,
        vaultSha256: prepared.prepared.vaultSha256,
        saltBase: prepared.prepared.saltBase,
        recipientSecret: prepared.prepared.recipientSecret,
        creatorAuthority: prepared.prepared.creatorAuthority,
        chunkMetadata: prepared.prepared.chunkMetadata,
        storagePaymentId: result.storagePaymentId,
      }

      try {
        sessionStorage.setItem(
          "aeterna-prepared-capsule",
          JSON.stringify(sessionData)
        )
      } catch {
        // sessionStorage write failure is non-fatal
      }

      setSealPhase("idle")

      navigate("/create/hold", {
        state: {
          holdState: structuredClone(prepared),
          correlationTransactionId: null,
          canonicalLifecycleId: reserved.lifecycleId,
          creatorIdentityId,
          storagePaymentId: result.storagePaymentId,
        },
      })
    } catch (err) {
      setSealError(
        err instanceof Error ? err.message : "Lifecycle reservation failed"
      )
      setSealPhase("idle")
    }
  }

  const remainingChars = MAX_DESCRIPTION - (description?.length ?? 0);
  const isPreparing = sealPhase === "preparing";
  const isBusy = isPreparing;

  const handleFirstCreateClick = () => {
    if (servicePaymentState !== "ready") return;
    setServicePaymentState("payment_in_progress");
    setServicePaymentError(null);
    onOpenServicePayment();
  };

  const handlePaymentCreditReady = useCallback(
    (result: ServicePaymentResult) => {
      setServicePaymentResult(result);
      setServicePaymentState("paid");
      setServicePaymentError(null);
    },
    [setServicePaymentResult, setServicePaymentState]
  );

  const handlePaymentCancel = useCallback(() => {
    setServicePaymentState("ready");
    setServicePaymentError(null);
  }, []);

  // An abandoned payment-modal close (X / Esc, no credit granted) is the
  // non-payment exit from "payment_in_progress"; without this reset the
  // create button stays disabled until a full page reload. A close that
  // accompanies a granted credit never resets (see
  // shouldResetPaymentOnModalClose): the entitlement effect above owns
  // that transition to "paid".
  useEffect(() => {
    if (
      shouldResetPaymentOnModalClose(
        isPaymentModalOpen,
        Boolean(entitlement?.creatorCreditId),
        servicePaymentState
      )
    ) {
      handlePaymentCancel();
    }
  }, [
    isPaymentModalOpen,
    entitlement,
    servicePaymentState,
    handlePaymentCancel,
  ]);

  /* ================= ENTITLEMENT RESTORE (PATCH-2J) ================= */

  // PATCH-2J: sign-based credit discovery (issue-challenge → signMessage
  // → credit-status) moved into the headless payment controller, which
  // runs credit-status with the ONE identity proof BEFORE verify-proof
  // consumes the server-side challenge. Discovery outcomes reach this
  // component as server-authenticated entitlement facts through the
  // payment gate (LandingPaymentGateContext.entitlement, set from the
  // controller's onCreditDiscovered / onCreditReady) — never as raw
  // proof material. The PATCH-2G state machine below
  // (discoveryNextState / createPrimaryDisabled / one-attempt-per-account
  // attempted-ref semantics, now owned by the controller) and the
  // PATCH-2I modal-close reset are unchanged; hasRestorableEntitlement
  // remains the restore predicate. No auto-sign on mount: the single
  // signature is requested only by an explicit action inside the payment
  // modal.

  /**
   * In-session: a successful $1 payment grants the Credit inside the
   * app-root payment modal; the gate retains the FULL server result
   * (previously dropped), so the prepared /create workspace sees the
   * paid entitlement immediately — without another signature or
   * another $1. PATCH-2J: the same channel now also carries a
   * discovery-restored AVAILABLE Credit (controller onCreditDiscovered),
   * so this effect remains the single PATCH-2F restore point.
   */
  useEffect(() => {
    if (!entitlement?.creatorCreditId) return;
    if (!entitlement.creatorIdentityId || !entitlement.account) return;
    if (servicePaymentState === "paid") return;

    const result: ServicePaymentResult = {
      creatorCreditId: entitlement.creatorCreditId,
      creatorIdentityId: entitlement.creatorIdentityId,
      account: entitlement.account,
    };
    if (entitlement.paymentIntentId !== undefined) {
      result.paymentIntentId = entitlement.paymentIntentId;
    }
    setServicePaymentResult(result);
    setServicePaymentState("paid");
    // PATCH-2F: mirror the in-session entitlement restore with the same
    // gate close as discovery, so no payment modal stays mounted once a
    // Credit is known.
    closeLandingPaymentModal();
  }, [entitlement, servicePaymentState]);

  const walletMatch = useCallback(() => {
    const account = walletRef.current?.account;
    const accountValid =
      servicePaymentResult === null ||
      servicePaymentResult.account === account;

    const identityValid =
      servicePaymentResult === null ||
      servicePaymentResult.creatorIdentityId === creatorIdentityId;

    return Boolean(accountValid && identityValid);
  }, [creatorIdentityId, servicePaymentResult]);

  // Phase B — single storage-review entry point for ALL creation
  // paths (fresh prepare, same-fingerprint retry, session restore).
  // Every path MUST pass through this + handleConfirmStoragePayment:
  // direct reserve without PAYMENT_VERIFIED is forbidden.
  const enterStorageReviewForPrepared = async () => {
    const preparedState = preparedRef.current;
    if (!preparedState) {
      setSealError("HOLD_STATE_MISSING");
      return;
    }

    try {
      setStorageReviewLoading(true);
      const lifecycleIdForAttempt =
        pendingLifecycleId ?? `lifecycle-${capsuleId}-${Date.now()}`;
      setPendingLifecycleId(lifecycleIdForAttempt);

      const preparedRes = await fetch("/api/capsule/prepared", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          creatorIdentityId,
          lifecycleId: lifecycleIdForAttempt,
          capsuleId: preparedState.prepared.capsuleId,
          encryptedSizeBytes: preparedState.prepared.encryptedSizeBytes,
          vaultSha256: preparedState.prepared.vaultSha256,
          saltBase: preparedState.prepared.saltBase,
          encryptedVaultPointer: preparedState.prepared.encryptedVaultPointer,
          chunkMetadata: preparedState.prepared.chunkMetadata,
        }),
      });
      const preparedData = await preparedRes.json().catch(() => null);
      if (!preparedRes.ok || !preparedData?.ok) {
        throw new Error(preparedData?.error || "PREPARED_PROJECTION_FAILED");
      }

      const quoteRes = await fetch("/api/storage/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          creatorIdentityId,
          lifecycleId: lifecycleIdForAttempt,
          capsuleId: preparedState.prepared.capsuleId,
          preparedProjectionId: preparedData.preparedProjection.preparedProjectionId,
        }),
      });
      const quoteData = await quoteRes.json().catch(() => null);
      if (!quoteRes.ok || !quoteData?.ok) {
        throw new Error(quoteData?.error || "STORAGE_QUOTE_FAILED");
      }

      const quote = quoteData.storagePaymentId ? quoteData : quoteData.quote;
      setStorageReview({
        storagePaymentId: String(quote.storagePaymentId ?? ""),
        expectedAmountAtomic: String(quote.expectedAmountAtomic ?? ""),
        displayAmountUSDC: String(quote.displayAmountUSDC ?? ""),
        storageSizeBytes: preparedState.prepared.encryptedSizeBytes,
      });
      setSealPhase("idle");
      sealingRef.current = false;
      return; // remain on /create in the storage review state
    } catch (reviewErr) {
      setSealPhase("idle");
      sealingRef.current = false;
      setSealError(
        reviewErr instanceof Error ? reviewErr.message : "Storage quote failed"
      );
      return;
    }
  };

  const handleFinalCreateClick = async () => {
    if (servicePaymentState !== "paid" || !servicePaymentResult) return;
    if (sealPhase !== "idle" || sealingRef.current) return;
    if (!walletMatch() || walletMismatch) {
      // ACTIVE lifecycle: keep the paid credit and lifecycle binding.
      // A second $1 would create a duplicate entitlement.
      setWalletMismatch(true);
      setServicePaymentError(
        "Wallet changed during this capsule. Reconnect the same wallet used for the $1 payment to continue."
      );
      return;
    }
    setWalletMismatch(false);

    sealingRef.current = true;
    setSealError(null);
    setSealPhase("preparing");

    try {
      const snapshotItems = [...items];
      const fingerprint = buildPreparationFingerprint(
        snapshotItems,
        unlockAt
      );


      if (preparedRef.current) {
        if (preparedInputsRef.current === fingerprint) {
          preparedRef.current = {
            ...preparedRef.current,
            description: description ?? "",
          };
          setSealPhase("idle");
          // Retry: same prepared capsule → storage review + payment
          // gate (direct reserve without PAYMENT_VERIFIED is forbidden).
          void enterStorageReviewForPrepared();
          return;
        }

        resetCapsule();
        preparedRef.current = null;
        preparedInputsRef.current = null;

        try {
          sessionStorage.removeItem("aeterna-prepared-capsule");
        } catch {
          // non-fatal
        }

        setSealPhase("idle");
        setSealError(
          "Capsule contents changed after preparation. " +
          "A new capsule has been started — please rebuild it and continue."
        );
        return;
      }

      const restored = restorePreparedFromSession(
        capsuleId,
        unlockAt,
        fingerprint,
        snapshotItems
      );

      if (restored !== null) {
        if (restored === "stale") {
          resetCapsule();
          try {
            sessionStorage.removeItem("aeterna-prepared-capsule");
          } catch {
            // non-fatal
          }
          setSealPhase("idle");
          setSealError(
            "Capsule contents changed after preparation. " +
            "A new capsule has been started — please rebuild it and continue."
          );
          return;
        }

        preparedRef.current = restored;
        preparedInputsRef.current = fingerprint;
        setSealPhase("idle");
        // Restored session: same prepared capsule/lifecycle continuity
        // → storage review + payment gate (direct reserve forbidden).
        void enterStorageReviewForPrepared();
        return;
      }

      const preparedCapsule = await preparePreparedCapsule({
        capsuleId,
        items: snapshotItems,
        getMediaFile,
        openAt: unlockAt,
      });

      preparedRef.current = {
        prepared: preparedCapsule,
        billableSizeBytes: 0,
        expectedAmount: 1.0,
        openAt: unlockAt as OpenAtUtc,
        description: description ?? "",
        itemIds: snapshotItems.map((i) => i.id),
        creatorAuthority: preparedCapsule.creatorAuthority,
      };

      // Phase B - enter the shared storage review flow (projection +
      // canonical Irys quote), then wait for the creator to confirm.
      await enterStorageReviewForPrepared();
      return;
    } catch (err) {
      preparedRef.current = null;
      setSealPhase("idle");
      setSealError(
        err instanceof Error ? err.message : "Capsule creation failed"
      );
    } finally {
      sealingRef.current = false;
    }
  };

  // STATE 3 -> STATE 4: creator confirmed the Irys storage step.
  // The real storage payment execution belongs to Phase B; this keeps
  // the lifecycle binding and continues reserve + hold as today.
  const handleConfirmStoragePayment = async () => {
    if (servicePaymentState !== "paid" || !servicePaymentResult) return;
    if (!storageReview || !preparedRef.current) return;
    if (sealPhase !== "idle" || sealingRef.current) return;
    if (!walletMatch()) {
      setWalletMismatch(true);
      setServicePaymentError(
        "Wallet changed during this capsule. Reconnect the same wallet used for the $1 payment to continue."
      );
      return;
    }
    if (!pendingLifecycleId) {
      setSealError("Lifecycle is not initialised for this creation attempt.");
      return;
    }
    setWalletMismatch(false);

    sealingRef.current = true;
    setSealError(null);
    setSealPhase("preparing");

    try {
      // Phase B - creator pays Irys directly (FUND-ONLY): the wallet
      // signs the USDC funding transfer with the EXACT atomic amount
      // from the server quote. Upload/publication is Phase C/D.
      const creatorWallet = toCreatorIrysWallet(walletRef.current as never);
      const { fundingSignature } = await fundCreatorPaidStorage(
        storageReview.expectedAmountAtomic,
        creatorWallet
      );

      const verifyRes = await fetch("/api/storage/verify-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storagePaymentId: storageReview.storagePaymentId,
          transactionSignature: fundingSignature,
        }),
      });
      const verifyData = await verifyRes.json().catch(() => null);
      if (!verifyRes.ok || !verifyData?.ok) {
        const reason =
          (verifyData?.reason as string | undefined) ??
          (verifyData?.error as string | undefined) ??
          "STORAGE_PAYMENT_NOT_VERIFIED";
        // Stay in the storage payment/review state: the paid $1
        // entitlement, lifecycle binding, quote and wallet binding are
        // preserved so the creator can retry the same storage payment.
        setSealPhase("idle");
        setSealError(`Irys storage payment not verified: ${reason}`);
        sealingRef.current = false;
        return;
      }

      await handleReserveReady({
        creatorCreditId: servicePaymentResult.creatorCreditId,
        lifecycleId: pendingLifecycleId,
        storagePaymentId: storageReview.storagePaymentId,
      });
    } catch (err) {
      // Failure path: remain in the storage payment/review state with
      // paid entitlement, lifecycle and quote binding preserved.
      setSealPhase("idle");
      setSealError(
        err instanceof Error ? err.message : "Storage payment failed"
      );
      sealingRef.current = false;
      return;
    } finally {
      sealingRef.current = false;
    }
  };

  const canSeal =
    items.length > 0 &&
    typeof unlockAt === "number" &&
    isConfirmed &&
    sealPhase === "idle";

  // PATCH-2G: disable matrix extracted to createPrimaryDisabled so the
  // "discovering" lock is node-testable; behavior for every pre-existing
  // state is unchanged.
  const isCreateDisabled = createPrimaryDisabled(
    storageReview !== null,
    servicePaymentState,
    canSeal,
    sealPhase === "idle"
  );

  const primaryButtonLabel =
    storageReview !== null
      ? `Pay $${storageReview.displayAmountUSDC} Storage`
      : servicePaymentState === "paid"
      ? "Create Capsule"
      : servicePaymentState === "discovering"
      ? "Checking for existing credit..."
      : "Pay $1 & Create Capsule";

  return (
    <div className="min-h-screen bg-background relative">

      <header
        className="fixed top-0 left-0 right-0 z-50 border-b border-border bg-background/90 backdrop-blur"
        style={{ height: HEADER_HEIGHT }}
      >
        <div className="relative h-full px-4 sm:px-5 flex items-center justify-center gap-2">
          <Link
            to="/"
            className="absolute left-5 flex items-center gap-2 opacity-80 hover:opacity-100"
          >
            <ChevronLeft size={20} />
            Back
          </Link>

          <Lock size={18} className="text-orange-400 opacity-90" />
          <span className="font-display text-lg tracking-wide uppercase">
            New Capsule
          </span>
        </div>
      </header>

      <main
        className="mx-auto px-5 pb-[160px] sm:pb-[200px] lg:pb-[240px]"
        style={{ paddingTop: HEADER_HEIGHT + 32 }}
      >
        <div className="mx-auto w-full max-w-[720px] space-y-8">

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium tracking-widest text-muted-foreground uppercase">
                Capsule Description
              </p>
              <span className="text-xs text-muted-foreground/70">
                {remainingChars} chars left
              </span>
            </div>

            <textarea
              value={description}
              onChange={(e) =>
                setDescription(e.target.value.slice(0, MAX_DESCRIPTION))
              }
              disabled={isBusy}
              placeholder="Describe your capsule (optional)"
              className="w-full resize-none rounded-lg bg-card border px-4 py-3 min-h-[72px] sm:min-h-[96px] focus:ring-1 focus:ring-orange-500/50 outline-none transition-all"
              rows={2}
            />
          </section>

          <HorizontalCapsule
            items={items}
            isSealed={false}
            maxFiles={100}
            capacityBytes={100 * 1024}
            onViewContents={() =>
              navigate("/capsule/preview", {
                state: { items, description, unlockAt },
              })
            }
          />

          <DateTimePicker
            date={unlockAt ? new Date(unlockAt) : null}
            disabled={isBusy}
            onDateChange={(date) => {
              setUnlockAt(normalizeOpenAt(date));
            }}
          />

          <section className="rounded-xl border bg-card/30 backdrop-blur-sm p-4 space-y-5 text-center">
            <div className="space-y-4">
              <label className="flex items-center justify-center gap-3 cursor-pointer group opacity-90 hover:opacity-100 transition">
                <Checkbox
                  id="protocol-confirm"
                  className="mt-0.5 shrink-0"
                  checked={isConfirmed}
                  disabled={isBusy}
                  onCheckedChange={(v) => setIsConfirmed(v === true)}
                />
                <span className="text-sm text-muted-foreground leading-snug max-w-[520px] mx-auto block group-hover:text-foreground transition-colors">
                  I accept the{" "}
                  <Link
                    to="/protocol"
                    className="underline underline-offset-4 text-orange-500"
                    translate="no"
                  >
                    Protocol Rules
                  </Link>{" "}
                  of{" "}
                  <span translate="no">AETERNA</span>
                </span>
              </label>

              {sealError && (
                <div className="p-3 rounded-md bg-red-500/10 border border-red-500/20 text-xs text-red-500 animate-in fade-in zoom-in-95">
                  {sealError}
                </div>
              )}

              {servicePaymentError && (
                <div className="p-3 rounded-md bg-red-500/10 border border-red-500/20 text-xs text-red-500 animate-in fade-in zoom-in-95">
                  {servicePaymentError}
                </div>
              )}
            </div>

            <div className="space-y-3">
              <Button
                disabled={isCreateDisabled || storageReviewLoading || Boolean(walletMismatch)}
                onClick={
                  storageReview !== null
                    ? handleConfirmStoragePayment
                    : servicePaymentState === "paid"
                    ? handleFinalCreateClick
                    : handleFirstCreateClick
                }
                className={[
                  "w-full h-auto min-h-14 whitespace-normal text-lg font-display tracking-widest transition-all active:scale-[0.98]",
                  isCreateDisabled
                    ? "bg-muted text-muted-foreground cursor-not-allowed"
                    : "bg-emerald-600 hover:bg-emerald-500 text-white",
                ].join(" ")}
              >
                {isPreparing ? (
                  <div className="flex items-center gap-2">
                    <Loader2 className="animate-spin" size={20} />
                    PREPARING VAULT...
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
              {storageReview !== null && (
            <section className="mx-auto w-full max-w-[720px] rounded-lg border border-border bg-card p-4 space-y-2">
              <p className="text-sm font-medium tracking-widest text-muted-foreground uppercase">
                Review capsule before storage payment
              </p>
              {typeof description === "string" && description.length > 0 && (
                <p className="text-sm">Title: {description}</p>
              )}
              {typeof unlockAt === "number" && (
                <p className="text-sm">
                  Unlock date: {new Date(unlockAt).toLocaleString()}
                </p>
              )}
              <p className="text-sm">
                Final storage size: {(storageReview.storageSizeBytes / 1024).toFixed(1)} KB
              </p>
              <p className="text-sm">
                Irys storage price: ${storageReview.displayAmountUSDC} USDC (set by Irys)
              </p>
              {walletMismatch && (
                <p className="text-sm text-destructive">
                  Reconnect the same wallet used for the $1 payment to continue.
                </p>
              )}
            </section>
          )}
                {primaryButtonLabel}
                  </div>
                )}
              </Button>
            </div>
          </section>
        </div>
      </main>

      {!isBusy && (
        <>
          <CapsuleInput
            onSendText={addTextItem}
            onOpenActions={() => setIsActionMenuOpen(true)}
            onAudioRecorded={handleAudioRecorded}
          />

          <ActionMenu
            isOpen={isActionMenuOpen}
            onClose={() => setIsActionMenuOpen(false)}
            onSelect={handleActionSelect}
          />

          <MediaCapture
            mode={mediaCaptureMode || "photo"}
            isOpen={mediaCaptureMode !== null}
            onClose={() => setMediaCaptureMode(null)}
            onCapture={handleMediaCapture}
          />

          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={handleFileSelect}
          />
        </>
      )}
    </div>
  );
}