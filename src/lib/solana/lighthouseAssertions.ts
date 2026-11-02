/**
 * AETERNA — shared Lighthouse v2 assertion acceptance rules.
 *
 * ONE pure module, imported by BOTH sides of the payment:
 *
 *   - the client payment guard (`src/lib/wallet/solanaWallet.ts`), which
 *     compares the message the wallet returned with the prepared one, and
 *   - the server broadcast validator (`functions/api/solana/broadcast.ts`),
 *     which re-validates the very bytes it is about to forward.
 *
 * Because both sides call exactly these predicates, a payload the client
 * signs can never be refused by the server for a different reason, and no
 * second, independently drifting parser can appear.
 *
 * Accepted payloads (Phantom v2, `AssertAccountInfoMulti` /
 * `AssertTokenAccountMulti`, log level 4):
 *
 *   INFO (discriminator 6) on the prepared fee payer:
 *     - 16-byte legacy form:
 *         KnownOwner(System) == Equal
 *         DataLength(0) == Equal
 *     - 26-byte current form:
 *         Lamports(X) >= GreaterThanOrEqual
 *         KnownOwner(System) == Equal
 *         DataLength(0) == Equal
 *       X is ANY u64: Phantom derives it from the simulated payer balance,
 *       so pinning one value would refuse every other balance. It is a
 *       READ-ONLY assertion — it can only make the transaction fail, never
 *       move tokens — and the payment transfer itself is still compared
 *       byte-for-byte by the caller.
 *
 *   TOKEN (discriminator 10) on the transfer's source ATA:
 *     - 27-byte form:
 *         Amount(X) >= GreaterThanOrEqual
 *         Delegate(None) == Equal
 *         DelegatedAmount(0) <= LessThanOrEqual
 *         TokenAccountOwnerIsDerived
 *       X is ANY u64 (the same balance-derived field).
 *     - 17-byte form (observed on Production; Phantom omits its OWN Amount
 *       assertion here — this is the wallet's balance protection, never
 *       AETERNA's payment-amount control):
 *         Delegate(None) == Equal
 *         DelegatedAmount(0) <= LessThanOrEqual
 *         TokenAccountOwnerIsDerived
 *       Every field is fixed; the form carries no balance-derived u64.
 *
 * Refused, always: another discriminator or log level, a non-canonical
 * assertion count, an unknown / duplicated / reordered assertion, an
 * unexpected operator or fixed value, a truncated payload, and ANY trailing
 * byte. The predicates never throw: malformed or unexpected input yields
 * `false`.
 */

/** Lighthouse v2 assertion program. */
export const LIGHTHOUSE_PROGRAM_ID =
  "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95"

/** `AssertAccountInfoMulti` — account assertions on the fee payer. */
const INFO_DISCRIMINATOR = 6
/** `AssertTokenAccountMulti` — token-account assertions on the source ATA. */
const TOKEN_DISCRIMINATOR = 10
/** The only log level Phantom appends (`FailedPlaintextMessage`). */
const ACCEPTED_LOG_LEVEL = 4

const LEGACY_INFO_LENGTH = 16
const CURRENT_INFO_LENGTH = 26
/** Historical 27-byte TOKEN form: Amount, Delegate, DelegatedAmount, derived. */
const TOKEN_WITH_AMOUNT_LENGTH = 27
/** Observed 17-byte TOKEN form: the same, with Phantom's Amount assertion omitted. */
const TOKEN_WITHOUT_AMOUNT_LENGTH = 17

const INFO_TAG_LAMPORTS = 0
const INFO_TAG_DATA_LENGTH = 1
const INFO_TAG_KNOWN_OWNER = 3

const TOKEN_TAG_AMOUNT = 2
const TOKEN_TAG_DELEGATE = 3
const TOKEN_TAG_DELEGATED_AMOUNT = 6
const TOKEN_TAG_OWNER_IS_DERIVED = 8

/** `KnownProgram::System` — the only owner a payment payer may have. */
const KNOWN_PROGRAM_SYSTEM = 0

const OPERATOR_EQUAL = 0
const OPERATOR_GREATER_THAN_OR_EQUAL = 4
const OPERATOR_LESS_THAN_OR_EQUAL = 5

const U64_MAX = 0xffffffffffffffffn

/** Bounded, mutable read position over one instruction payload. */
interface Cursor {
  readonly bytes: Uint8Array
  offset: number
}

function readU8(cursor: Cursor): number | null {
  if (cursor.offset >= cursor.bytes.length) return null
  const value = cursor.bytes[cursor.offset]!
  cursor.offset += 1
  return value
}

