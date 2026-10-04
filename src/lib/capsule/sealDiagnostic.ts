/**
 * AETERNA — seal-failure diagnostics.
 *
 * The sealing pipeline collapsed EVERY failure into one shared,
 * stack-less `Error("[AETERNA] Capsule sealing failed")`, so a
 * production incident could not be localised (the 2026-10-04 container
 * upload failure is the recorded example).
 *
 * This module carries a bounded, NON-SECRET stage code alongside the
 * failure so the operator can see WHERE it happened.
 *
 * INVARIANTS
 * ----------
 *  • A code is a fixed enum member. It is never derived from a message,
 *    request/response body, token, key, signature, pointer or plaintext.
 *  • `tagSealFailure` NEVER replaces a precise tag that is already
 *    present — the innermost boundary wins. The original failure is
 *    therefore classified BEFORE anything is masked.
 *  • The original exception is never attached, logged or surfaced: only
 *    the fixed public message and the code travel with the failure.
 */

export type SealDiagnosticCode =
  /* Container V1 upload, sub-stages A–F */
  | "CONTAINER_UPLOAD_CONSTRUCT"
  | "CONTAINER_UPLOAD_SIGN"
  | "CONTAINER_UPLOAD_SIGNED"
  | "CONTAINER_UPLOAD_HTTP"
  | "CONTAINER_UPLOAD_RECEIPT"
  | "CONTAINER_UPLOAD_UNKNOWN"
  | "CONTAINER_PUBLICATION"
  /* Later sealing stages */
  | "VAULT_UPLOAD"
  | "PUBLICATION_VERIFY"
  | "SEAL_API"
  | "SEAL_VERIFY"
  | "FINALIZE_CREDIT"
  /* No boundary classified it */
  | "SEAL_UNKNOWN";

/**
 * NEUTRAL, CONTEXT-FREE inner tag: the injected wallet rejected a
 * signing request (message or transaction).
 *
 * It is produced by the wallet adapter, which is shared by the vault and
 * the container upload and therefore cannot know which one it serves.
 * `tagSealFailure` REPLACES this neutral tag with the calling boundary's
 * stage code, so it never reaches the operator as a final code.
 */
export const WALLET_SIGN_FAILURE = "WALLET_SIGN_FAILURE" as const;

/** The canonical, non-secret public message. */
export const SEAL_FAILURE_MESSAGE =
  "[AETERNA] Capsule sealing failed";

/**
 * Any code a boundary may attach: a final stage code, or the neutral
 * context-free wallet tag that a context-owning boundary replaces.
 */
export type SealDiagnosticTag = SealDiagnosticCode | typeof WALLET_SIGN_FAILURE;

const DIAGNOSTIC_PROPERTY = "sealDiagnostic";

/** Reads the diagnostic code carried by a failure, if any. */
export function readSealDiagnostic(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;

  const value = (error as Record<string, unknown>)[DIAGNOSTIC_PROPERTY];

  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Resolves which code the failure should finally carry.
 *
 * A precise tag already present wins; the neutral wallet tag (and the
 * absence of a tag) yield the caller's stage code.
 */
export function resolveSealDiagnostic(
  error: unknown,
  code: SealDiagnosticTag
): string {
  const existing = readSealDiagnostic(error);

  if (existing === null || existing === WALLET_SIGN_FAILURE) return code;

  return existing;
}

/**
 * Returns the failure to propagate for a diagnosed stage.
 *
 * The returned Error carries ONLY the fixed public message plus the
 * resolved code — never the original exception, its message, or any
 * payload it may hold. Behaviour (throw / fail-closed) is unchanged.
 */
export function tagSealFailure(
  error: unknown,
  code: SealDiagnosticTag
): Error {
  const resolved = resolveSealDiagnostic(error, code);

  const tagged = new Error(`${SEAL_FAILURE_MESSAGE}: ${resolved}`);

  Object.defineProperty(tagged, DIAGNOSTIC_PROPERTY, {
    value: resolved,
    enumerable: true,
    writable: false,
    configurable: false,
  });

  return tagged;
}

/* ── Wallet-sign probe (diagnostic only) ─────────────────────────────
 *
 * A monotonic count of COMPLETED injected-wallet signing calls. It lets
 * the container uploader separate "the SDK failed after a signature was
 * produced" (sub-stage C) from "the SDK failed before any signature".
 *
 * It carries NO secret (an integer), and it NEVER influences control
 * flow — it is read only while building a failure classification.
 */
let walletSignCompleted = 0;

/** Records that one injected-wallet signing call returned successfully. */
export function markWalletSignCompleted(): void {
  walletSignCompleted++;
}

/** Number of successfully completed injected-wallet signing calls. */
export function walletSignCompletedCount(): number {
  return walletSignCompleted;
}

/**
 * Some SDKs surface an HTTP failure ONLY in the message text — the
 * installed Irys SDK throws a bare `Error` whose message begins with
 * `HTTP Error: Finalising upload: 500 ERR` and carries no `status`,
 * `statusCode` or `response`.
 *
 * This pattern extracts the numeric status ONLY. The message itself is
 * never kept, returned, logged or surfaced; the pattern is anchored to a
 * message that STARTS with "HTTP" and is bounded, so it cannot scan an
 * arbitrary body.
 */
const HTTP_STATUS_IN_MESSAGE = /^HTTP(?:\s+Error)?\b[^\n]{0,120}?\b(\d{3})\b/;

/**
 * True when `error` carries an HTTP-shaped signal (status / statusCode /
 * response.status, or an "HTTP …" status message).
 *
 * Used to separate an Irys HTTP rejection (sub-stage D) from a
 * post-signature SDK failure (sub-stage C). Only the numeric status is
 * read — never a body, header, URL or any other payload.
 */
export function hasHttpStatusSignal(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;

  const candidate = error as Record<string, unknown>;

  for (const key of ["status", "statusCode"]) {
    if (typeof candidate[key] === "number") return true;
  }

  const response = candidate["response"];
  if (response !== null && typeof response === "object") {
    const status = (response as Record<string, unknown>)["status"];
    if (typeof status === "number") return true;
  }

  const message = (error as { message?: unknown }).message;
  if (typeof message === "string" && message.length <= 500) {
    return HTTP_STATUS_IN_MESSAGE.test(message);
  }

  return false;
}
