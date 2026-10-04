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
  /* The Irys uploader BUILD boundary — before any uploadData call */
  | "CONTAINER_UPLOADER_BUILD"
  | "CONTAINER_UPLOADER_RPC"
  /* Later sealing stages */
  | "VAULT_UPLOAD"
  | "PUBLICATION_VERIFY"
  | "SEAL_API"
  | "SEAL_VERIFY"
  | "FINALIZE_CREDIT"
  /* No boundary classified it */
  | "SEAL_UNKNOWN";

/**
 * Bounded, NON-SECRET sub-classification of a failure inside the Irys
 * uploader build boundary (`buildCreatorChunkingUploader`).
 *
 * Every member is a fixed literal — never derived from a payload.
 */
export type ContainerBuildCategory =
  /** The injected wallet/provider does not have the required shape. */
  | "BUILD_ADAPTER"
  /** The built uploader does not expose the streaming surface AETERNA drives. */
  | "BUILD_CONFIG"
  /** No usable same-origin Solana RPC transport. */
  | "BUILD_RPC_TRANSPORT"
  /** A Solana JSON-RPC / application-level error (numeric code present). */
  | "BUILD_RPC_ERROR"
  /** `builder.build()` threw or returned nothing. */
  | "BUILD_SDK"
  /** Anything else on that boundary. */
  | "BUILD_UNKNOWN";

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

/* ── Irys uploader BUILD boundary ────────────────────────────────────
 *
 * `creatorIrysStorage.uploadContainer()` builds the Irys uploader BEFORE
 * it uploads anything. Every throw on that boundary used to be untagged,
 * so it collapsed into CONTAINER_UPLOAD_UNKNOWN and the real cause was
 * lost. These helpers classify it without retaining any payload.
 */

/** Property carrying the bounded build sub-classification. */
export const BUILD_CATEGORY_PROPERTY = "sealBuildCategory";

/** Property carrying a numeric JSON-RPC error code (safe: a number). */
export const RPC_CODE_PROPERTY = "sealRpcCode";

/**
 * Attaches a NON-SECRET diagnostic property. Values are fixed literals or
 * plain numbers only — never a message, body, token, key or signature.
 */
function defineDiagnosticProperty(
  error: Error,
  name: string,
  value: string | number
): void {
  Object.defineProperty(error, name, {
    value,
    enumerable: true,
    writable: false,
    configurable: false,
  });
}

/**
 * Numeric JSON-RPC error code, when the failure carries one.
 *
 * Recognised shapes (read-only; nothing is retained):
 *   • `@solana/web3.js` `SolanaJSONRPCError` — `.code` IS the JSON-RPC code;
 *   • a bare numeric `.code` that is NEGATIVE — JSON-RPC error codes are
 *     negative, so an unrelated POSITIVE numeric `code` is not mistaken
 *     for an RPC failure;
 *   • `data.error.code`.
 *
 * Returns the NUMBER only — never a message, data blob, header or URL.
 */
export function jsonRpcErrorCode(error: unknown): number | null {
  if (error === null || typeof error !== "object") return null;

  const candidate = error as Record<string, unknown>;

  const own = candidate["code"];
  if (
    typeof own === "number" &&
    Number.isInteger(own) &&
    (candidate["name"] === "SolanaJSONRPCError" || own < 0)
  ) {
    return own;
  }

  const data = candidate["data"];
  if (data !== null && typeof data === "object") {
    const nested = (data as Record<string, unknown>)["error"];
    if (nested !== null && typeof nested === "object") {
      const nestedCode = (nested as Record<string, unknown>)["code"];
      if (typeof nestedCode === "number" && Number.isInteger(nestedCode)) {
        return nestedCode;
      }
    }
  }

  return null;
}

/**
 * The SDK's own provider-shape signature: `InjectedSolanaSigner` throws
 * this when the injected provider has no `publicKey`. Anchored and
 * bounded; the message is never retained.
 */
const ADAPTER_SHAPE_IN_MESSAGE = /provider\.publicKey is undefined/;

/**
 * Returns the failure to propagate for the Irys uploader BUILD boundary.
 *
 * Fires ONLY for failures raised BEFORE `buildCreatorChunkingUploader`
 * returns. A more precise tag already present is never overwritten.
 *
 * The propagated Error carries the fixed public message, the code
 * (`CONTAINER_UPLOADER_RPC` when a numeric JSON-RPC code is present, else
 * `CONTAINER_UPLOADER_BUILD`), a bounded category, and — for an RPC
 * failure — the numeric code. No message, body, token, key, signature or
 * plaintext is ever attached.
 */
export function tagContainerBuildFailure(
  error: unknown,
  category: ContainerBuildCategory
): Error {
  const existing = readSealDiagnostic(error);
  if (existing !== null && existing !== WALLET_SIGN_FAILURE) {
    // A precise inner classification already exists — keep it.
    return error as Error;
  }

  const rpcCode = jsonRpcErrorCode(error);

  let resolvedCategory: ContainerBuildCategory = category;
  if (rpcCode !== null) {
    resolvedCategory = "BUILD_RPC_ERROR";
  } else if (category === "BUILD_UNKNOWN") {
    const message =
      error !== null && typeof error === "object"
        ? (error as { message?: unknown }).message
        : undefined;
    if (
      typeof message === "string" &&
      message.length <= 500 &&
      ADAPTER_SHAPE_IN_MESSAGE.test(message)
    ) {
      resolvedCategory = "BUILD_ADAPTER";
    }
  }

  const code: SealDiagnosticCode =
    rpcCode !== null ? "CONTAINER_UPLOADER_RPC" : "CONTAINER_UPLOADER_BUILD";

  const tagged = new Error(`${SEAL_FAILURE_MESSAGE}: ${code}`);

  defineDiagnosticProperty(tagged, DIAGNOSTIC_PROPERTY, code);
  defineDiagnosticProperty(tagged, BUILD_CATEGORY_PROPERTY, resolvedCategory);
  if (rpcCode !== null) {
    defineDiagnosticProperty(tagged, RPC_CODE_PROPERTY, rpcCode);
  }

  return tagged;
}
