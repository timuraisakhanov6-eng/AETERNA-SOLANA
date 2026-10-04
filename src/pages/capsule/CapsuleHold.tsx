import { useContext, useEffect, useRef, useState, useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Loader2, Lock, AlertTriangle, RefreshCw } from "lucide-react";
import { sealCapsuleCore } from "@/lib/capsule/sealCapsuleCore";
import { createCreatorIrysStorage } from "@/lib/storage/creatorIrysStorage";
import { toCreatorIrysWallet } from "@/lib/storage/creatorIrys";
import {
  getRuntime,
  destroyRuntime,
} from "@/lib/runtime/runtimeRegistry";
import { useCapsule } from "../../context/CapsuleContext";
import { AETERNAWalletContext } from "../../context/AETERNAWalletContext";
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



/* ================= USER-FACING TIME ================= */

/**
 * Formats the capsule's unlock moment for the waiting/confirmation surface.
 *
 * Presentation only: reads the already-validated `openAt` (UTC millis) that
 * arrived with the hold state and renders it in the creator's locale. No
 * authority, no boundary check, no crypto — the canonical trusted-time
 * comparison happens elsewhere and is untouched.
 */
function formatUnlockMoment(openAt: number): string {
  const date = new Date(openAt);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
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
  creatorIdentityId?: string | null;
  creatorCreditId?: string | null;
  storagePaymentId?: string | null;
}>;


/* ================= ERROR DETAIL (diagnosability) ================= */

/**
 * Derives a SHORT, human-readable technical reason for a publish
 * failure from the error preserved across the seal retry loop.
 *
 * Rationale: the retry loop previously discarded the real error in a
 * bare `catch {}`, so production showed only generic copy and no
 * incident could be localised without screenshot forensics. This
 * helper turns whatever was thrown into a bounded, safe-to-display
 * string — it NEVER exposes key material (crypto helpers throw codes,
 * not secrets) and truncates to keep the UI within its bounds.
 *
 * Returns undefined when there is nothing useful to show, so ordinary
 * failures keep exactly the previous UI.
 */
export function sealErrorDetail(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;

  let raw: string;
  if (value instanceof Error) {
    raw = value.message || value.name;
  } else if (typeof value === "string") {
    raw = value;
  } else {
    try {
      raw = JSON.stringify(value);
    } catch {
      raw = String(value);
    }
  }

  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  // Bounded: one short line, never a dump.
  const MAX = 300;
  return trimmed.length > MAX
    ? `${trimmed.slice(0, MAX)}…`
    : trimmed;
}


/* ================= UPLOAD-TOKEN RETRY CLASSIFICATION ================= */

/**
 * Upload-token failure carrying the HTTP outcome of the request.
 *
 * The retry decision is made on the HTTP STATUS, never on the error text:
 * classifying by message text silently retried every 4xx whose body carried
 * a code the client did not hardcode (a bare 400, 415 or 429), which
 * contradicts the fail-closed policy and wastes the creator's time on an
 * outcome that can never change.
 *
 * Policy:
 *   4xx (400-499)              -> deterministic, NEVER retried
 *   2xx/3xx without a token    -> protocol violation, NEVER retried
 *   5xx (500-599)              -> transient, retried
 *   fetch/network exception    -> no status, retried
 */
interface UploadTokenRequestError extends Error {
  httpStatus?: number;
}

function uploadTokenError(
  message: string,
  httpStatus?: number
): UploadTokenRequestError {
  const error = new Error(message) as UploadTokenRequestError;
  if (typeof httpStatus === "number") error.httpStatus = httpStatus;
  return error;
}

/**
 * True when the failure is worth retrying.
 *
 * Only 5xx responses and transport failures (which carry no status) are
 * retryable. Any definite non-5xx HTTP answer we actually received — 2xx
 * included, because a 2xx without a usable token is a protocol violation,
 * not a transient condition — fails closed immediately.
 */
function isRetryableUploadTokenFailure(error: unknown): boolean {
  const httpStatus =
    error instanceof Error
      ? (error as UploadTokenRequestError).httpStatus
      : undefined;

  if (typeof httpStatus !== "number") return true; // network/fetch failure
  return httpStatus >= 500;
}


