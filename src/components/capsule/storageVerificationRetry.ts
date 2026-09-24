/**
 * AETERNA — storage payment verification retry (VERIFY-ONLY).
 *
 * The creator pays Irys directly with USDC, then the server verifies that
 * payment. Two safety rules govern what may happen around that verification:
 *
 *  1. A storagePaymentId is funded AT MOST ONCE. Once a funding signature is
 *     recorded, re-entering the flow must verify that existing payment rather
 *     than pay again.
 *  2. Retrying verification may ONLY call /api/storage/verify-payment. It never
 *     funds, never signs, and never uploads.
 *
 * A `TRANSACTION_PENDING` outcome (the chain knows the signature but the RPC
 * provider could not serve it yet) is the one case worth retrying; every other
 * outcome is terminal.
 *
 * Kept as its own module so the create-flow component stays focused on state,
 * and so these decision points are directly unit-testable.
 */

export interface StorageFundingLedger {
  readonly storagePaymentId: string;
  readonly fundingSignature: string;
}

/**
 * sessionStorage key prefix for the funding ledger.
 *
 * Only ONE fact is persisted per payment — the storagePaymentId and the
 * funding transaction signature it was paid with. No keys, no wallet secrets,
 * no capsule data.
 *
 * sessionStorage (not localStorage) is deliberate: the ledger is scoped to one
 * browser tab/session, so it survives a reload of this tab but cannot leak into
 * another session or another tab, and it disappears when the tab closes.
 */
export const FUNDING_LEDGER_KEY_PREFIX = "aeterna.storage-funding-signature.";

/**
 * Shape check for a Solana transaction signature: base58 (which excludes
 * 0, O, I and l) of a 64-byte value, i.e. 86-88 characters. Anything else is
 * treated as absent, so a malformed or truncated stored value can never be
 * trusted as a payment.
 */
const FUNDING_SIGNATURE_SHAPE = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/;

export function isValidFundingSignature(value: unknown): value is string {
  return typeof value === "string" && FUNDING_SIGNATURE_SHAPE.test(value);
}

function fundingLedgerKey(storagePaymentId: string): string {
  return `${FUNDING_LEDGER_KEY_PREFIX}${storagePaymentId}`;
}

function sessionStore(): Storage | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    return sessionStorage;
  } catch {
    // Access can throw in restricted/private contexts.
    return null;
  }
}

/**
 * Read the persisted funding signature for a storagePaymentId.
 *
 * Returns null — i.e. "not funded" — unless the stored record is present, its
 * embedded storagePaymentId matches the requested one, AND its signature has a
 * valid Solana shape. A mismatched or malformed entry is never trusted.
 */
export function readStoredFundingSignature(
  storagePaymentId: string
): string | null {
  if (!storagePaymentId) return null;

  const store = sessionStore();
  if (!store) return null;

  try {
    const raw = store.getItem(fundingLedgerKey(storagePaymentId));
    if (!raw) return null;

    const parsed = JSON.parse(raw) as {
      storagePaymentId?: unknown;
      fundingSignature?: unknown;
    };

    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.storagePaymentId !== storagePaymentId) return null;
    if (!isValidFundingSignature(parsed.fundingSignature)) return null;

    return parsed.fundingSignature;
  } catch {
    return null;
  }
}

/**
 * Persist the funding signature for a storagePaymentId.
 *
 * Called IMMEDIATELY after a successful funding send, before verification, so a
 * reload between funding and verification cannot cause a second payment.
 * A malformed signature is never written. If sessionStorage is unavailable the
 * write is skipped — the in-memory ledger still protects the current session.
 */
export function storeFundingSignature(
  storagePaymentId: string,
  fundingSignature: string
): void {
  if (!storagePaymentId) return;
  if (!isValidFundingSignature(fundingSignature)) return;

  const store = sessionStore();
  if (!store) return;

  try {
    store.setItem(
      fundingLedgerKey(storagePaymentId),
      JSON.stringify({ storagePaymentId, fundingSignature })
    );
  } catch {
    // Quota or restricted storage: the in-memory ledger still applies.
  }
}

/**
 * Resolve the funding signature already recorded for this storagePaymentId.
 *
 * Returns `null` when this payment has not been funded yet (funding required).
 * A non-null result means the creator has ALREADY paid for this exact
 * storagePaymentId, so the flow must verify that existing payment instead of
 * funding again.
 */