/** Fixed-width little-endian u64; never reads past the payload. */
function readU64(cursor: Cursor): bigint | null {
  if (cursor.bytes.length - cursor.offset < 8) return null
  let value = 0n
  for (let index = 7; index >= 0; index--) {
    value = (value << 8n) | BigInt(cursor.bytes[cursor.offset + index]!)
  }
  cursor.offset += 8
  return value
}

function skipBytes(cursor: Cursor, length: number): boolean {
  if (cursor.bytes.length - cursor.offset < length) return false
  cursor.offset += length
  return true
}

/**
 * Canonical LEB128 (`LEB128Vec` length prefix / byte offsets).
 *
 * Only the MINIMAL encoding of a value is accepted: the multi-byte form may
 * not end in a zero group, so `0x82 0x00` is not a second spelling of `2`.
 * Ten groups are read at most, and the tenth may carry only one bit, which
 * bounds the result to u64 — a longer or overflowing prefix is refused
 * rather than wrapped.
 */
function readCanonicalLeb128U64(cursor: Cursor): bigint | null {
  let value = 0n
  let shift = 0n
  for (let index = 0; index < 10; index++) {
    const byte = readU8(cursor)
    if (byte === null) return null
    const payload = byte & 0x7f
    if (index === 9 && payload > 0x01) return null
    value |= BigInt(payload) << shift
    if ((byte & 0x80) === 0) {
      if (index > 0 && payload === 0) return null
      return value > U64_MAX ? null : value
    }
    shift += 7n
  }
  return null
}

type InfoAssertion =
  | { readonly kind: "lamports"; readonly value: bigint; readonly operator: number }
  | { readonly kind: "dataLength"; readonly value: bigint; readonly operator: number }
  | { readonly kind: "knownOwner"; readonly program: number; readonly operator: number }

function readInfoAssertion(cursor: Cursor): InfoAssertion | null {
  const tag = readU8(cursor)
  if (tag === null) return null
  if (tag === INFO_TAG_LAMPORTS || tag === INFO_TAG_DATA_LENGTH) {
    const value = readU64(cursor)
    const operator = readU8(cursor)
    if (value === null || operator === null) return null
    return tag === INFO_TAG_LAMPORTS
      ? { kind: "lamports", value, operator }
      : { kind: "dataLength", value, operator }
  }
  if (tag === INFO_TAG_KNOWN_OWNER) {
    const program = readU8(cursor)
    const operator = readU8(cursor)
    if (program === null || operator === null) return null
    return { kind: "knownOwner", program, operator }
  }
  return null
}

type TokenAssertion =
  | { readonly kind: "amount"; readonly value: bigint; readonly operator: number }
  | { readonly kind: "delegate"; readonly hasOwner: boolean; readonly operator: number }
  | { readonly kind: "delegatedAmount"; readonly value: bigint; readonly operator: number }
  | { readonly kind: "ownerIsDerived" }

function readTokenAssertion(cursor: Cursor): TokenAssertion | null {
  const tag = readU8(cursor)
  if (tag === null) return null
  if (tag === TOKEN_TAG_AMOUNT || tag === TOKEN_TAG_DELEGATED_AMOUNT) {
    const value = readU64(cursor)
    const operator = readU8(cursor)
    if (value === null || operator === null) return null
    return tag === TOKEN_TAG_AMOUNT
      ? { kind: "amount", value, operator }
      : { kind: "delegatedAmount", value, operator }
  }
  if (tag === TOKEN_TAG_DELEGATE) {
    const option = readU8(cursor)
    if (option === null || option > 1) return null
    if (option === 1 && !skipBytes(cursor, 32)) return null
    const operator = readU8(cursor)
    if (operator === null) return null
    return { kind: "delegate", hasOwner: option === 1, operator }
  }
  if (tag === TOKEN_TAG_OWNER_IS_DERIVED) return { kind: "ownerIsDerived" }
  return null
}

function parseInfoAssertions(data: Uint8Array): InfoAssertion[] | null {
  const cursor: Cursor = { bytes: data, offset: 0 }
  if (readU8(cursor) !== INFO_DISCRIMINATOR) return null
  if (readU8(cursor) !== ACCEPTED_LOG_LEVEL) return null
  const count = readCanonicalLeb128U64(cursor)
  if (count === null) return null
  if (count !== 2n && count !== 3n) return null
  const assertions: InfoAssertion[] = []
  for (let index = 0; index < Number(count); index++) {
    const assertion = readInfoAssertion(cursor)
    if (assertion === null) return null
    assertions.push(assertion)
  }
  if (cursor.offset !== data.length) return null
  return assertions
}

