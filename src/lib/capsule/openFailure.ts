/**
 * AETERNA — capsule-open failure classification.
 *
 * =========================================================
 * WHY THIS MODULE EXISTS
 * =========================================================
 *
 * `openCapsule()` historically collapsed EVERY non-success into a
 * generic `SEALED` result. That is correct for the *display*
 * (fail-closed is the canonical outcome) but it made RECOVERY
 * impossible to reason about:
 *
 *   • `CapsuleController.tryOpen` performs a capability-secret
 *     OWNERSHIP HANDOFF — it clears `secretRef.current` before calling
 *     `openCapsule()` — and, before this module existed, the secret was
 *     NEVER restored. A single TRANSIENT infrastructure failure
 *     (trusted-time endpoint blip, gateway timeout, storage read
 *     failure) therefore destroyed the only copy of the capability in
 *     this tab. The 5 s interval / focus / visibility retries then read
 *     an EMPTY ref and could never recover without a full page reload
 *     (which re-parses the capability from the URL fragment) — the
 *     intermittent "SEALED and stuck" production defect.
 *
 * The fix needs to answer ONE question about a failure:
 *
 *     "Is it safe to KEEP the capability and let the existing retry
 *      mechanism try again?"
 *
 * …and it must answer it WITHOUT weakening validation, without
 * bypassing `getTrustedTime()` / `effectiveOpenAt`, without touching
 * AES-GCM authentication or vault integrity, and without letting a
 * genuinely closed capsule open.
 *
 * =========================================================
 * THE THREE CLASSES
 * =========================================================
 *
 *   • "retryable"   — the OPEN decision was never made: trusted time or
 *                     the vault bytes could not be obtained. Keeping the
 *                     capability and retrying is the only correct
 *                     behaviour. NOTHING was decrypted.
 *
 *   • "not-open"    — trusted time AUTHORITATIVELY confirmed
 *                     `nowUtc < effectiveOpenAt`. The capsule IS sealed.
 *                     There is no failure and nothing to retry; the SEALED
 *                     card is the truthful outcome.
 *
 *   • "terminal"    — the capability is invalid, AES-GCM authentication
 *                     failed, or vault integrity/size continuity was
 *                     violated. These must NEVER yield opened content and
 *                     MUST NOT be retried: a persistent capability bug
 *                     would otherwise re-run PBKDF2 + AES-GCM forever, and
 *                     a recovered-by-retry integrity failure is by
 *                     definition not a recovery.
 *
 * =========================================================
 * FAIL-CLOSED DEFAULT
 * =========================================================
 *
 * An unclassifiable failure resolves to "retryable" (with a documented
 * uncertainty note). This is the fail-closed choice for CAPABILITY
 * HANDLING — it preserves the capability — but NOT for AUTHORIZATION:
 * the retry still re-runs the FULL pipeline, so a closed capsule remains
 * closed and an invalid capability remains invalid. Worst case is a
 * bounded, existing 5 s retry cadence, never content disclosure.
 *
 * =========================================================
 * NON-SECRET BY CONSTRUCTION
 * =========================================================
 *
 * Classification reads ONLY fixed signal keys — a typed `severity`
 * carried by a `CapsuleOpenError`, or a bounded `code`/`name`. It never
 * reads a message body, a URL, a token, a key, a pointer, or any
 * plaintext. Nothing it reads is logged, transmitted, or URL-encoded.
 */

/**
 * Terminal sub-classification, when the source can provide it.
 * Every member is a fixed literal — never derived from a payload.
 */
export type CapsuleOpenTerminalReason =
  /** The capability secret / manifest identity is not acceptable. */
  | "INVALID_CAPABILITY"
  /**
   * Manifest metadata is malformed (e.g. an unusable storage pointer or
   * an out-of-range heartbeat interval). Distinct from
   * `INVALID_CAPABILITY`: the rejection is about the CAPSULE's public
   * metadata, not about the presented capability secret. Terminal —
   * retrying the same immutable manifest can never succeed.
   */
  | "INVALID_MANIFEST"
  /** AES-GCM authentication (or cryptographic envelope) failure. */
  | "CRYPTO_FAILURE"
  /** Vault integrity / size-continuity violation. */
  | "INTEGRITY_VIOLATION";

export type CapsuleOpenFailureClass =
  /** Safe to retain the capability and retry the FULL pipeline. */
  | "retryable"
  /** Trusted time authoritatively says the capsule is still closed. */
  | "not-open"
  /** Must never open and must not be retried. */
  | "terminal";

/**
 * Property carrying a NON-SECRET severity, mirroring the
 * `sealDiagnostic` posture: a fixed literal, never a payload.
 */
const SEVERITY_PROPERTY = "capsuleOpenSeverity";

const REASON_PROPERTY = "capsuleOpenReason";

type Severity = CapsuleOpenFailureClass;

/**
 * A typed capsule-open failure.
 *
 * The public message is FIXED and carries no capability material. The
 * `severity` and `reason` are fixed literals. This is deliberately the
 * only failure shape the classifier needs to understand; anything else
 * is classified defensively.
 */
export class CapsuleOpenError extends Error {
  readonly severity: Severity;

  readonly reason: string;

