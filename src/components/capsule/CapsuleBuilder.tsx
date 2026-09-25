import { useState, useRef, useEffect, useCallback, useReducer, useSyncExternalStore } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Link, useNavigate } from "react-router-dom";
import { ChevronLeft, Lock, Loader2 } from "lucide-react";
import { useCapsule } from "../../context/CapsuleContext";
import { useCreatorIdentity } from "@/context/CreatorRuntimeContext";
import { useAeternaWallet } from "@/context/AETERNAWalletContext";
import { useLandingPaymentGate } from "@/context/LandingPaymentGateContext";
import {
  createServicePaymentController,
} from "@/lib/payment/servicePaymentController";
import type { ServicePaymentController } from "@/lib/payment/servicePaymentController";
import {
  ensureStorageFundingSignature,
  verifyStoragePaymentWithRetry,
} from "@/components/capsule/storageVerificationRetry";
import {
  PHANTOM_INSTALL_URL,
  PHANTOM_MOBILE_BODY,
  PHANTOM_MOBILE_OPEN_LABEL,
  PHANTOM_MOBILE_TITLE,
  PHANTOM_REQUIRED_BODY,
  PHANTOM_REQUIRED_TITLE,
  isMobileBrowser,
  isPhantomAvailable,
  openAeternaInPhantomMobile,
} from "@/lib/wallet/phantomProvider";
import {
  INITIAL_CREATE_FLOW_STATE,
  reduceCreateFlow,
} from "@/components/capsule/capsuleCreateFlow";
import ActionMenu from "./ActionMenu";
import FinalCapsuleReviewModal from "./FinalCapsuleReviewModal";
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

/* ================= PATCH-2K-C WALLET FLOW EVENT ================= */

/**
 * PATCH-2K-C: single decision point for wallet-driven create-flow events.
 * Semantics (pinned by CapsuleBuilderDiscoveryGuard.test.ts):
 * - a disconnected wallet emits DISCONNECTED only when a real account was
 *   previously connected. A wallet-object re-emission while already
 *   disconnected (previous=null) and the initial mount run
 *   (previous=undefined) emit null, so a repeated DISCONNECTED can no
 *   longer reset discovering/needs-payment to ready;
 * - ACCOUNT_CHANGED keeps the existing semantics: a known account
 *   replaced by a different known account;
 * - the caller keeps its own previous!==undefined first-mount guard, so
 *   a mount run dispatches nothing even for an already-connected wallet.
 *
 * Exported for the node-env regression test — kept in this file by design.
 */
export function walletFlowEvent(
  previous: string | null | undefined,
  connected: boolean,
  account: string | null
): "DISCONNECTED" | "ACCOUNT_CHANGED" | null {
  if (!connected) {
    return previous !== null && previous !== undefined
      ? "DISCONNECTED"
      : null;
  }

  if (previous !== account) {
    if (previous !== null && account !== null) {
      return "ACCOUNT_CHANGED";
    }
  }

  return null;
}

type SealPhase = "idle" | "preparing";

/* ================= STALE QUOTE HARDENING (PATCH-2L) ================= */

/**
 * Single decision point for dropping the storage review after a failed
 * verify-payment. An EXPIRED quote can never be verified, so funding it
 * again would only pay twice: the review is dropped and the next
 * explicit Create Capsule re-quotes through the existing
 * enterStorageReviewForPrepared path. Every other failure reason
 * preserves the review state so the same storage payment can be retried.
 *
 * Exported for the regression test — kept in this file by design
 * (same pattern as walletFlowEvent).
 */
export function shouldClearStorageReviewOnVerifyFailure(
  reason: string
): boolean {
  return reason === "STORAGE_QUOTE_EXPIRED";
}

/* ================= PATCH-2K-B GATE ERROR UX ================= */

// Short, non-technical gate error text for the inline status line. The
// raw controller error code stays in state (support/debug) and is never
// rendered.
function describeGateError(raw: string | null): string {
  if (!raw) return "Something went wrong. Please try again.";
  const code = raw.toUpperCase();
  if (code.includes("SIGNATURE") || code.includes("CHALLENGE")) {
    return "Wallet verification was not completed. Please try again.";
  }
  if (code.includes("QUOTE")) {
    return "Payment setup failed. Please try again.";
  }
  if (code.includes("PAYMENT") || code.includes("VERIF") || code.includes("GRANT")) {
    return "Payment could not be verified. No entitlement was granted. Please try again.";
  }
  if (code.includes("WALLET") || code.includes("ACCOUNT")) {
    return "Wallet connection issue. Please try again.";
  }
  return "Something went wrong. Please try again.";
}



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