export function resolveExistingFundingSignature(
  ledger: StorageFundingLedger | null,
  storagePaymentId: string
): string | null {
  if (!ledger) return null;
  if (ledger.storagePaymentId !== storagePaymentId) return null;
  return ledger.fundingSignature.length > 0 ? ledger.fundingSignature : null;
}

/**
 * Obtain the funding signature for a storage payment, funding at most once.
 *
 * `fund` is the ONLY way this can spend money. It is invoked exclusively when
 * neither the in-memory ledger nor sessionStorage holds a signature for this
 * exact storagePaymentId — so a retry, a component re-entry, or a reload of the
 * same tab verifies the EXISTING payment instead of paying again.
 *
 * The returned signature is persisted before this function resolves, i.e.
 * before the caller runs verification.
 */
export async function ensureStorageFundingSignature(
  ledger: StorageFundingLedger | null,
  storagePaymentId: string,
  fund: () => Promise<{ fundingSignature: string }>
): Promise<{ fundingSignature: string; funded: boolean }> {
  const existing =
    resolveExistingFundingSignature(ledger, storagePaymentId) ??
    readStoredFundingSignature(storagePaymentId);

  if (existing) {
    return { fundingSignature: existing, funded: false };
  }

  const result = await fund();

  // Persist BEFORE returning, so verification (and any reload before it) sees
  // the payment as already made.
  storeFundingSignature(storagePaymentId, result.fundingSignature);

  return { fundingSignature: result.fundingSignature, funded: true };
}

/**
 * Bounded verification retry policy. A `TRANSACTION_PENDING` outcome means the
 * payment is known to the chain but was not yet servable by the RPC provider,
 * so re-running verification alone can succeed.
 */
export const STORAGE_VERIFY_MAX_ATTEMPTS = 5;
export const STORAGE_VERIFY_RETRY_DELAY_MS = 3_000;

export interface StorageVerifyOutcome {
  readonly ok: boolean;
  readonly reason: string;
}

/**
 * ONE verification attempt. This is the ONLY network call the retry loop is
 * allowed to make: it posts to /api/storage/verify-payment and nothing else.
 * It never touches the wallet and never triggers funding or upload.
 */
export async function requestStoragePaymentVerification(
  storagePaymentId: string,
  transactionSignature: string
): Promise<StorageVerifyOutcome> {
  const response = await fetch("/api/storage/verify-payment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storagePaymentId, transactionSignature }),
  });

  const data = (await response.json().catch(() => null)) as
    | { ok?: unknown; reason?: unknown; error?: unknown }
    | null;

  if (response.ok && data?.ok) {
    return { ok: true, reason: "" };
  }

  const reason =
    (data?.reason as string | undefined) ??
    (data?.error as string | undefined) ??
    "STORAGE_PAYMENT_NOT_VERIFIED";

  return { ok: false, reason };
}

/**
 * Verify an already-funded storage payment, retrying ONLY verification while
 * the outcome is `TRANSACTION_PENDING`.
 *
 * SAFETY: this function cannot fund. It holds no wallet, calls no signer, and
 * its retry body is exactly one `requestStoragePaymentVerification` call. The
 * funding signature is passed in by the caller, which is responsible for
 * never re-funding a storagePaymentId that already has one.
 */
export async function verifyStoragePaymentWithRetry(
  storagePaymentId: string,
  transactionSignature: string,
  options: {
    readonly maxAttempts?: number;
    readonly delayMs?: number;
    readonly sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<StorageVerifyOutcome> {
  const maxAttempts = options.maxAttempts ?? STORAGE_VERIFY_MAX_ATTEMPTS;
  const delayMs = options.delayMs ?? STORAGE_VERIFY_RETRY_DELAY_MS;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let outcome: StorageVerifyOutcome = {
    ok: false,
    reason: "STORAGE_PAYMENT_NOT_VERIFIED",
  };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await sleep(delayMs);
    }

    outcome = await requestStoragePaymentVerification(
      storagePaymentId,
      transactionSignature
    );

    if (outcome.ok || outcome.reason !== "TRANSACTION_PENDING") {
      return outcome;
    }
  }

  return outcome;
}