/* ================= RECOVERY VALIDATION ================= */

// Strict shape-check for sessionStorage recovery payload.
// Every field that downstream STEP 4 integrity guards / sealCapsuleCore
// rely on must be validated here — a partially-valid object would
// otherwise pass through and fail later with a less clear error.
//
// F-5 — IDENTITY BINDING.
//
// The payload is a RECOVERY record for one specific capsule, so the
// record's capsuleId is bound to the route capsuleId that the caller
// is currently recovering. A shape-only check would accept a
// same-origin record belonging to a DIFFERENT capsule (poisoned,
// stale, or left over from another identity) and fold another
// capsule's secret material into this runtime. Any mismatch fails
// closed — the caller then falls back to the fail-closed guard in
// CapsuleHold and re-preparation is permitted, exactly as when no
// record exists at all.
//
// Mirrors the identity binding already enforced by
// CapsuleBuilder.restorePreparedFromSession().
function isValidSessionCapsuleData(
  parsed: unknown,
  expectedCapsuleId: string
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

    // F-5 — identity binding: the record must belong to the capsule
    // being recovered, not merely be a structurally valid record.
    p.capsuleId === expectedCapsuleId &&

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

  const { resetCapsule, capsuleId: sessionCapsuleId } = useCapsule();

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
      /**
       * Underlying failure reason (code or message). Optional and
       * additive: it NEVER replaces the human-readable message — it is
       * rendered as a secondary, collapsible technical detail so a
       * production publish failure is diagnosable instead of opaque.
       *
       * `undefined` is explicitly allowed because the deriver
       * (`sealErrorDetail`) returns `undefined` when there is nothing
       * useful to say — under `exactOptionalPropertyTypes` a bare
       * `detail?: string` would reject that valid value.
       */
      detail?: string | undefined;
    } | null>(null);


  const [retryNonce, setRetryNonce] =
    useState(0);


  // @ts-expect-error Phase 2B storage-payment UI state: intentionally declared; render integration pending
    const [storagePaymentState, setStoragePaymentState] =
      useState<
        | "idle"
        | "preparing"
        | "quoting"
        | "quote_ready"
        | "paying"
        | "verifying"
        | "verified"
        | "error"
      >("idle");


    // @ts-expect-error Phase 2B storage quote state: intentionally declared; render integration pending
    const [storageQuote, setStorageQuote] =
      useState<{
        storagePaymentId: string;
        expectedAmountAtomic: string;
        displayAmountUSDC: string;
        irysDestination: string;
        expiresAt: number;
      } | null>(null);


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

  const creatorIdentityId =
    locationState?.creatorIdentityId ?? null;

  /**
   * OPTIONAL authoritative-read address for /api/upload-token.
   *
   * Correlation only — it is NOT authority: the server reads the Creator
   * Credit from the authoritative store and re-validates every field. It is
   * omitted from the request body when absent so that legacy/recovery paths
   * keep the existing server behaviour.
   */
  const creatorCreditId =
    locationState?.creatorCreditId ?? null;

  const connectedWallet = useContext(AETERNAWalletContext);
  const storagePaymentId = locationState?.storagePaymentId ?? null;


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
          // F-5 — the recovery record must be bound to the capsule this
          // creator session is actually working on. A record belonging
          // to any other capsuleId is not usable here and fails closed.
          if (
            isValidSessionCapsuleData(
              parsed,
              sessionCapsuleId
            )
          ) {
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
      !canonicalLifecycleId ||
      !creatorIdentityId ||
      !storagePaymentId
    ) {

      navigate(
        "/",
        { replace: true }
      );

    }

  }, [
    holdState,
    canonicalLifecycleId,
    creatorIdentityId,
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
      !creatorIdentityId ||
      !storagePaymentId ||
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

        /**
         * FOREIGN LOCK — a DIFFERENT lifecycle still owns this tab's
         * seal lock.
         *
         * The lock is deliberately NOT superseded automatically: the
         * previous lifecycle's async work may still be in flight after
         * its unmount, so silently taking the lock over could allow two
         * seal flows in one tab. This flow therefore refuses to start.
         *
         * It MUST NOT return silently either: a silent return leaves
         * the creator on the non-error "Finalizing your capsule…"
         * screen forever — no request, no error, and (because the error
         * screen is the only recovery surface) no TRY AGAIN.
         *
         * The existing error/recovery UI is surfaced instead. Recovery
         * stays explicit and user-driven: `handleRetry()` removes the
         * lock and re-runs this effect, after which the current
         * lifecycle claims the lock through the unchanged normal path.
         *
         * Diagnostic detail carries ONLY the two lifecycle identifiers
         * (non-secret, server-issued ids). No secret, key, or plaintext
         * is read or surfaced here.
         */
        console.error(
          "[AETERNA] Seal session needs to be restarted: a previous capsule session is still registered in this tab."
        );

        setError({

          title:
            "Please try again",

          message:
            "A previous capsule session is still open in this tab.\n\nPress Try Again to start a fresh session for this capsule.",

          detail:
            sealErrorDetail(
              `stale seal lock: ${existingLock} !== ${canonicalLifecycleId}`
            ),

        });

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

        /**
         * Preserves the MOST RECENT underlying seal failure so the outer
         * handler can surface a diagnosable reason instead of only the
         * generic copy. Never used for control flow — the retry logic
         * below is unchanged.
         *
         * Declared at FUNCTION scope, NOT inside the STEP 5 `try` block:
         * the outer `catch` below reads it, and a `let` declared inside
         * that `try` is not visible there. When it was block-scoped, the
         * failure handler itself threw `ReferenceError: lastSealError is
         * not defined`, so the original seal error was never surfaced and
         * the creator was left on the waiting screen forever.
         */
        let lastSealError:
          unknown =
          null;

        /**
         * Upload token, hoisted to FUNCTION scope so the bounded retry
         * below can assign it and the later seal call can read it. The
         * value is only ever used AFTER the retry resolves successfully,
         * so a failed retry can never leak a stale/undefined token into
         * the seal path (which is exactly what `throw` after the loop
         * guarantees).
         */
        let uploadToken:
          string | null =
          null;

        try {

          /* ── STEP 1: canonical upload token ── */

          /**
           * BOUNDED retry (3 attempts, exponential backoff) for
           * RETRYABLE conditions only: network errors and HTTP 5xx.
           *
           * HTTP 4xx (including 403 and 409) are NEVER retried — they are
           * deterministic authorization failures that will return the same
           * response on every attempt. Retrying them would only delay the
           * failure surface and waste bandwidth.
           *
           * Why this is safe:
           *
           * - The endpoint is IDEMPOTENT with respect to entitlement:
           *   /api/upload-token only READS the persisted Creator Credit
           *   (status must be CONSUMING) and the PAYMENT_VERIFIED storage
           *   payment, then mints a NEW random short-lived token. It never
           *   consumes the credit, never creates a quote, never charges,
           *   and never reserves a lifecycle. A repeat therefore cannot
           *   duplicate a payment, entitlement, reservation or capsule.
           *
           * - A retry MUST NOT turn a fail-closed decision into a success.
           *   It cannot: 4xx errors fail immediately, and only transient
           *   5xx/network conditions are retried. If the condition persists
           *   across all 3 attempts, the loop exhausts and throws —
           *   fail-closed is preserved exactly.
           */
          let tokenAttempt = 0;

          while (tokenAttempt < 3) {

            try {

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
                        // Canonical upload-token contract
                        // (functions/api/upload-token.ts ALLOWED_BODY_FIELDS):
                        // the creator is identified by creatorIdentityId, NOT by
                        // capsuleId. The endpoint resolves capsule/lifecycle
                        // authority server-side from the CONSUMING Creator
                        // Credit; a client-supplied capsuleId is neither
                        // accepted nor authority.
                        creatorIdentityId,
                        canonicalLifecycleId,
                        // Authoritative-read address (optional). Present => the
                        // server reads the credit from the Durable Object
                        // instead of the eventually-consistent KV projection.
                        // Omitted when unavailable so the legacy KV path is
                        // preserved byte-for-byte.
                        ...(creatorCreditId
                          ? { creatorCreditId }
                          : {}),
                        correlationTransactionId:
                          correlationTransactionId ?? "",
                      }),
                  }
                );

              /**
               * 4xx = deterministic client/auth failure.
               * Never retry — fail closed immediately so the creator
               * sees the failure surface with the diagnostic code.
               *
               * The status is carried on the error; the retry decision is
               * never derived from the response body or the error text, so
               * an unrecognised code (a bare 400, 415, 429, …) can never be
               * retried.
               */
              if (
                tokenRes.status >= 400 &&
                tokenRes.status < 500
              ) {
                const errBody =
                  await tokenRes.json().catch(() => null);
                const code =
                  errBody?.error ??
                  "UPLOAD_TOKEN_DENIED";
                throw uploadTokenError(code, tokenRes.status);
              }

              if (!tokenRes.ok)
                throw uploadTokenError(
                  "UPLOAD_TOKEN_REQUEST_FAILED",
                  tokenRes.status
                );

              const tokenData =
                await tokenRes.json().catch(() => null);

              const candidate =
                tokenData?.uploadToken;

              if (
                typeof candidate !==
                  "string" ||
                candidate.length < 32
              )
                throw uploadTokenError(
                  "UPLOAD_TOKEN_DENIED",
                  tokenRes.status
                );

              uploadToken =
                candidate;

              break;

            } catch (tokenErr) {

              const err =
                tokenErr instanceof Error
                  ? tokenErr
                  : new Error(String(tokenErr));

              /**
               * Retry decision — driven by the HTTP STATUS only:
               *   4xx                      -> never retry
               *   2xx/3xx (malformed reply) -> never retry
               *   5xx                      -> retry
               *   no status (fetch/network) -> retry
               *
               * The error text is never consulted, so a 4xx whose body
               * carries a code the client does not know still fails closed
               * on the first attempt.
               */
              if (!isRetryableUploadTokenFailure(err))
                throw err;

              tokenAttempt++;

              /**
               * Fail-closed on the FINAL attempt: after the bounded
               * retries are exhausted the original error is re-thrown, so
               * a persistent server failure is never masked.
               */
              if (tokenAttempt >= 3)
                throw err;

              await new Promise(
                (r) =>
                  setTimeout(
                    r,
                    1000 *
                      Math.pow(
                        2,
                        tokenAttempt
                      )
                  )
              );

            }

          }

          if (uploadToken === null)
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

                // Phase D2b — Creator-paid storage adapter (upload-only:
                // the Irys storage payment is already PAYMENT_VERIFIED).
                if (!connectedWallet?.wallet?.account) {
                  throw new Error("STORAGE_WALLET_UNAVAILABLE");
                }
                const creatorStorage = createCreatorIrysStorage({
                  wallet: toCreatorIrysWallet(connectedWallet.wallet),
                  creatorIdentityId,
                  lifecycleId: canonicalLifecycleId,
                  capsuleId: holdState.prepared.capsuleId,
                  storagePaymentId,
                });

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

                    canonicalLifecycleId,

                    creatorIdentityId,

                    storage: creatorStorage,

                    runtime,

                    chunkMetadata:
                      holdState.prepared.chunkMetadata,

                  });

                break;

              } catch (sealErr) {

                // Keep the reason. The retry policy is unchanged; only
                // the previously-discarded error is now retained so a
                // production failure is diagnosable.
                lastSealError =
                  sealErr;

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


          // While finalization is pending, the prepared capsule and
          // seal lock must survive: re-entry resolves holdState from
          // sessionStorage and reaches the persisted-manifest reuse
          // path, whose idempotent seal/verify + finalize completes
          // the credit. Full success keeps the existing cleanup.
          if (!result.finalizationPending) {

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

          }


          /* ── STEP 7: redirect ── */

          setSealed(true);

          // Finalization is idempotent server-side. A pending finalize
          // after a successful seal never blocks the user: the credit
          // completes on the next idempotent retry (re-entry or a later
          // session) — never a failure screen for the sealed capsule.
          if (result.finalizationPending) {
            try {
              sessionStorage.setItem(
                `aeterna-finalize-pending:${result.capsuleId}`,
                canonicalLifecycleId
              );
            } catch {
              // Intentional no-op: marker is best-effort.
            }
          }

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

          /**
           * Canonical post-seal navigation, taken AFTER the seal is fully
           * complete and the capsule has been reset.
           *
           * The creator ALWAYS lands directly on CapsuleView: the
           * confirmationLink is `/capsule/:capsuleId` (the canonical
           * CapsuleView destination) and is navigated to UNCONDITIONALLY.
           * There is deliberately no future-unlock special case — the
           * waiting page is the only pre-success surface, and the capsule
           * page is the only post-success surface.
           *
           * This is a RENDER decision only: the seal result, the lifecycle,
           * the entitlement and the storage are exactly as before.
           */
          navigate(
            result.confirmationLink,
            {
              replace: true,
            }
          );

        }

        catch (err) {

          // Always log the underlying failure (not only in DEV): a
          // production publish failure must leave a diagnosable trace in
          // the browser console. No secrets are logged — the error
          // carries a code/message, never key material.
          console.error(
            "[AETERNA] Critical sealing error:",
            err,
            lastSealError
          );

          try {

            sessionStorage.removeItem(
              sealLockKey
            );

          } catch {
        // ignore
      }


          startedRef.current =
            false;

          // Derive a SHORT, human-readable technical reason from the
          // preserved underlying error. The generic copy above stays the
          // primary message; this is secondary detail only.
          const derivedDetail =
            sealErrorDetail(
              lastSealError ?? err
            );

          setError({

            title:
              "We couldn't finish preparing your capsule",

            message:
              "Your payment was successful and nothing has been lost.\n\nPress Try Again to continue preparing your capsule.",

            detail:
              derivedDetail,

          });

        }

      };


    finalizeSealing();

    return markUnmounted;

  }, [
  holdState,
  canonicalLifecycleId,
  creatorIdentityId,
  storagePaymentId,
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

            <h1 className="text-3xl font-display tracking-wide">

              {error.title}

            </h1>

            <p className="text-muted-foreground text-base leading-relaxed whitespace-pre-line">

              {error.message}

            </p>

            {error.detail && (

              <details className="text-left pt-2">

                <summary className="cursor-pointer text-xs uppercase tracking-wider text-muted-foreground/70 select-none">

                  Technical details

                </summary>

                <p className="aeterna-error-notice mt-2 p-3 rounded-md bg-red-500/10 border border-red-500/20 text-xs text-red-500/90 font-mono">

                  {error.detail}

                </p>

              </details>

            )}

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

      <div className="relative z-10 text-center space-y-8 px-6 max-w-md">

        <div className="mx-auto w-16 h-16 rounded-full bg-emerald-500/10 flex items-center justify-center border border-emerald-500/20">

          <Lock
            className="text-emerald-500"
            size={28}
          />

        </div>

        <h1 className="text-4xl font-display tracking-wide">

          Capsule is being prepared

        </h1>

        <div className="space-y-3">

          <p className="text-muted-foreground text-base leading-relaxed">

            Your payment is confirmed. We're now preparing and publishing
            your capsule — this usually takes a moment.

          </p>

          <p className="text-muted-foreground/70 text-sm leading-relaxed">

            Please keep this window open until it finishes.

          </p>

        </div>

        <div className="flex items-center justify-center gap-2 text-emerald-500">

          <Loader2
            className="animate-spin"
            size={16}
          />

          <span className="text-xs tracking-wide text-muted-foreground/70">

            Working…

          </span>

        </div>

        {formatUnlockMoment(holdState.openAt) && (

          <div className="pt-2 space-y-1">

            <p className="text-xs text-muted-foreground/60 tracking-wide">

              Unlock date

            </p>

            <p className="text-base text-emerald-500 font-medium tracking-wide">

              {formatUnlockMoment(holdState.openAt)}

            </p>

          </div>

        )}

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