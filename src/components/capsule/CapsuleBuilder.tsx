import { useState, useRef } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Link, useNavigate } from "react-router-dom";
import { ChevronLeft, Lock, Loader2, CreditCard } from "lucide-react";
import { useCapsule } from "../../context/CapsuleContext";
import ActionMenu from "./ActionMenu";
import MediaCapture from "./MediaCapture";
import CapsuleInput from "./CapsuleInput";
import HorizontalCapsule from "./HorizontalCapsule";
import { DateTimePicker, normalizeOpenAt } from "./DateTimePicker";
import { PaymentModal } from "./PaymentModal";
import { Button } from "@/components/ui/button";
import { CapsuleItem } from "@/types/capsule";
import { calculatePrice } from "@/lib/pricing";
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

/* 🚨 КРИТИЧЕСКОЕ ПРАВИЛО:
  Импорты streamEncryptUpload и encryptChunk УДАЛЕНЫ.
  CapsuleBuilder ТОЛЬКО готовит метаданные и инициирует оплату.
*/

const HEADER_HEIGHT = 64;
const MAX_DESCRIPTION = 140;

type SealPhase = "idle" | "preparing";

/* ================= BASE64 ENCODE (browser-safe) ================= */

// Uint8Array → base64 без Buffer (Vite / browser / Cloudflare Pages safe)
// String.fromCharCode(...bytes) — stack overflow на больших массивах,
// поэтому итерируем явно.
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";

  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }

  return btoa(binary);
}

/* ================= MIME NORMALIZATION ================= */

// Canonical mimeType guard — MAX_MIMETYPE_LENGTH = 255 per canonicalSerializeVaultV2.ts.
// Applied at every media entry point: file select, capture, and audio record.
function normalizeMimeType(raw: string | undefined): string {
  return typeof raw === "string" && raw.length <= 255
    ? raw
    : "application/octet-stream";
}

/* ================= PADDLE ================= */

interface PaddleCheckoutResponse {
  checkoutUrl: string;
}

interface PaddleSuccessData {
  checkout?: {
    id?: string;
  };
  transaction?: {
    id?: string;
  };
  id?: string;
}

interface PaddleCheckoutSDK {
  Checkout: {
    open: (options: {
      override: string;
      successCallback: (data: PaddleSuccessData) => void;
      closeCallback: () => void;
    }) => void;
  };
}

function isPaddleCheckoutResponse(
  value: unknown
): value is PaddleCheckoutResponse {

  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { checkoutUrl?: unknown }).checkoutUrl === "string"
  );

}

async function createPaddleCheckout(
  expectedAmount: number,
  billableSizeBytes: number,
  capsuleId: string
) {
  if (typeof fetch !== "function") {
    throw new Error("FETCH_UNAVAILABLE");
  }

  const res = await fetch("/api/paddle/create-checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      expectedAmount,
      billableSizeBytes,
      capsuleId,
      currency: "USD",
    }),
  });

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error("PADDLE_CREATE_FAILED");
  }

  if (!res.ok || !isPaddleCheckoutResponse(data)) {
    throw new Error("PADDLE_CREATE_FAILED");
  }

  return data;
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

  encryptedPayloadBase64: string;

  encryptedSizeBytes: number;

  vaultSha256: string;

  saltBase: string;

  recipientSecret: string;

  creatorAuthority: string;

  chunkMetadata: readonly ChunkMetadata[];

};

/* ================= PREPARED IDENTITY HELPERS ================= */

// base64 → Uint8Array without Buffer (Vite / browser / Cloudflare Pages
// safe). Mirrors CapsuleHold.tsx — used to restore the PreparedCapsule
// from sessionStorage instead of re-preparing (single-shot PREPARED).
function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}


