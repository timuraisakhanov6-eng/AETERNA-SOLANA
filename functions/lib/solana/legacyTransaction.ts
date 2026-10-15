/**
 * AETERNA — Minimal Solana legacy-transaction primitives (server side)
 *
 * Dependency-free implementation of exactly what the strict broadcast
 * endpoint needs to validate an ALREADY-SIGNED payment transaction:
 *
 *   - base58 ENCODE (decode already lives in ../solanaIdentityProof)
 *   - compact-u16 (shortvec) reader
 *   - strict legacy-transaction wire parsing (exact length, no trailing
 *     bytes, bounded counts) — an unknown/unsupported format is rejected
 *     rather than guessed at
 *   - Ed25519 verification over the message bytes (WebCrypto, the same
 *     primitive the identity-proof path already uses in production)
 *   - ed25519 on-curve test + program-derived address (PDA) derivation,
 *     so an Associated Token Account address can be RECOMPUTED instead of
 *     trusted
 *
 * Deliberately NOT a general Solana SDK: it parses and verifies the
 * canonical payment shape only. It never builds or signs anything.
 */

import { BASE58_ALPHABET } from "../solanaIdentityProof";

export function base58Encode(bytes: Uint8Array): string {
  // Starts EMPTY: seeding a leading 0 digit would add a spurious
  // leading '1' to every encoded value (e.g. the System Program would
  // encode to 33 characters instead of 32).
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let result = "";
  for (const byte of bytes) {
    if (byte === 0) result += BASE58_ALPHABET[0];
    else break;
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    result += BASE58_ALPHABET[digits[i]!];
  }
  return result;
}

export class TransactionParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransactionParseError";
  }
}

interface Reader {
  offset: number;
}

function readU8(bytes: Uint8Array, r: Reader): number {
  if (r.offset + 1 > bytes.length) {
    throw new TransactionParseError("TRUNCATED");
  }
  return bytes[r.offset++]!;
}

/** Solana's compact-u16 (shortvec) encoding. */
function readCompactU16(bytes: Uint8Array, r: Reader): number {
  let value = 0;
  for (let i = 0; i < 3; i++) {
    const byte = readU8(bytes, r);
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) return value;
  }
  throw new TransactionParseError("INVALID_SHORTVEC");
}

function readBytes(bytes: Uint8Array, r: Reader, length: number): Uint8Array {
  if (length < 0 || r.offset + length > bytes.length) {
    throw new TransactionParseError("TRUNCATED");
  }
  const slice = bytes.slice(r.offset, r.offset + length);
  r.offset += length;
  return slice;
}

export interface ParsedInstruction {
  programIdIndex: number;
  accountIndexes: number[];
  data: Uint8Array;
}

export interface ParsedLegacyTransaction {
  signatures: Uint8Array[];
  /** Raw message bytes the signatures are computed over. */
  messageBytes: Uint8Array;
  numRequiredSignatures: number;
  numReadonlySigned: number;
  numReadonlyUnsigned: number;
  accountKeys: Uint8Array[];
  recentBlockhash: Uint8Array;
  instructions: ParsedInstruction[];
}

/**
 * Strict parse of a legacy (non-versioned) Solana transaction.
 *
 * Every length is bounded by the remaining buffer, and the parse must
 * consume the buffer EXACTLY: a versioned transaction, a truncated
 * payload, or any format this parser does not fully understand throws
 * instead of being partially interpreted.
 */
export function parseLegacyTransaction(bytes: Uint8Array): ParsedLegacyTransaction {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new TransactionParseError("EMPTY_TRANSACTION");
  }

  const r: Reader = { offset: 0 };

  const signatureCount = readCompactU16(bytes, r);
  if (signatureCount < 1 || signatureCount > 4) {
    throw new TransactionParseError("INVALID_SIGNATURE_COUNT");
  }
  const signatures: Uint8Array[] = [];
  for (let i = 0; i < signatureCount; i++) {
    signatures.push(readBytes(bytes, r, 64));
  }

  const messageStart = r.offset;
  const numRequiredSignatures = readU8(bytes, r);
  const numReadonlySigned = readU8(bytes, r);
  const numReadonlyUnsigned = readU8(bytes, r);

  if (numRequiredSignatures !== signatureCount) {
    throw new TransactionParseError("SIGNATURES_INCOMPLETE");
  }
  if (
    numReadonlySigned + numRequiredSignatures >
    256 ||
    numReadonlyUnsigned > 256
  ) {
    throw new TransactionParseError("INVALID_HEADER");
  }

  const keyCount = readCompactU16(bytes, r);
  if (keyCount < 1 || keyCount > 64) {
    throw new TransactionParseError("INVALID_ACCOUNT_COUNT");
  }
  const accountKeys: Uint8Array[] = [];
  for (let i = 0; i < keyCount; i++) {
    accountKeys.push(readBytes(bytes, r, 32));
  }
  if (numRequiredSignatures + numReadonlySigned > keyCount) {
    throw new TransactionParseError("INVALID_HEADER");
  }

  const recentBlockhash = readBytes(bytes, r, 32);

  const instructionCount = readCompactU16(bytes, r);
  if (instructionCount < 1 || instructionCount > 4) {
    throw new TransactionParseError("INVALID_INSTRUCTION_COUNT");
  }
  const instructions: ParsedInstruction[] = [];
  for (let i = 0; i < instructionCount; i++) {
    const programIdIndex = readU8(bytes, r);
    if (programIdIndex >= accountKeys.length) {
      throw new TransactionParseError("INVALID_PROGRAM_ID_INDEX");
    }
    const accountCount = readCompactU16(bytes, r);
    if (accountCount > keyCount) {
      throw new TransactionParseError("INVALID_INSTRUCTION_ACCOUNTS");
    }
    const accountIndexes: number[] = [];
    for (let a = 0; a < accountCount; a++) {
      const index = readU8(bytes, r);
      if (index >= accountKeys.length) {
        throw new TransactionParseError("INVALID_ACCOUNT_INDEX");
      }
      accountIndexes.push(index);
    }
    const dataLength = readCompactU16(bytes, r);
    const data = readBytes(bytes, r, dataLength);
    instructions.push({ programIdIndex, accountIndexes, data });
  }

  if (r.offset !== bytes.length) {
    // Trailing bytes mean this is NOT the format we validated.
    throw new TransactionParseError("UNEXPECTED_TRAILING_BYTES");
  }

  return {
    signatures,
    messageBytes: bytes.slice(messageStart),
    numRequiredSignatures,
    numReadonlySigned,
    numReadonlyUnsigned,
    accountKeys,
    recentBlockhash,
    instructions,
  };
}

