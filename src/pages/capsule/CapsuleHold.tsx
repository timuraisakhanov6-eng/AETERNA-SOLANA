import { useEffect, useRef, useState, useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Loader2, Lock, AlertTriangle, RefreshCw } from "lucide-react";
import { sealCapsuleCore } from "@/lib/capsule/sealCapsuleCore";
import {
  getRuntime,
  destroyRuntime,
} from "@/lib/runtime/runtimeRegistry";
import { useCapsule } from "../../context/CapsuleContext";
import {
  CAPSULE_ID_REGEX,
  SECRET_REGEX,
  SALT_BASE_REGEX,
  SHA256_REGEX,
} from "@/lib/crypto/validators";

import { Button } from "@/components/ui/button";

import type { CapsuleHoldState } from "@/types/capsule";
import type { OpenAtUtc } from "@/types/manifest";
import type { ChunkMetadata } from "@/types/vault";
import type { SealCapsuleResult } from "@/lib/capsule/sealCapsuleCore";



/* ================= BASE64 DECODE (browser-safe) ================= */

// base64 → Uint8Array without Buffer (Vite / browser / Cloudflare Pages safe)
// Used only for MetaMask-recovery from sessionStorage.
function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}


/* ================= TYPES ================= */


// Mirrors SessionCapsuleData from CapsuleBuilder.
//
// Used to restore the PreparedCapsule after
// browser interruption.
//
// Runtime ciphertext is stored separately
// inside IndexedDB.
type SessionCapsuleData = {
  billableSizeBytes: number;
  expectedAmount: number;
  openAt: number;
  description?: string;
  capsuleId: string;
  itemIds: string[];

  encryptedVaultPointer: string;

  encryptedSizeBytes: number;

  vaultSha256: string;

  saltBase: string;

  recipientSecret: string;

  creatorAuthority: string;

  chunkMetadata:
    readonly ChunkMetadata[];
};


type LocationState = Readonly<{
  holdState: CapsuleHoldState;
  correlationTransactionId?: string | null;
  canonicalLifecycleId?: string | null;
}>;


/* ================= RECOVERY VALIDATION ================= */

// Strict shape-check for sessionStorage recovery payload.
// Every field that downstream STEP 4 integrity guards / sealCapsuleCore
// rely on must be validated here — a partially-valid object would
// otherwise pass through and fail later with a less clear error.
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

    Array.isArray(
      p.chunkMetadata
    ) &&

    Number.isSafeInteger(p.billableSizeBytes) &&
    (p.billableSizeBytes as number) > 0
  );

}


/* ================= COMPONENT ================= */