  constructor(
    severity: Severity,
    reason: string,
    message: string
  ) {
    super(message);
    this.name = "CapsuleOpenError";
    this.severity = severity;
    this.reason = reason;

    Object.defineProperty(this, SEVERITY_PROPERTY, {
      value: severity,
      enumerable: true,
      writable: false,
      configurable: false,
    });

    Object.defineProperty(this, REASON_PROPERTY, {
      value: reason,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
}

/** Retryable: trusted time / network / gateway / transient read failure. */
export function retryableOpenError(reason: string): CapsuleOpenError {
  return new CapsuleOpenError(
    "retryable",
    reason,
    "[AETERNA] Capsule open failed (retryable)"
  );
}

/** Not-yet-open: trusted time confirmed the capsule is still sealed. */
export function notOpenError(reason: string): CapsuleOpenError {
  return new CapsuleOpenError(
    "not-open",
    reason,
    "[AETERNA] Capsule is sealed"
  );
}

/**
 * Terminal: invalid capability, AES-GCM authentication failure, or a
 * confirmed integrity violation. Must never open and must never be
 * retried (a persistent capability bug would otherwise re-run PBKDF2 +
 * AES-GCM forever).
 */
export function terminalOpenError(
  reason: CapsuleOpenTerminalReason
): CapsuleOpenError {
  return new CapsuleOpenError(
    "terminal",
    reason,
    "[AETERNA] Capsule open failed (terminal)"
  );
}

/**
 * Return the failure to propagate from a capsule-open boundary.
 *
 * Mirrors `sealDiagnostic.tagSealFailure`: a more precise typed
 * severity already present is NEVER overwritten (innermost boundary
 * wins), so a terminal cryptographic failure raised deep in
 * `decryptVault` cannot be re-tagged as retryable by an outer layer.
 *
 * The returned error carries ONLY a fixed, non-secret literal — never a
 * message body, payload, pointer, key, or plaintext.
 */
export function tagOpenFailure(
  error: unknown,
  severity: CapsuleOpenFailureClass,
  reason: string
): CapsuleOpenError {
  // A precise typed severity already present wins.
  const existing = readSeverity(error);
  if (existing !== null) return error as CapsuleOpenError;

  // A precise legacy terminal code already present wins.
  if (readTerminalSignal(error)) {
    return new CapsuleOpenError(
      "terminal",
      reason,
      "[AETERNA] Capsule open failed (terminal)"
    );
  }

  return new CapsuleOpenError(
    severity,
    reason,
    severity === "terminal"
      ? "[AETERNA] Capsule open failed (terminal)"
      : severity === "not-open"
        ? "[AETERNA] Capsule is sealed"
        : "[AETERNA] Capsule open failed (retryable)"
  );
}

/* ── Signal readers (read-only; nothing retained) ──────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/**
 * Reads the fixed severity literal attached by a `CapsuleOpenError`
 * (or any future structural equivalent). Returns null when absent or
 * not one of the three known members.
 */
function readSeverity(value: unknown): Severity | null {
  if (!isRecord(value)) return null;

  const raw = (value as Record<string, unknown>)[SEVERITY_PROPERTY];

  if (raw === "retryable" || raw === "not-open" || raw === "terminal") {
    return raw;
  }

  // Structural fallback: an instance is still recognisable without the
  // property (e.g. after a cross-realm structured clone of the message).
  if (value instanceof CapsuleOpenError) return value.severity;

  return null;
}

/**
 * A bounded, NON-SECRET categorical read.
 *
 * Only fixed, pre-declared tokens are accepted. A free-form message is
 * never used as a category — this is the explicit guard against the
 * "brittle string matching" failure mode while still recognising the
 * legacy `code`/`name` channel used by the existing terminal paths
 * (`INVALID_SECRET`).
 */
const TERMINAL_CODES = new Set([
  "INVALID_SECRET",
  "INVALID_CAPABILITY",
  "INVALID_MANIFEST",
  "CRYPTO_FAILURE",
  "INTEGRITY_VIOLATION",
]);

function readTerminalSignal(value: unknown): boolean {
  if (!isRecord(value)) return false;

  const rec = value as Record<string, unknown>;

  for (const key of ["code", "name"] as const) {
    const token = rec[key];
    if (typeof token === "string" && TERMINAL_CODES.has(token)) {
      return true;
    }
  }

  return false;
}

/**
 * Classify a failure raised on the capsule-open path.
 *
 * Reads ONLY fixed, non-secret signals. Never inspects a message body.
 * Defaults to "retryable" (fail-closed for capability retention) when
 * no reliable signal is present.
 */
export function classifyOpenFailure(
  error: unknown
): CapsuleOpenFailureClass {
  const severity = readSeverity(error);

  if (severity !== null) return severity;

  // A typed terminal signal on the legacy `code`/`name` channel — e.g.
  // the canonical `INVALID_SECRET` raised by the open boundary.
  if (readTerminalSignal(error)) return "terminal";

  // Everything else (network, abort, gateway, transient read,
  // unclassifiable): retain the capability and let the EXISTING bounded
  // retry mechanism attempt the FULL pipeline again.
  return "retryable";
}

/**
 * Confidence note for the fail-closed default.
 *
 * Exposed so callers/tests can document WHICH failures could not be
 * classified confidently. It never influences control flow.
 */
export function isClassificationCertain(error: unknown): boolean {
  return readSeverity(error) !== null || readTerminalSignal(error);
}
