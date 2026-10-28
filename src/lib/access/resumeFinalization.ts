/**
 * AETERNA — bounded RESUME-FINALIZATION planning (Phase 3BM-R4).
 *
 * A CONSUMING Creator Credit bound to a VERIFIED publication cannot be
 * restored (the Durable Object refuses to release it:
 * PUBLICATION_VERIFIED_AWAITING_FINALIZATION). The only safe outcome for
 * such an attempt is to RESUME the original CapsuleHold finalization with
 * the SAME lifecycle / credit / capsule identity — never a new lifecycle,
 * never a new payment.
 *
 * This module is the PURE decision core for that resume offer. It performs
 * ONLY local, fail-closed validation:
 *
 *   - the authoritative server record must carry all three identifiers
 *     (creatorCreditId / lifecycleId / capsuleId);
 *   - the ACTIVE creator identity (server-derived from the signed proof,
 *     discovery.creatorIdentityId) must match the owner recorded in the
 *     local unfinished-lifecycle hint of THIS browser;
 *   - the `aeterna-prepared-capsule` sessionStorage record must exist and
 *     pass the CANONICAL hold-state validation — the same shape and F-5
 *     identity binding that CapsuleHold applies on re-entry (mirrored below;
 *     precedent: CapsuleBuilder keeps its own mirror of the same checks) —
 *     with the record's capsuleId bound to the SERVER capsuleId;
 *   - the storagePaymentId written by the original reserve flow must be
 *     present (the publication-claim replay submits it unchanged).
 *
 * It never talks to the network, never mutates state, and never invents
 * identifiers. A plan that is not "ready" MUST NOT navigate and MUST NOT
 * touch any server state.
 */

import {
  CAPSULE_ID_REGEX,
  SECRET_REGEX,
  SALT_BASE_REGEX,
  SHA256_REGEX,
} from "@/lib/crypto/validators";
import type { CapsuleHoldState } from "@/types/capsule";
import type { OpenAtUtc } from "@/types/manifest";

/** The sessionStorage key the original reserve flow wrote (CapsuleBuilder). */
export const PREPARED_CAPSULE_SESSION_KEY =
  "aeterna-prepared-capsule";

/** User-facing copy when a resume cannot be offered (fail-closed). */
export const RESUME_UNAVAILABLE_MESSAGE =
  "This attempt can't be resumed automatically — its preparation data is missing or does not match. Don't start a new payment; contact support so this attempt can be resolved safely.";

/**
 * The shape of the `aeterna-prepared-capsule` record. Mirrors the
 * SessionCapsuleData shape validated by CapsuleHold (which is deliberately
 * module-private there); `storagePaymentId` is additionally written by the
 * reserve flow and required for the resume path.
 */
export type ResumeSessionCapsuleData = {
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

  chunkMetadata: readonly ChunkMetadataInput[];

  /**
   * Written by the original reserve flow. NOT part of the canonical
   * CapsuleHold validation (it is not consumed by the hold component's own
   * mapping), but REQUIRED here: the resumed flow must submit the ORIGINAL
   * storage payment id with the publication-claim replay.
   */
  storagePaymentId?: unknown;
};

/** Local minimal structural type for chunk metadata entries. */
type ChunkMetadataInput = {
  [key: string]: unknown;
};

export type ResumeUnavailableReason =
  | "missing-identifiers"
  | "identity-mismatch"
  | "missing-prepared-record"
  | "malformed-prepared-state"
  | "capsule-mismatch"
  | "missing-storage-payment";

export type ResumePlan =
  | Readonly<{
      kind: "ready";
      holdState: CapsuleHoldState;
      storagePaymentId: string;
    }>
  | Readonly<{
      kind: "unavailable";
      reason: ResumeUnavailableReason;
    }>;

export interface ResumePlanInput {
  /** The AUTHORITATIVE server enumeration record (ids only, may be partial). */
  record: Readonly<{
    creatorCreditId: unknown;
    lifecycleId: unknown;
    capsuleId: unknown;
  }>;
  /**
   * The local unfinished-lifecycle hint of THIS browser whose lifecycleId
   * matches the server record — the owner marker carrying the identity that
   * STARTED the attempt. Null when this browser holds no such hint.
   */
  localHint: Readonly<{ creatorIdentityId: string; lifecycleId: string }> | null;
  /** The ACTIVE creator identity, server-derived from the signed proof. */
  creatorIdentityId: string | null;
  /** Raw `aeterna-prepared-capsule` sessionStorage value (null when absent). */
  preparedRaw: string | null;
}

/**
 * CANONICAL hold-state validation — an exact mirror of CapsuleHold's
 * `isValidSessionCapsuleData` (kept module-private there), with ONE
 * deliberate addition: `expectedAmount` must be a safe integer, because the
 * resume plan builds the complete CapsuleHoldState itself and must not map
 * an absent field. Same order, same regexes, same F-5 identity binding.
 */