// Strict shape-check for the sessionStorage recovery payload. Mirrors
// CapsuleHold.tsx isValidSessionCapsuleData.
function isValidSessionCapsuleData(
  parsed: unknown
): parsed is SessionCapsuleData {

  if (!parsed || typeof parsed !== "object") return false;

  const p = parsed as Partial<SessionCapsuleData>;

  return (
    typeof p.encryptedPayloadBase64 === "string" &&
    p.encryptedPayloadBase64.length > 0 &&

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
    prepared: {
      capsuleId: parsed.capsuleId,
      encryptedPayload:
        base64ToUint8Array(parsed.encryptedPayloadBase64),
      encryptedSizeBytes: parsed.encryptedSizeBytes,
      vaultSha256: parsed.vaultSha256,
      saltBase: parsed.saltBase,
      recipientSecret: parsed.recipientSecret,
      creatorAuthority: parsed.creatorAuthority,
      chunkMetadata: parsed.chunkMetadata,
    },
  };

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

  const fileInputRef = useRef<HTMLInputElement>(null);

  const [isActionMenuOpen, setIsActionMenuOpen] = useState(false);
  const [mediaCaptureMode, setMediaCaptureMode] =
    useState<"photo" | "video" | null>(null);

  const [isConfirmed, setIsConfirmed] = useState(false);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [sealPhase, setSealPhase] = useState<SealPhase>("idle");
  const [sealError, setSealError] = useState<string | null>(null);

  const preparedRef = useRef<CapsuleHoldState | null>(null);

  // Single-shot PREPARED guard: fingerprint of the preparation-defining
  // inputs that produced preparedRef.current. A PREPARED capsule identity
  // must never be regenerated under the same capsuleId.
  const preparedInputsRef = useRef<string | null>(null);

  // 🛡️ StrictMode / double-click guard
  const sealingRef = useRef(false);

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

  /* ================= PREPARE ================= */

  const encoder = new TextEncoder();

  const estimatedTextSize =
    encoder.encode(description ?? "").length +
    items
      // FIX 5: canonical narrowing via Extract<> instead of intersection hack
      .filter(
        (i): i is Extract<CapsuleItem, { type: "text" }> =>
          i.type === "text"
      )
      .reduce((acc: number, i) => {
        return acc + encoder.encode(i.text ?? "").length;
      }, 0);

  // FIX 6: canonical narrowing — only "media" items carry a size; skip the
  // rest instead of relying on (item.size ?? 0), which silently summed
  // undefined-size fields from non-media items.
  const estimatedMediaSize =
    items.reduce((acc, item) => {

      if (item.type !== "media") {
        return acc;
      }

      return acc + item.size;

    }, 0);

  const previewVaultSize =
  estimatedTextSize + estimatedMediaSize;

  // NOTE: currentPrice is an estimate only (pre-encryption size), and is
  // also the canonical Business Layer size (billableSizeBytes) used for
  // pricing at seal-time — pricing is always based on what the user saw,
  // never on encryptedSizeBytes (Crypto Layer, post-encryption padding).
  const currentPrice = calculatePrice(previewVaultSize);

  const canSeal =
    items.length > 0 &&
    typeof unlockAt === "number" &&
    isConfirmed &&
    sealPhase === "idle";

  const handleSealClick = async () => {
    if (!canSeal || !unlockAt) return;

    // 🚨 StrictMode / double-click guard
    if (sealingRef.current) return;
    sealingRef.current = true;

    setSealError(null);
    setSealPhase("preparing");

    try {
      // rev6: capability generation, vault assembly, capsuleId validation,
      // and the max-size check all live inside preparePreparedCapsule()
      // now. description is a checkout-time field, not part of the vault
      // envelope, so it isn't passed in here.
      const snapshotItems = [...items];

      // ── SINGLE-SHOT PREPARED GUARD ──
      //
      // Canonical lifecycle (AETERNA_COMPLETE_SYSTEM_LOGIC.md, Ciphertext
      // Authority Law): capabilities are generated exactly once per capsule
      // identity, and the cryptographic part is immutable after PREPARED.
      // A second preparation must never silently replace the existing
      // PreparedCapsule under the same capsuleId:
      //
      //   unchanged inputs → reuse the existing PREPARED identity
      //   changed inputs   → NEW capsule identity (resetCapsule rotates
      //                      capsuleId) — never regenerate under the old id
      //   no PREPARED yet  → fresh preparation
      const fingerprint =
        buildPreparationFingerprint(
          snapshotItems,
          unlockAt
        );

      if (preparedRef.current) {

        if (
          preparedInputsRef.current ===
          fingerprint
        ) {

          // Inputs unchanged — reuse the existing PREPARED identity.
          // No capability/key/ciphertext regeneration happens here.
          preparedRef.current = {
            ...preparedRef.current,
            description:
              description ?? "",
          };

          setSealPhase("idle");
          setShowPaymentModal(true);

          return;

        }

        // Inputs changed after PREPARED — the capsule's cryptographic part
        // is immutable. Canonical behavior: a NEW capsule identity.
        resetCapsule();

        preparedRef.current =
          null;

        preparedInputsRef.current =
          null;

        try {

          sessionStorage.removeItem(
            "aeterna-prepared-capsule"
          );

        } catch {

          // Non-fatal: a stale recovery record must not block the
          // canonical lifecycle transition.

        }

        setSealPhase("idle");

        setSealError(
          "Capsule contents changed after preparation. " +
          "A new capsule has been started — please rebuild it and continue."
        );

        return;

      }

      // No in-memory prepared state (e.g. after navigating away and back):
      // consult the sessionStorage recovery record so an existing PREPARED
      // identity for this capsuleId is never regenerated.
      const restored =
        restorePreparedFromSession(
          capsuleId,
          unlockAt,
          fingerprint,
          snapshotItems
        );

      if (restored !== null) {

        if (restored === "stale") {

          // Session record exists for this capsuleId but the inputs no
          // longer match — inputs changed after PREPARED → new capsule.
          resetCapsule();

          try {

            sessionStorage.removeItem(
              "aeterna-prepared-capsule"
            );

          } catch {

            // Non-fatal: a stale recovery record must not block the
            // canonical lifecycle transition.

          }

          setSealPhase("idle");

          setSealError(
            "Capsule contents changed after preparation. " +
            "A new capsule has been started — please rebuild it and continue."
          );

          return;

        }

        // Session record matches the current inputs — reuse the existing
        // PREPARED identity (no regeneration).
        preparedRef.current =
          restored;

        preparedInputsRef.current =
          fingerprint;

        setSealPhase("idle");
        setShowPaymentModal(true);

        return;

      }

      const preparedCapsule =
        await preparePreparedCapsule({
          capsuleId,
          items: snapshotItems,
          getMediaFile,
          openAt: unlockAt,
        });

      preparedRef.current = {

        prepared:
          preparedCapsule,

        billableSizeBytes:
          previewVaultSize,

        expectedAmount:
          calculatePrice(
            previewVaultSize
          ),

        openAt:
          unlockAt as OpenAtUtc,

        description:
          description ?? "",

        itemIds:
          snapshotItems.map(
            (i) => i.id
          ),

      };

      const holdState = preparedRef.current;

      if (!holdState) {
        throw new Error("HOLD_STATE_MISSING");
      }

      preparedInputsRef.current =
        fingerprint;

      // recipientSecret и creatorAuthority персистируются для Hold-восстановления после interruption.
      // По MASTER DOCUMENT §9 primary runtime — только preparedRef (память);
      // sessionStorage — recoverable continuation fallback.
     try {

  const sessionData: SessionCapsuleData = {

    billableSizeBytes:
      holdState.billableSizeBytes,

    expectedAmount:
      holdState.expectedAmount,

    openAt:
      holdState.openAt,

    ...(typeof holdState.description === "string"
      ? {
          description:
            holdState.description,
        }
      : {}),

    inputsFingerprint:
      fingerprint,

    capsuleId:
      holdState.prepared.capsuleId,

    itemIds:
      holdState.itemIds,

    encryptedPayloadBase64:
      uint8ArrayToBase64(
        holdState.prepared.encryptedPayload
      ),

    encryptedSizeBytes:
      holdState.prepared.encryptedSizeBytes,

    vaultSha256:
      holdState.prepared.vaultSha256,

    saltBase:
      holdState.prepared.saltBase,

    recipientSecret:
      holdState.prepared.recipientSecret,

    creatorAuthority:
      holdState.prepared.creatorAuthority,

    chunkMetadata:
      holdState.prepared.chunkMetadata,

  };
        sessionStorage.setItem(
          "aeterna-prepared-capsule",
          JSON.stringify(sessionData)
        );
      } catch {}

      setSealPhase("idle");
      setShowPaymentModal(true);

    } catch (err) {
      preparedRef.current = null;
      setSealPhase("idle");
      setSealError(
        err instanceof Error ? err.message : "Preparation failed"
      );
    } finally {
      // Разрешаем повторную попытку seal
      sealingRef.current = false;
    }
  };

  /* ================= PAYMENT ================= */

  const handleConfirmPayment = async (opts?: { web3TxHash?: string }) => {
    const prepared = preparedRef.current;
    if (!prepared) return;

    /* ── Web3 path ── */
    if (opts?.web3TxHash) {
      const preparedClone = structuredClone(prepared);
      navigate("/create/hold", {
        state: {
          holdState: preparedClone,
          transactionId: opts.web3TxHash,
          paymentMethod: "web3",
        },
      });

      // Memory hygiene: CapsuleHold already has an independent copy via
      // structuredClone, so the originating runtime no longer needs this
      // object. PreparedCapsule's recipientSecret/creatorAuthority are
      // readonly, so individual fields can't be zeroed in place — drop the
      // whole reference instead so it's eligible for GC (Memory Safety Law).
      // sessionStorage cleanup is owned by CapsuleHold STEP 6 (after successful seal).
      preparedRef.current = null;

      return;
    }

    /* ── Paddle path ── */
    try {
      const { checkoutUrl } = await createPaddleCheckout(
        prepared.expectedAmount,
        prepared.billableSizeBytes,
        prepared.prepared.capsuleId
      );

      const PaddleSDK = (window as unknown as { Paddle?: PaddleCheckoutSDK })
        .Paddle;
      if (!PaddleSDK) throw new Error("Paddle SDK not loaded");

      PaddleSDK.Checkout.open({
        override: checkoutUrl,
        successCallback: (data: PaddleSuccessData) => {
          const currentPrepared = preparedRef.current;

          if (!currentPrepared) {
            return;
          }

          const transactionId =
            data?.checkout?.id ??
            data?.transaction?.id ??
            data?.id ??
            null;

          const preparedClone = structuredClone(currentPrepared);

          navigate("/create/hold", {
            state: {
              holdState: preparedClone,
              transactionId,
              paymentMethod: "card",
            },
          });

          // Memory hygiene: mirrors web3 path — drop the whole reference
          // rather than mutating readonly fields on PreparedCapsule.
          // sessionStorage cleanup is owned by CapsuleHold STEP 6 (after successful seal).
          preparedRef.current = null;
        },
        closeCallback: () => {
          if (import.meta.env.DEV) {
            console.warn("[AETERNA] Paddle overlay closed without payment.");
      }
       },
      });

    } catch (err) {
      if (import.meta.env.DEV) {
        console.error("[AETERNA] Paddle checkout failed", err);
     }
      setSealError("Payment initialization failed");
    }
 };

  // Cancel payment only — the PreparedCapsule is KEPT. The canonical
  // PREPARED boundary is single-shot: the cryptographic identity for this
  // capsuleId cannot be regenerated, so the existing prepared state must
  // survive the payment cancellation to be reused (or replaced by a new
  // capsule identity via resetCapsule() if the inputs change).
  const handleCancelPayment = () => {
    setShowPaymentModal(false);
    setSealPhase("idle");
  };

  const remainingChars = MAX_DESCRIPTION - (description?.length ?? 0);
  const isPreparing = sealPhase === "preparing";
  const isBusy = isPreparing;

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
        className="mx-auto px-5 pb-[180px]"
        style={{ paddingTop: HEADER_HEIGHT + 32 }}
      >
        <div className="mx-auto w-full max-w-[720px] space-y-12">

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

          <section className="rounded-xl border bg-card/30 backdrop-blur-sm p-6 space-y-6 text-center">
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
            </div>

            <div className="space-y-3">
              <Button
                disabled={!canSeal}
                onClick={handleSealClick}
                className={[
                  "w-full h-14 text-lg font-display tracking-widest transition-all active:scale-[0.98]",
                  canSeal
                    ? "bg-emerald-600 hover:bg-emerald-500 text-white shadow-[0_0_30px_rgba(5,150,105,0.3)]"
                    : "bg-muted text-muted-foreground cursor-not-allowed",
                ].join(" ")}
              >
                {isPreparing ? (
                  <div className="flex items-center gap-2">
                    <Loader2 className="animate-spin" size={20} />
                    PREPARING VAULT...
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <CreditCard size={20} />
                    CONTINUE
                  </div>
                )}
              </Button>

              <p className="text-[10px] text-muted-foreground uppercase tracking-[0.2em]">
                Est. ${currentPrice.toFixed(2)} · Secure Payment via Paddle or USDC
              </p>
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

      <PaymentModal
        open={showPaymentModal}
        onClose={handleCancelPayment}
        description={description}
        billableSizeBytes={preparedRef.current?.billableSizeBytes ?? 0}
        expectedAmount={preparedRef.current?.expectedAmount ?? 0}
        unlockAt={preparedRef.current?.openAt ?? 0}
        capsuleId={preparedRef.current?.prepared.capsuleId ?? ""}
        onConfirmPayment={handleConfirmPayment}
        protocolAccepted={isConfirmed}
      />
    </div>
  );
}