/* ================= COMPONENT ================= */

export default function CapsuleBuilder() {
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
  const { entitlement, reportCreditDiscovery, reportCreditReady } =
    useLandingPaymentGate();
  const wallet = useAeternaWallet();
  const walletRef = useRef(wallet);
  useEffect(() => {
    walletRef.current = wallet;
  }, [wallet]);

  /* ================= INLINE SERVICE PAYMENT GATE (PATCH-2K-B) ================= */

  // Mounted-lifetime probe for the controller's wallet-connection wait
  // loop (PATCH-2I recovery semantics: an abandoned wait must resolve).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Single headless service-payment controller instance (PATCH-2H): the
  // inline gate drives the same canonical flow the payment modal used to
  // render. The controller must not calculate price, declare success
  // locally, write Credit state, or treat frontend state as authority.
  const servicePaymentRef = useRef<ServicePaymentController | null>(null);
  if (!servicePaymentRef.current) {
    servicePaymentRef.current = createServicePaymentController({
      isCancelled: () => !mountedRef.current,
    });
  }
  const servicePayment = servicePaymentRef.current;

  const servicePaymentRuntime = useSyncExternalStore(
    servicePayment.subscribe,
    servicePayment.getState,
    servicePayment.getState
  );

  // PATCH-2K-A create-flow state machine: the ONLY source of which gate
  // step the user is in. Server facts enter exclusively as reducer
  // events; the reducer knows nothing about wallets, HTTP, KV or prices.
  const [createFlowState, dispatchCreateFlow] = useReducer(
    reduceCreateFlow,
    INITIAL_CREATE_FLOW_STATE
  );

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

  /**
   * 🛡️ Funding-signature ledger (keyed by storagePaymentId).
   *
   * Once the creator's wallet has sent the Irys funding transfer for a given
   * storagePaymentId, that signature is remembered here — and persisted to
   * sessionStorage — so a re-entry into the review flow (including after a
   * failed verification, or after a reload of this tab) verifies the EXISTING
   * payment instead of funding a second time.
   */
  const storageFundingRef = useRef<{
    storagePaymentId: string;
    fundingSignature: string;
  } | null>(null);

  /* ================= SERVICE PAYMENT STATE ================= */

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
  // Model 01 wallet policy: Phantom only. True when Create Capsule was
  // clicked without a Phantom provider present. UX gate only.
  const [phantomRequired, setPhantomRequired] = useState(false);
  // Model 01 mobile: true when Create Capsule was clicked on a mobile
  // browser without an injected Phantom. Phantom connects through its
  // in-app browser on mobile, so the user is offered an explicit
  // "Open in Phantom" action instead of the desktop install notice.
  const [phantomMobileRequired, setPhantomMobileRequired] = useState(false);
  // Final Capsule Review dialog visibility. storageReview (the canonical
  // quote record) is deliberately NOT cleared on close: the dialog can be
  // re-opened without a second quote while the quote stays valid.
  const [isReviewOpen, setIsReviewOpen] = useState(false);

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

  /* ================= INLINE GATE ACTIONS (PATCH-2K-B) ================= */

  // Controller → gate/reducer: server-verified facts enter the state
  // machine as events only. Entitlement facts go to the gate mirror
  // (authoritative in-session signal); the raw proof never leaves the
  // controller.
  useEffect(() => {
    servicePayment.setCallbacks({
      onCreditDiscovered: (result) => {
        reportCreditDiscovery(result);
        dispatchCreateFlow(
          result.status === "available"
            ? "DISCOVERY_AVAILABLE"
            : "DISCOVERY_NONE"
        );
      },
      onCreditReady: (result) => {
        reportCreditReady(result);
        dispatchCreateFlow("PAYMENT_CONFIRMED");
      },
    });
  }, [servicePayment, reportCreditDiscovery, reportCreditReady]);

  useEffect(() => {
    servicePayment.setParams({
      creatorIdentityId: null,
      protocolAccepted: true,
      stopAfterCredit: true,
    });
  }, [servicePayment]);

  useEffect(() => {
    servicePayment.syncWallet(wallet);
  }, [servicePayment, wallet]);

  // Wallet → reducer: account switch / disconnect invalidate the flow
  // (PATCH-2J account-bound proof semantics). The first mount emits
  // nothing; reconnecting the SAME account after a disconnect re-restores
  // the in-session entitlement below. PATCH-2K-C: the dispatch decision
  // is walletFlowEvent — a wallet-object re-emission while already
  // disconnected emits no event, so discovering/needs-payment are no
  // longer reset to ready by a repeated DISCONNECTED.
  const previousWalletAccountRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const previous = previousWalletAccountRef.current;
    if (previous !== undefined) {
      const ev = walletFlowEvent(previous, wallet.connected, wallet.account);
      if (ev) {
        dispatchCreateFlow(ev);
      }
    }
    previousWalletAccountRef.current = wallet.connected ? wallet.account : null;
  }, [wallet]);

  // Controller error → reducer. A payment-phase failure (wallet rejection
  // / server verification) returns to the $1 confirm step with the
  // discovery answer preserved (PATCH-2I: no credit lost, no re-discovery,
  // no second signature); identity-phase failures surface the retry state.
  // The reducer no-ops ERROR outside busy states, so ready/paid are never
  // clobbered.
  useEffect(() => {
    if (servicePaymentRuntime.phase !== "error") return;
    dispatchCreateFlow(
      createFlowState === "payment-in-progress"
        ? "PAYMENT_ABORTED"
        : "ERROR"
    );
  }, [servicePaymentRuntime.phase, createFlowState]);

  // First explicit Create Capsule action: starts identity verification and
  // credit discovery — never a quote, never a payment (PATCH-2K-A: payment
  // is reachable only after an authoritative NO-CREDIT discovery).
  const handleFirstCreateClick = () => {
    if (createFlowState !== "ready" && createFlowState !== "error") return;

    // Model 01 wallet policy: Phantom only
    // (docs/canonical/AETERNA_WALLET_PROVIDER_SELECTION_SPEC.md §4.1).
    // Stop BEFORE connect, SIWS, quote, the $1 payment, Creator Credit or
    // any Irys action when Phantom is not available.
    // UX gate only — the server remains the sole identity/payment authority.
    if (!isPhantomAvailable()) {
      setServicePaymentError(null);

      // Model 01 mobile: Phantom does not inject into mobile Safari/Chrome.
      // It connects through its own in-app browser, so offer the official
      // Phantom deep link instead of the desktop install notice. Nothing is
      // connected, quoted or paid here.
      if (isMobileBrowser()) {
        setPhantomMobileRequired(true);
        setPhantomRequired(false);
        return;
      }

      setPhantomMobileRequired(false);
      setPhantomRequired(true);
      return;
    }

    setPhantomMobileRequired(false);
    setPhantomRequired(false);
    setServicePaymentError(null);
    dispatchCreateFlow("CREATE_CLICKED");

    const runtime = servicePayment.getState();
    if (
      runtime.discovery?.status === "none" &&
      runtime.verifiedCreatorIdentityId
    ) {
      // Retry after a payment-phase error: identity and the NO-CREDIT
      // discovery answer are already established — return straight to the
      // $1 confirm step without re-running discovery or asking for a
      // second signature.
      dispatchCreateFlow("DISCOVERY_NONE");
      return;
    }

    void servicePayment.connectWallet();
  };

  // THE single production payment trigger: an explicit Confirm $1 click
  // while the flow is in needs-payment. The PATCH-2K-A discovery guard
  // inside the controller applies as defense-in-depth.
  const handleConfirmServicePayment = async () => {
    if (createFlowState !== "needs-payment") return;
    dispatchCreateFlow("PAYMENT_STARTED");

    if (servicePayment.getState().quote === null) {
      await servicePayment.requestQuote();
      if (servicePayment.getState().quote === null) {
        // Quote failed: the controller is in the error phase; the ERROR
        // effect above moves the flow to the retry state.
        return;
      }
    }
    await servicePayment.confirmAndVerify();
  };

  /* ================= ENTITLEMENT RESTORE (PATCH-2F / PATCH-2J) ================= */

  // PATCH-2J: sign-based credit discovery (issue-challenge → signMessage
  // → credit-status) runs inside the headless payment controller. The
  // single signature is requested only by an explicit Create Capsule
  // action (handleFirstCreateClick) — never on mount.
  //
  // In-session: a successful $1 payment (grant via onCreditReady → gate
  // reportCreditReady) or a discovery-restored AVAILABLE credit
  // (onCreditDiscovered → gate reportCreditDiscovery) lands in the gate
  // entitlement mirror; this effect is the single PATCH-2F restore point
  // that returns the workspace to "paid" — no second signature, no
  // second $1. The mirror is account-bound: a different connected wallet
  // must re-discover instead of restoring.

  useEffect(() => {
    if (!entitlement?.creatorCreditId) return;
    if (!entitlement.creatorIdentityId || !entitlement.account) return;
    // The entitlement is account-bound: never restore it for a different
    // connected wallet (an account switch must re-discover).
    if (entitlement.account !== wallet.account) return;

    const result: ServicePaymentResult = {
      creatorCreditId: entitlement.creatorCreditId,
      creatorIdentityId: entitlement.creatorIdentityId,
      account: entitlement.account,
    };
    if (entitlement.paymentIntentId !== undefined) {
      result.paymentIntentId = entitlement.paymentIntentId;
    }
    setServicePaymentResult(result);
    // PATCH-2F: a server-authenticated AVAILABLE entitlement restores the
    // paid workspace. PATCH-2M: this effect must also run when the flow is
    // already "paid" — reportCreditDiscovery/reportCreditReady batch
    // setEntitlement with the paid dispatch into ONE React commit, so an
    // early paid-return here left servicePaymentResult null and dead-ended
    // Create Capsule. Re-runs are safe: reduceCreateFlow treats
    // DISCOVERY_AVAILABLE as an idempotent no-op at paid (and it still
    // wins from payment-in-progress).
    dispatchCreateFlow("DISCOVERY_AVAILABLE");
  }, [entitlement, createFlowState, wallet]);

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
      // The canonical quote is in hand — open the Final Capsule Review.
      setSealPhase("idle");
      setIsReviewOpen(true);
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
    if (createFlowState !== "paid" || !servicePaymentResult) return;
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
    if (createFlowState !== "paid" || !servicePaymentResult) return;
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
      //
      // 🛡️ NEVER FUND TWICE: if this storagePaymentId already has a
      // funding signature, the creator has paid. Go straight to
      // verification of that existing payment.
      const { fundingSignature } = await ensureStorageFundingSignature(
        storageFundingRef.current,
        storageReview.storagePaymentId,
        async () => {
          const creatorWallet = toCreatorIrysWallet(walletRef.current as never);
          return fundCreatorPaidStorage(
            storageReview.expectedAmountAtomic,
            creatorWallet
          );
        }
      );

      // Record the signature so this storagePaymentId can never be funded twice.
      storageFundingRef.current = {
        storagePaymentId: storageReview.storagePaymentId,
        fundingSignature,
      };

      // VERIFY-ONLY retry: re-runs /api/storage/verify-payment for the SAME
      // payment while the outcome is TRANSACTION_PENDING. Never funds, never
      // signs, never uploads.
      const verifyOutcome = await verifyStoragePaymentWithRetry(
        storageReview.storagePaymentId,
        fundingSignature
      );

      if (!verifyOutcome.ok) {
        const reason = verifyOutcome.reason;
        // Stale-quote hardening: an expired quote can never be verified,
        // so funding it again would only pay twice. Drop the review; the
        // next explicit Create Capsule re-quotes (no re-payment, no
        // reserve against the stale quote). Every other failure reason
        // stays in the storage payment/review state: the paid $1
        // entitlement, lifecycle binding, quote and wallet binding are
        // preserved so the creator can retry the same storage payment.
        if (shouldClearStorageReviewOnVerifyFailure(reason)) {
          setStorageReview(null);
          setIsReviewOpen(false);
        }
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

  // PATCH-2K-B disable matrix over the create-flow state machine. The
  // gate invariants (payment only after discovery, an AVAILABLE credit
  // never pays, paid is never clobbered) are pinned by
  // capsuleCreateFlow.test.ts on the live reducer.
  const isCreateDisabled =
    storageReview !== null
      ? sealPhase !== "idle" || createFlowState !== "paid"
      : createFlowState === "ready"
      ? !canSeal
      : createFlowState === "paid"
      ? !canSeal || sealPhase !== "idle"
      : createFlowState === "needs-payment" || createFlowState === "error"
      ? false
      : true; // discovering / payment-in-progress are busy states

  // The Irys price lives inside the Final Capsule Review dialog; the
  // primary action in the review state only (re)opens that dialog —
  // never a quote, never a payment.
  const primaryButtonLabel =
    createFlowState === "needs-payment"
      ? "Confirm $1 USDC"
      : createFlowState === "error"
      ? "Retry"
      : "Create Capsule";

  // PATCH-2K-B inline gate status: compact text next to Create Capsule.
  // No endpoint names, quote ids, credit ids or transaction internals are
  // shown; raw controller error codes stay in state and are never
  // rendered.
  const gateStatus = (() => {
    if (storageReview !== null) return null;
    switch (createFlowState) {
      case "discovering":
        return servicePaymentRuntime.phase === "connecting_wallet"
          ? "Connect wallet"
          : servicePaymentRuntime.phase === "verifying_identity"
          ? "Verifying wallet…"
          : "Checking your access…";
      case "needs-payment":
        return "One-time setup — $1 USDC";
      case "payment-in-progress":
        return "Processing…";
      case "paid":
        return "Creator access ready";
      case "error":
        return describeGateError(
          servicePaymentRuntime.error ?? servicePaymentRuntime.verificationError
        );
      default:
        return null; // ready — plain Create Capsule
    }
  })();

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
                <div className="aeterna-error-notice p-3 rounded-md bg-red-500/10 border border-red-500/20 text-xs text-red-500 animate-in fade-in zoom-in-95">
                  {sealError}
                </div>
              )}

              {phantomMobileRequired && (
                <div
                  role="alert"
                  className="p-3 rounded-md bg-amber-500/10 border border-amber-500/20 text-xs text-amber-500 animate-in fade-in zoom-in-95 space-y-2"
                >
                  <p className="font-medium">{PHANTOM_MOBILE_TITLE}</p>
                  <p>{PHANTOM_MOBILE_BODY}</p>
                  <div className="flex flex-wrap items-center gap-3 pt-1">
                    <Button
                      type="button"
                      onClick={openAeternaInPhantomMobile}
                      className="h-9 px-4 text-xs"
                    >
                      {PHANTOM_MOBILE_OPEN_LABEL}
                    </Button>
                    <a
                      href={PHANTOM_INSTALL_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline underline-offset-2"
                    >
                      Install Phantom
                    </a>
                  </div>
                </div>
              )}

              {phantomRequired && (
                <div
                  role="alert"
                  className="p-3 rounded-md bg-amber-500/10 border border-amber-500/20 text-xs text-amber-500 animate-in fade-in zoom-in-95 space-y-1"
                >
                  <p className="font-medium">{PHANTOM_REQUIRED_TITLE}</p>
                  <p>{PHANTOM_REQUIRED_BODY}</p>
                  <a
                    href={PHANTOM_INSTALL_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-2"
                  >
                    Install Phantom
                  </a>
                </div>
              )}

              {servicePaymentError && (
                <div className="aeterna-error-notice p-3 rounded-md bg-red-500/10 border border-red-500/20 text-xs text-red-500 animate-in fade-in zoom-in-95">
                  {servicePaymentError}
                </div>
              )}

              {gateStatus && (
                <p className="text-xs text-muted-foreground" role="status">
                  {gateStatus}
                </p>
              )}
            </div>

            <div className="space-y-3">
              <Button
                disabled={isCreateDisabled || storageReviewLoading || Boolean(walletMismatch)}
                onClick={
                  storageReview !== null
                    ? () => setIsReviewOpen(true)
                    : createFlowState === "paid"
                    ? handleFinalCreateClick
                    : createFlowState === "needs-payment"
                    ? handleConfirmServicePayment
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

      {/* Final Capsule Review: rendered OUTSIDE the !isBusy block so the
          dialog stays mounted while the storage payment runs. Open only
          after a successful canonical Irys quote (storageReview !== null);
          close (X/Escape/overlay/Cancel) only hides the dialog — the
          review state and prepared identity are preserved. */}
      <FinalCapsuleReviewModal
        open={storageReview !== null && isReviewOpen}
        storageReview={storageReview}
        description={typeof description === "string" ? description : null}
        unlockAt={typeof unlockAt === "number" ? unlockAt : null}
        walletMismatch={walletMismatch}
        sealError={sealError}
        isPreparing={isPreparing}
        onConfirm={handleConfirmStoragePayment}
        onOpenChange={(next) => {
          if (!next) setIsReviewOpen(false);
        }}
      />
    </div>
  );
}