function infoShapeIsAccepted(assertions: readonly InfoAssertion[]): boolean {
  let index = 0
  if (assertions.length === 3) {
    const lamports = assertions[index++]
    if (lamports === undefined || lamports.kind !== "lamports") return false
    if (lamports.operator !== OPERATOR_GREATER_THAN_OR_EQUAL) return false
  }
  const knownOwner = assertions[index++]
  if (knownOwner === undefined || knownOwner.kind !== "knownOwner") return false
  if (knownOwner.program !== KNOWN_PROGRAM_SYSTEM) return false
  if (knownOwner.operator !== OPERATOR_EQUAL) return false
  const dataLength = assertions[index++]
  if (dataLength === undefined || dataLength.kind !== "dataLength") return false
  if (dataLength.value !== 0n) return false
  if (dataLength.operator !== OPERATOR_EQUAL) return false
  return index === assertions.length
}

/**
 * Accepts the 4-assertion (Amount-bearing) form and the 3-assertion form
 * observed on Production, which is the same triplet with Phantom's own Amount
 * assertion omitted. The omitted assertion is the WALLET's balance protection,
 * not AETERNA's payment-amount control: the SPL Transfer is still compared
 * byte-for-byte by the caller, so this shape changes no payment semantics.
 */
function tokenShapeIsAccepted(assertions: readonly TokenAssertion[]): boolean {
  if (assertions.length !== 4 && assertions.length !== 3) return false
  let index = 0
  if (assertions.length === 4) {
    const amount = assertions[index++]
    if (amount === undefined || amount.kind !== "amount") return false
    if (amount.operator !== OPERATOR_GREATER_THAN_OR_EQUAL) return false
  }
  const delegate = assertions[index++]
  if (delegate === undefined || delegate.kind !== "delegate") return false
  if (delegate.hasOwner) return false
  if (delegate.operator !== OPERATOR_EQUAL) return false
  const delegatedAmount = assertions[index++]
  if (delegatedAmount === undefined || delegatedAmount.kind !== "delegatedAmount") return false
  if (delegatedAmount.value !== 0n) return false
  if (delegatedAmount.operator !== OPERATOR_LESS_THAN_OR_EQUAL) return false
  const ownerIsDerived = assertions[index++]
  if (ownerIsDerived === undefined || ownerIsDerived.kind !== "ownerIsDerived") return false
  return index === assertions.length
}

/**
 * `true` only for one of the two accepted INFO payloads: the 16-byte legacy
 * pair, or the 26-byte three-assertion form whose ONLY variable field is the
 * Lamports u64.
 */
export function isAcceptedLighthouseInfoData(data: Uint8Array): boolean {
  try {
    if (!(data instanceof Uint8Array)) return false
    if (data.length !== LEGACY_INFO_LENGTH && data.length !== CURRENT_INFO_LENGTH) {
      return false
    }
    const assertions = parseInfoAssertions(data)
    if (assertions === null) return false
    const expectedCount = data.length === LEGACY_INFO_LENGTH ? 2 : 3
    if (assertions.length !== expectedCount) return false
    return infoShapeIsAccepted(assertions)
  } catch {
    return false
  }
}

/**
 * `true` only for one of the two accepted TOKEN structures: the historical
 * 27-byte form with the Amount u64 as its single variable field, or the
 * 17-byte form observed on Production, whose fields are all fixed.
 */
export function isAcceptedLighthouseTokenData(data: Uint8Array): boolean {
  try {
    if (!(data instanceof Uint8Array)) return false
    /**
     * The LENGTH decides the only permitted assertion count; the count in the
     * payload must then match it exactly. Two forms are accepted, nothing else:
     * 27 bytes with Amount, and the observed 17 bytes without it.
     */
    const expectedCount =
      data.length === TOKEN_WITH_AMOUNT_LENGTH
        ? 4n
        : data.length === TOKEN_WITHOUT_AMOUNT_LENGTH
          ? 3n
          : null
    if (expectedCount === null) return false
    const cursor: Cursor = { bytes: data, offset: 0 }
    if (readU8(cursor) !== TOKEN_DISCRIMINATOR) return false
    if (readU8(cursor) !== ACCEPTED_LOG_LEVEL) return false
    if (readCanonicalLeb128U64(cursor) !== expectedCount) return false
    const assertions: TokenAssertion[] = []
    for (let index = 0; index < Number(expectedCount); index++) {
      const assertion = readTokenAssertion(cursor)
      if (assertion === null) return false
      assertions.push(assertion)
    }
    if (cursor.offset !== data.length) return false
    return tokenShapeIsAccepted(assertions)
  } catch {
    return false
  }
}