export function isValidResumeSessionCapsuleData(
  parsed: unknown,
  expectedCapsuleId: string
): parsed is ResumeSessionCapsuleData {
  if (!parsed || typeof parsed !== "object") return false;

  const p = parsed as Partial<ResumeSessionCapsuleData>;

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

    // F-5 — identity binding against the SERVER capsuleId.
    p.capsuleId === expectedCapsuleId &&

    Number.isSafeInteger(p.openAt) &&

    Array.isArray(p.itemIds) &&
    p.itemIds.length > 0 &&

    Array.isArray(p.chunkMetadata) &&

    Number.isSafeInteger(p.billableSizeBytes) &&
    (p.billableSizeBytes as number) > 0 &&

    // Deliberate addition (see doc comment): the resume-built holdState
    // must carry a well-formed expectedAmount.
    Number.isSafeInteger(p.expectedAmount)
  );
}

/**
 * Build the exact CapsuleHoldState CapsuleHold's own sessionStorage mapping
 * produces (same field mapping, same optional-description handling). Only
 * called on validator-passing input.
 */
function buildHoldState(p: ResumeSessionCapsuleData): CapsuleHoldState {
  return {
    billableSizeBytes: p.billableSizeBytes,
    expectedAmount: p.expectedAmount,
    openAt: p.openAt as OpenAtUtc,
    ...(typeof p.description === "string"
      ? { description: p.description }
      : {}),
    itemIds: p.itemIds,
    creatorAuthority: p.creatorAuthority,
    prepared: {
      capsuleId: p.capsuleId,
      encryptedVaultPointer: p.encryptedVaultPointer,
      encryptedSizeBytes: p.encryptedSizeBytes,
      vaultSha256: p.vaultSha256,
      saltBase: p.saltBase,
      recipientSecret: p.recipientSecret,
      creatorAuthority: p.creatorAuthority,
      chunkMetadata: p.chunkMetadata,
    },
  };
}

/**
 * Pure, fail-closed resume decision. Returns "ready" ONLY when every
 * mandatory input is present, well-formed, and mutually consistent;
 * otherwise returns the most specific unavailable reason. Never throws.
 */
export function planResumeFinalization(
  input: ResumePlanInput
): ResumePlan {
  const { record, localHint, creatorIdentityId, preparedRaw } = input;

  // 1. The authoritative record must carry all three identifiers.
  if (
    typeof record.creatorCreditId !== "string" ||
    record.creatorCreditId.trim().length === 0 ||
    typeof record.lifecycleId !== "string" ||
    record.lifecycleId.trim().length === 0 ||
    typeof record.capsuleId !== "string" ||
    record.capsuleId.trim().length === 0
  ) {
    return { kind: "unavailable", reason: "missing-identifiers" };
  }

  // 2. The active (server-derived) identity must match the owner recorded
  //    in THIS browser's hint for the SAME lifecycle.
  if (
    typeof creatorIdentityId !== "string" ||
    creatorIdentityId.trim().length === 0 ||
    localHint === null ||
    localHint.lifecycleId !== record.lifecycleId ||
    localHint.creatorIdentityId !== creatorIdentityId
  ) {
    return { kind: "unavailable", reason: "identity-mismatch" };
  }

  // 3. The prepared record must exist and parse.
  if (typeof preparedRaw !== "string" || preparedRaw.length === 0) {
    return { kind: "unavailable", reason: "missing-prepared-record" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(preparedRaw);
  } catch {
    return { kind: "unavailable", reason: "malformed-prepared-state" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "unavailable", reason: "malformed-prepared-state" };
  }

  // 4. The prepared capsuleId must equal the SERVER capsuleId exactly —
  //    reported separately from a generic shape failure.
  const parsedCapsuleId = (parsed as { capsuleId?: unknown }).capsuleId;
  if (
    typeof parsedCapsuleId !== "string" ||
    parsedCapsuleId !== record.capsuleId
  ) {
    return { kind: "unavailable", reason: "capsule-mismatch" };
  }

  // 5. Canonical hold-state validation (shape + F-5 binding).
  if (!isValidResumeSessionCapsuleData(parsed, record.capsuleId)) {
    return { kind: "unavailable", reason: "malformed-prepared-state" };
  }

  // 6. The original storage payment id must be present: the resumed flow
  //    re-submits it with the idempotent publication-claim replay.
  const storagePaymentId = (parsed as { storagePaymentId?: unknown })
    .storagePaymentId;
  if (
    typeof storagePaymentId !== "string" ||
    storagePaymentId.trim().length === 0
  ) {
    return { kind: "unavailable", reason: "missing-storage-payment" };
  }

  return {
    kind: "ready",
    holdState: buildHoldState(parsed as ResumeSessionCapsuleData),
    storagePaymentId,
  };
}