export default function CapsuleHold() {

  const navigate = useNavigate();

  const location = useLocation();

  const { resetCapsule } = useCapsule();

  // resetCapsule is recreated on every provider render; the seal effect
  // must never re-run on those renders, so keep it behind a stable ref.
  const resetCapsuleRef = useRef(resetCapsule);

  resetCapsuleRef.current = resetCapsule;

  const startedRef =
    useRef(false);

  // Tracks whether the current effect invocation is still mounted. Guards
  // the post-seal resetCapsule() call so a stale (dangling) seal closure
  // that completes after the user navigated away can never wipe a NEW
  // capsule's in-progress session state.
  const mountedRef =
    useRef(true);

  const [sealed, setSealed] =
    useState(false);


  const [error, setError] =
    useState<{
      title: string;
      message: string;
    } | null>(null);


  const [retryNonce, setRetryNonce] =
    useState(0);


  // ── Patch #2: slow-mode hint after 6 s ──
  const [slowMode, setSlowMode] =
    useState(false);


  const sealLockKey =
    "aeterna-seal-lock";


  /* ================= LOAD STATE ================= */


  const locationState =
    location.state as LocationState | null;


  const params =
    new URLSearchParams(location.search);


  // transactionId is correlation data only.
  // It is never authority for upload/hold.
  const correlationTransactionId =
    locationState?.correlationTransactionId ??
    params.get("transaction_id") ??
    params.get("checkout_id") ??
    null;

  const canonicalLifecycleId =
    locationState?.canonicalLifecycleId ??
    params.get("lifecycleId") ??
    null;


  const holdStateRef =
    useRef<CapsuleHoldState | null | undefined>(undefined);

  if (holdStateRef.current === undefined) {

    let resolved: CapsuleHoldState | null =
      locationState?.holdState ?? null;

    if (!resolved) {
      try {
        const saved = sessionStorage.getItem("aeterna-prepared-capsule");
        if (saved) {
          const parsed: unknown = JSON.parse(saved);
          if (isValidSessionCapsuleData(parsed)) {
            resolved = {
              billableSizeBytes: parsed.billableSizeBytes,
              expectedAmount: parsed.expectedAmount,
              openAt:         parsed.openAt as OpenAtUtc,
              ...(typeof parsed.description === "string"
                ? { description: parsed.description }
                : {}),
              itemIds:        parsed.itemIds,
              creatorAuthority: parsed.creatorAuthority,
              prepared: {
                capsuleId:
                  parsed.capsuleId,
                encryptedVaultPointer:
                  parsed.encryptedVaultPointer,
                encryptedSizeBytes:
                  parsed.encryptedSizeBytes,
                vaultSha256:
                  parsed.vaultSha256,
                saltBase:
                  parsed.saltBase,
                recipientSecret:
                  parsed.recipientSecret,
                creatorAuthority:
                  parsed.creatorAuthority,

                chunkMetadata:
                  parsed.chunkMetadata,
              },
            };
          }
        }
      } catch {
        // ignore
      }
    }

    holdStateRef.current = resolved;

  }

  const holdState = holdStateRef.current;


  /* ================= GUARDS ================= */


  useEffect(() => {

    if (
      !holdState ||
      !canonicalLifecycleId
    ) {

      navigate(
        "/",
        { replace: true }
      );

    }

  }, [
    holdState,
    canonicalLifecycleId,
    navigate,
  ]);


  useEffect(() => {

    if (
      sealed ||
      error
    ) return;


    const handler =
      (e: BeforeUnloadEvent) => {

        e.preventDefault();

        e.returnValue =
          "Capsule publishing is in progress. Closing this tab might result in data loss.";

        return e.returnValue;

      };


    window.addEventListener(
      "beforeunload",
      handler
    );


    return () =>
      window.removeEventListener(
        "beforeunload",
        handler
      );

  }, [
    sealed,
    error,
  ]);


  // ── Patch #2: start slow-mode timer when sealing is active ──
  useEffect(() => {

    if (sealed || error) return;

    const t = setTimeout(
      () => setSlowMode(true),
      6000
    );

    return () => clearTimeout(t);

  }, [sealed, error, retryNonce]);


  /* ================= RETRY ================= */


  const handleRetry =
    useCallback(() => {

      startedRef.current =
        false;

      setError(null);

      setSlowMode(false);

      try {

        sessionStorage.removeItem(
          sealLockKey
        );

      } catch {
        // ignore
      }

      setRetryNonce(
        (n) => n + 1
      );

    }, []);


  /* ================= CORE LOGIC ================= */


  useEffect(() => {

    mountedRef.current =
      true;

    const markUnmounted =
      () => {
        mountedRef.current =
          false;
      };

    if (
      !holdState ||
      !canonicalLifecycleId ||
      startedRef.current ||
      error
    ) {
      return markUnmounted;
    }


    try {

      const existingLock =
        sessionStorage.getItem(
          sealLockKey
        );


      if (
        existingLock &&
        existingLock !==
          canonicalLifecycleId
      ) {
        return;
      }


      sessionStorage.setItem(
        sealLockKey,
        canonicalLifecycleId
      );

    } catch {
        // ignore
      }


    startedRef.current =
      true;


    const finalizeSealing =
      async () => {

        try {

          /* ── STEP 1: canonical upload token ── */

          const tokenRes =
            await fetch(
              "/api/upload-token",
              {
                method: "POST",
                headers: {
                  "Content-Type":
                    "application/json",
                },
                body:
                  JSON.stringify({
                    capsuleId:
                      holdState.prepared.capsuleId,
                    canonicalLifecycleId,
                    correlationTransactionId:
                      correlationTransactionId ?? "",
                  }),
              }
            );


          if (!tokenRes.ok)
            throw new Error(
              "UPLOAD_TOKEN_REQUEST_FAILED"
            );


          const tokenData =
            await tokenRes.json().catch(() => null);


          const uploadToken =
            tokenData?.uploadToken;


          if (
            typeof uploadToken !==
              "string" ||
            uploadToken.length < 32
          )
            throw new Error(
              "UPLOAD_TOKEN_DENIED"
            );


          /* ── STEP 3: Trusted time boundary ── */

          const timeRes =
            await fetch(
              "/api/time"
            );


          if (!timeRes.ok)
            throw new Error(
              "TIME_AUTHORITY_UNAVAILABLE"
            );


          const timeData =
            await timeRes.json();


          const trustedNow: number =
            timeData.nowUtc;


          if (
            typeof trustedNow !== "number" ||
            !Number.isFinite(trustedNow) ||
            !Number.isInteger(trustedNow)
          ) {
            throw new Error(
              "INVALID_TRUSTED_TIME"
            );
          }


          if (
            holdState.openAt <=
              trustedNow
          ) {
            throw new Error(
              "INVALID_OPEN_BOUNDARY"
            );
          }


          /* ── STEP 4: Integrity guards ── */

          if (!holdState.prepared.capsuleId)
            throw new Error(
              "CAPSULE_ID_MISSING"
            );

          if (!CAPSULE_ID_REGEX.test(holdState.prepared.capsuleId)) {
            throw new Error(
              "INVALID_CAPSULE_ID"
            );
          }

          if (
            holdState.billableSizeBytes <= 0
          )
            throw new Error(
              "INVALID_BILLABLE_SIZE_BYTES"
            );

          if (!SECRET_REGEX.test(holdState.prepared.recipientSecret)) {
            throw new Error(
              "INVALID_RECIPIENT_SECRET"
            );
          }

          if (!SECRET_REGEX.test(holdState.prepared.creatorAuthority)) {
            throw new Error(
              "INVALID_CREATOR_AUTHORITY"
            );
          }

          if (!SHA256_REGEX.test(holdState.prepared.vaultSha256)) {
            throw new Error(
              "INVALID_VAULT_SHA256"
            );
          }

          if (!SALT_BASE_REGEX.test(holdState.prepared.saltBase)) {
            throw new Error(
              "INVALID_SALT_BASE"
            );
          }

          if (
            !holdState.itemIds?.length
          )
            throw new Error(
              "ITEM_IDS_MISSING"
            );


          /* ── STEP 5: sealCapsuleCore ── */

          const runtime =
            await getRuntime(
              holdState.prepared.capsuleId
            );

          let result:
            | SealCapsuleResult
            | null =
            null;

          try {

            let attempt = 0;

            while (attempt < 3) {

              try {

                const normalizedDescription =
                  typeof holdState.description === "string"
                    ? holdState.description
                    : "";

                result =
                  await sealCapsuleCore({

                    capsuleId:
                      holdState.prepared.capsuleId,

                    encryptedVaultPointer:
                      holdState.prepared.encryptedVaultPointer,

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

                    openAt:
                      holdState.openAt,

                    description:
                      normalizedDescription,

                    uploadToken,

                    runtime,

                    chunkMetadata:
                      holdState.prepared.chunkMetadata,

                  });

                break;

              } catch {

                attempt++;

                if (attempt >= 3)
                  throw new Error(
                    "SEALING_FAILED_FINAL"
                  );

                await new Promise(
                  (r) =>
                    setTimeout(
                      r,
                      1000 *
                        Math.pow(
                          2,
                          attempt
                        )
                    )
                );

              }

            }

          } finally {

            /* ── STEP 6: cleanup ── */

            // Runtime is a resource — must be released regardless of outcome.
            await destroyRuntime(
              holdState.prepared.capsuleId
            );

          }


          if (
            !result?.capsuleId ||
            result.capsuleId !==
              holdState.prepared.capsuleId
          )
            throw new Error(
              "INVALID_SEAL_RESULT"
            );


          try {

            sessionStorage.removeItem(
              "aeterna-prepared-capsule"
            );

            sessionStorage.removeItem(
              sealLockKey
            );

          } catch {
        // ignore
      }


          /* ── STEP 7: redirect ── */

          setSealed(true);

          // Post-seal lifecycle: the next capsule created in this tab must
          // receive a fresh capsuleId. resetCapsule() regenerates the
          // identity root and clears the creator session, so a later
          // PREPARED can never bind to an already-sealed capsuleId.
          try {

            if (mountedRef.current) {

              resetCapsuleRef.current();

            }

          } catch {

            // Sealing has already succeeded — a reset failure must never
            // block the redirect or misreport the seal as failed.

          }

          navigate(
            result.confirmationLink,
            {
              replace: true,
            }
          );

        }

        catch (err) {

          if (import.meta.env.DEV) {
            console.error(
              "[AETERNA] Critical sealing error:",
              err
            );
          }

          try {

            sessionStorage.removeItem(
              sealLockKey
            );

          } catch {
        // ignore
      }


          startedRef.current =
            false;


          setError({

            title:
              "Unable to Publish Capsule",

            message:
              "Your payment was successful.\n\nWe couldn't finish publishing your capsule. No data has been lost.\n\nPress Try Again to continue.",

          });

        }

      };


    finalizeSealing();

    return markUnmounted;

  }, [
  holdState,
  canonicalLifecycleId,
  correlationTransactionId,
  navigate,
  error,
  retryNonce,
]);


  /* ================= UI ================= */


  if (
    !holdState ||
    !canonicalLifecycleId
  ) {
    return null;
  }


  if (error) {

    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">

        <div className="relative z-10 max-w-md w-full text-center space-y-8">

          <div className="mx-auto w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center border border-red-500/20">

            <AlertTriangle
              className="text-red-500"
              size={32}
            />

          </div>

          <div className="space-y-2">

            <h1 className="text-2xl font-display uppercase tracking-wider">

              {error.title}

            </h1>

            <p className="text-muted-foreground text-sm leading-relaxed whitespace-pre-line">

              {error.message}

            </p>

          </div>

          <Button
            variant="outline"
            className="w-full gap-2 border-emerald-500/50 hover:bg-emerald-500/10"
            onClick={handleRetry}
          >

            <RefreshCw size={16} />

            TRY AGAIN

          </Button>

        </div>

      </div>
    );

  }


  return (

    <div className="min-h-screen bg-background flex items-center justify-center relative overflow-hidden">

      <div className="relative z-10 text-center space-y-8 px-6 max-w-sm">

        <Lock
          className="text-emerald-500 mx-auto"
          size={32}
        />

        <Loader2
          className="animate-spin text-emerald-500 mx-auto"
          size={20}
        />

        <p className="text-xs uppercase tracking-widest text-muted-foreground">
          Finalizing your capsule…
        </p>

        <p className="text-xs uppercase tracking-widest text-muted-foreground/60">
          Your capsule is being securely published.
          <br />
          Please keep this window open.
        </p>

        {slowMode && (
          <p className="text-xs text-muted-foreground/50 tracking-wide">
            Large capsules may require additional time.
            <br />
            Everything is progressing normally.
          </p>
        )}

      </div>

    </div>

  );

}