/** Ed25519 verification over the message bytes (WebCrypto). */
export async function verifyTransactionSignature(
  publicKey: Uint8Array,
  signature: Uint8Array,
  messageBytes: Uint8Array
): Promise<boolean> {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    // Copies into fresh views so the WebCrypto BufferSource typing holds
    // regardless of the caller's array buffer type.
    const keyBytes = Uint8Array.from(publicKey);
    const sigBytes = Uint8Array.from(signature);
    const msgBytes = Uint8Array.from(messageBytes);
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      sigBytes,
      msgBytes
    );
  } catch {
    return false;
  }
}

/* ================= PDA derivation ================= */

const ED25519_P = 2n ** 255n - 19n;
/** d = -121665/121666 mod p (ed25519 curve constant). */
const ED25519_D =
  37095705934669439343138083508754565189542113879843219016388785533085940283555n;

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

/**
 * True when the 32 bytes decompress to a point ON the ed25519 curve.
 *
 * A PDA must NOT be on the curve. Uses the Euler criterion on the
 * recovered x²: it is a square (or zero) exactly when a valid x exists.
 */
export function isOnEd25519Curve(point: Uint8Array): boolean {
  if (point.length !== 32) return false;

  // y is little-endian with the sign bit (top bit of the last byte) cleared.
  const le = Uint8Array.from(point);
  le[31] = le[31]! & 0x7f;

  let y = 0n;
  for (let i = 31; i >= 0; i--) {
    y = (y << 8n) | BigInt(le[i]!);
  }
  if (y >= ED25519_P) return false;

  const y2 = (y * y) % ED25519_P;
  const u = (y2 - 1n + ED25519_P) % ED25519_P;
  const v = (ED25519_D * y2 + 1n) % ED25519_P;
  if (v === 0n) return false;

  // x² = u / v  →  u · v^(p-2)
  const x2 = (u * modPow(v, ED25519_P - 2n, ED25519_P)) % ED25519_P;
  if (x2 === 0n) return true; // x = 0 is a valid curve point (0, ±1)

  // Euler criterion: x² is a quadratic residue ⇔ x²^((p-1)/2) ≡ 1 (mod p)
  return modPow(x2, (ED25519_P - 1n) / 2n, ED25519_P) === 1n;
}

const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");

export async function findProgramAddress(
  seeds: Uint8Array[],
  programId: Uint8Array
): Promise<Uint8Array> {
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, new Uint8Array([bump]), programId, PDA_MARKER];
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const data = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      data.set(part, offset);
      offset += part.length;
    }
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    if (!isOnEd25519Curve(digest)) return digest;
  }
  throw new Error("Unable to find a viable program address bump seed");
}

export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ASSOCIATED_TOKEN_PROGRAM_ID =
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

/** The canonical SPL Associated Token Account address for (owner, mint). */
export async function deriveAssociatedTokenAddress(
  owner: Uint8Array,
  mint: Uint8Array
): Promise<Uint8Array> {
  const tokenProgram = base58DecodeLocal(TOKEN_PROGRAM_ID);
  const ataProgram = base58DecodeLocal(ASSOCIATED_TOKEN_PROGRAM_ID);
  return findProgramAddress([owner, tokenProgram, mint], ataProgram);
}

/** Local copy so this module does not depend on the identity-proof import cycle. */
function base58DecodeLocal(input: string): Uint8Array {
  const lookup = new Map<string, number>();
  for (let i = 0; i < BASE58_ALPHABET.length; i++) {
    lookup.set(BASE58_ALPHABET[i]!, i);
  }
  const bytes: number[] = [];
  for (const char of input) {
    const value = lookup.get(char);
    if (value === undefined) throw new Error("Invalid base58");
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>>= 8;
    }
  }
  let leadingZeros = 0;
  for (const char of input) {
    if (char === "1") leadingZeros++;
    else break;
  }
  const result = new Uint8Array(leadingZeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    result[leadingZeros + bytes.length - 1 - i] = bytes[i]!;
  }
  return result;
}
