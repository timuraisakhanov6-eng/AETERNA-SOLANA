import { useState, useRef, useContext, useEffect, useCallback } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Link, useNavigate } from "react-router-dom";
import { ChevronLeft, Lock, Loader2 } from "lucide-react";
import { useCapsule } from "../../context/CapsuleContext";
import { useCreatorIdentity } from "@/context/CreatorRuntimeContext";
import { AETERNAWalletContext } from "@/context/AETERNAWalletContext";
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

/* 🚨 КРИТИЧЕСКОЕ ПРАВИЛО:
  Импорты streamEncryptUpload и encryptChunk УДАЛЕНЫ.
  CapsuleBuilder готовит метаданные и резервирует lifecycle.
*/

const HEADER_HEIGHT = 64;
const MAX_DESCRIPTION = 140;

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
  const wallet = useContext(AETERNAWalletContext);
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

  const reserveLifecycle = async (prepared: CapsuleHoldState, creatorCreditId: string) => {
    const candidateLifecycleId = `lifecycle-${prepared.prepared.capsuleId}-${Date.now()}`

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

  const handleReserveReady = async (result: { creatorCreditId: string }) => {
    if (!preparedRef.current) return

    const prepared = preparedRef.current
    preparedRef.current = null

    try {
      const reserved = await reserveLifecycle(prepared, result.creatorCreditId)
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

  const handleFinalCreateClick = async () => {
    if (servicePaymentState !== "paid" || !servicePaymentResult) return;
    if (sealPhase !== "idle" || sealingRef.current) return;
    if (!walletMatch()) {
      setServicePaymentState("ready");
      setServicePaymentResult(null);
      setServicePaymentError("Wallet or identity mismatch. Please repeat payment.");
      return;
    }

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
          void handleReserveReady({ creatorCreditId: servicePaymentResult.creatorCreditId });
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
        void handleReserveReady({ creatorCreditId: servicePaymentResult.creatorCreditId });
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

      const holdState = preparedRef.current;
      if (!holdState) {
        throw new Error("HOLD_STATE_MISSING");
      }

      preparedInputsRef.current = fingerprint;
      try {
        const sessionData = {
          billableSizeBytes: holdState.billableSizeBytes,
          expectedAmount: holdState.expectedAmount,
          openAt: holdState.openAt,
          ...(typeof holdState.description === "string" ? { description: holdState.description } : {}),
          inputsFingerprint: fingerprint,
          capsuleId: holdState.prepared.capsuleId,
          itemIds: holdState.itemIds,
          encryptedVaultPointer: holdState.prepared.encryptedVaultPointer,
          encryptedSizeBytes: holdState.prepared.encryptedSizeBytes,
          vaultSha256: holdState.prepared.vaultSha256,
          saltBase: holdState.prepared.saltBase,
          recipientSecret: holdState.prepared.recipientSecret,
          creatorAuthority: holdState.prepared.creatorAuthority,
          chunkMetadata: holdState.prepared.chunkMetadata,
        };
        sessionStorage.setItem(
          "aeterna-prepared-capsule",
          JSON.stringify(sessionData)
        );
      } catch {
        // non-fatal
      }

      setSealPhase("idle");
      void handleReserveReady({ creatorCreditId: servicePaymentResult.creatorCreditId });
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

  const canSeal =
    items.length > 0 &&
    typeof unlockAt === "number" &&
    isConfirmed &&
    sealPhase === "idle";

  const isCreateDisabled =
    servicePaymentState === "ready"
      ? !canSeal || servicePaymentState !== "ready"
      : servicePaymentState === "paid"
      ? !canSeal || sealPhase !== "idle"
      : true;

  const primaryButtonLabel =
    servicePaymentState === "paid"
      ? "CREATE CAPSULE"
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
                disabled={isCreateDisabled}
                onClick={
                  servicePaymentState === "paid"
                    ? handleFinalCreateClick
                    : handleFirstCreateClick
                }
                className={[
                  "w-full h-14 text-lg font-display tracking-widest transition-all active:scale-[0.98]",
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
    </div>
  );
}