import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"

import {
  isAcceptedLighthouseInfoData,
  isAcceptedLighthouseTokenData,
} from "./lighthouseAssertions"

/**
 * R9-A84.5 — the 17-byte `AssertTokenAccountMulti` form Phantom returned on
 * Production.
 *
 * This is the exact captured payload, proven by SHA-256 against the digest
 * recorded in `R9-A84-4/EVIDENCE-GATE.md`. It is the historical 27-byte form
 * with Phantom's `Amount(X) >=` assertion omitted: every remaining field is
 * fixed, so there is no balance-derived u64 in this form.
 *
 *   Delegate(None) ==
 *   DelegatedAmount(0) <=
 *   TokenAccountOwnerIsDerived
 */

/** Exact captured Production payload (17 bytes). */
const OBSERVED_17_HEX = "0a04030300000600000000000000000508"
/** SHA-256 of those exact bytes, as recorded by the production diagnostic. */
const OBSERVED_17_SHA256 =
  "81a7d1806a75a5572fa5a1492decf48b8e98531f955c22767ae78bb9b4380015"

/** Exact captured 26-byte INFO payload (calibration vector 1). */
const OBSERVED_26_INFO_HEX =
  "06040300a8318500000000000403000001000000000000000000"
const OBSERVED_26_INFO_SHA256 =
  "b64edb179dc4bdbddbc4193079fcedf5bb2b60bd7c99cb2ea638a50851261f38"

/** Exact captured 9-byte SPL Transfer payload (calibration vector 2). */
const OBSERVED_TRANSFER_HEX = "0340420f0000000000"
const OBSERVED_TRANSFER_SHA256 =
  "0716dd48799cbd95e895663ac738ff18e96173e5c1d6c8a132be0fa8ac777f90"

function u64(value: bigint): number[] {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, value, true)
  return [...bytes]
}

function bytes(values: number[]): Uint8Array {
  return Uint8Array.from(values)
}

function hex(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "hex"))
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(data)).digest("hex")
}

/** Structural builder for the observed form: no Amount assertion. */
function tokenWithoutAmount(): Uint8Array {
  return bytes([10, 4, 3, 3, 0, 0, 6, ...u64(0n), 5, 8])
}

/** Historical 27-byte form: Amount(X) >=, Delegate(None) ==, DelegatedAmount(0) <=, derived. */
function tokenWithAmount(amount: bigint): Uint8Array {
  return bytes([
    10, 4, 4, 2, ...u64(amount), 4, 3, 0, 0, 6, ...u64(0n), 5, 8,
  ])
}

/** 16-byte legacy INFO: KnownOwner(System) ==, DataLength(0) ==. */
function legacyInfo(): Uint8Array {
  return bytes([6, 4, 2, 3, 0, 0, 1, ...u64(0n), 0])
}

/** 26-byte current INFO: Lamports(X) >=, KnownOwner(System) ==, DataLength(0) ==. */
function currentInfo(lamports: bigint): Uint8Array {
  return bytes([6, 4, 3, 0, ...u64(lamports), 4, 3, 0, 0, 1, ...u64(0n), 0])
}

function withByte(data: Uint8Array, index: number, value: number): Uint8Array {
  const copy = Uint8Array.from(data)
  copy[index] = value
  return copy
}

describe("R9-A84.5 - captured Production fixtures", () => {
  it("reproduces the captured 17-byte TOKEN payload and its SHA-256", () => {
    const observed = hex(OBSERVED_17_HEX)
    expect(observed).toHaveLength(17)
    expect(sha256(observed)).toBe(OBSERVED_17_SHA256)
    expect(observed).toEqual(tokenWithoutAmount())
  })

  it("reproduces calibration vector 1 - the captured 26-byte INFO payload", () => {
    const observed = hex(OBSERVED_26_INFO_HEX)
    expect(observed).toHaveLength(26)
    expect(sha256(observed)).toBe(OBSERVED_26_INFO_SHA256)
    expect(observed).toEqual(currentInfo(8_729_000n))
    expect(isAcceptedLighthouseInfoData(observed)).toBe(true)
  })

  it("reproduces calibration vector 2 - the captured SPL Transfer payload", () => {
    const observed = hex(OBSERVED_TRANSFER_HEX)
    expect(observed).toHaveLength(9)
    expect(observed[0]).toBe(3)
    expect(Buffer.from(observed).readBigUInt64LE(1)).toBe(1_000_000n)
    expect(sha256(observed)).toBe(OBSERVED_TRANSFER_SHA256)
  })
})

describe("R9-A84.5 - 17-byte TOKEN acceptance (positive controls)", () => {
  it("accepts the exact captured 17-byte Production payload", () => {
    expect(isAcceptedLighthouseTokenData(hex(OBSERVED_17_HEX))).toBe(true)
  })

  it("accepts the structural form without relying on the literal", () => {
    const built = tokenWithoutAmount()
    expect(built).toHaveLength(17)
    expect(isAcceptedLighthouseTokenData(built)).toBe(true)
  })

  it("keeps accepting the historical 27-byte four-assertion TOKEN form", () => {
    expect(isAcceptedLighthouseTokenData(tokenWithAmount(1_000_000n))).toBe(true)
    expect(isAcceptedLighthouseTokenData(tokenWithAmount(0n))).toBe(true)
  })

  it("keeps accepting both historical INFO forms", () => {
    expect(isAcceptedLighthouseInfoData(legacyInfo())).toBe(true)
    expect(isAcceptedLighthouseInfoData(currentInfo(8_729_000n))).toBe(true)
  })
})

describe("R9-A84.5 - 17-byte TOKEN rejection (fail closed)", () => {
  it("refuses every single-byte mutation of the captured payload", () => {
    const observed = hex(OBSERVED_17_HEX)
    for (let index = 0; index < observed.length; index += 1) {
      const mutated = withByte(observed, index, observed[index]! ^ 0x01)
      expect(
        isAcceptedLighthouseTokenData(mutated),
        `byte ${index} mutation was accepted`
      ).toBe(false)
    }
  })

  it("refuses a random 17-byte payload carrying the token discriminator", () => {
    expect(
      isAcceptedLighthouseTokenData(
        bytes([10, 4, 3, 3, 0, 0, 6, 1, 2, 3, 4, 5, 6, 7, 8, 5, 8])
      )
    ).toBe(false)
  })

  it("refuses a wrong discriminator", () => {
    expect(isAcceptedLighthouseTokenData(withByte(tokenWithoutAmount(), 0, 6))).toBe(false)
  })

  it("refuses a wrong log level", () => {
    expect(isAcceptedLighthouseTokenData(withByte(tokenWithoutAmount(), 1, 3))).toBe(false)
  })

  it("refuses a wrong assertion count", () => {
    // Claims four assertions while only three are present.
    expect(isAcceptedLighthouseTokenData(withByte(tokenWithoutAmount(), 2, 4))).toBe(false)
    // Claims two assertions while three are present.
    expect(isAcceptedLighthouseTokenData(withByte(tokenWithoutAmount(), 2, 2))).toBe(false)
  })

  it("refuses a 27-byte payload whose encoded count is 3", () => {
    /**
     * LONG form length carrying the SHORT form's count. The encoded count must
     * equal the length-implied value (4 here), so the payload is rejected at
     * the count comparison - the mirror of the 17-byte / count-4 case.
     *
     * Proven by direct probe during the R9-A84.6 review; preserved here so the
     * behaviour cannot regress silently.
     */
    const mixed = withByte(tokenWithAmount(1_000_000n), 2, 3)
    expect(mixed).toHaveLength(27)
    expect(isAcceptedLighthouseTokenData(mixed)).toBe(false)
  })

  it("refuses a two-byte assertion-count encoding (rejected by the fixed length)", () => {
    /**
     * 0x83 0x00 is a NON-MINIMAL (non-canonical) LEB128 spelling of 3 - and it
     * is NOT rejected by the canonical-LEB128 reader. Writing the count in two
     * bytes makes the payload 18 bytes long, so the fixed-length gate refuses
     * it before the count is ever parsed.
     *
     * The canonicality check is defence-in-depth and UNREACHABLE at this entry
     * point: every accepted length (17 / 27) pins the count to a single
     * canonical byte, so a multi-byte count can never fit. This test therefore
     * proves the length gate, and is named for it.
     */
    const twoByteCount = bytes([10, 4, 0x83, 0x00, 3, 0, 0, 6, ...u64(0n), 5, 8])
    expect(twoByteCount).toHaveLength(18)
    expect(isAcceptedLighthouseTokenData(twoByteCount)).toBe(false)
  })

  it("refuses a reordered assertion triplet", () => {
    // OwnerIsDerived first.
    expect(
      isAcceptedLighthouseTokenData(bytes([10, 4, 3, 8, 3, 0, 0, 6, ...u64(0n), 5]))
    ).toBe(false)
    // DelegatedAmount before Delegate.
    expect(
      isAcceptedLighthouseTokenData(bytes([10, 4, 3, 6, ...u64(0n), 5, 3, 0, 0, 8]))
    ).toBe(false)
  })

  it("refuses a 14-byte payload that declares three assertions (fixed length)", () => {
    /**
     * Amount (tag 2) plus the derived-owner tag only fills 14 bytes, which is
     * neither accepted length (17 / 27). The fixed-length gate therefore
     * refuses it before the declared count is examined - the same mechanism as
     * the truncation case, recorded separately because it carries a valid
     * assertion count.
     *
     * A true count/content mismatch cannot occur at an accepted length: 17
     * bytes exactly accommodate 3 minimal assertions and 27 bytes exactly
     * accommodate 4, and any longer assertion (Delegate with an owner, 35
     * bytes) cannot fit either length.
     */
    const shortDeclared = bytes([10, 4, 3, 2, ...u64(1_000_000n), 4, 8])
    expect(shortDeclared).toHaveLength(14)
    expect(isAcceptedLighthouseTokenData(shortDeclared)).toBe(false)
  })

  it("refuses an unknown assertion tag in the terminal position", () => {
    // Tag 9 is not a Lighthouse token assertion.
    expect(isAcceptedLighthouseTokenData(withByte(tokenWithoutAmount(), 16, 9))).toBe(false)
  })

  it("refuses a present Delegate option", () => {
    expect(isAcceptedLighthouseTokenData(withByte(tokenWithoutAmount(), 4, 1))).toBe(false)
  })

  it("refuses a Delegate operator other than ==", () => {
    expect(isAcceptedLighthouseTokenData(withByte(tokenWithoutAmount(), 5, 4))).toBe(false)
  })

  it("refuses a non-zero DelegatedAmount", () => {
    const mutated = Uint8Array.from(tokenWithoutAmount())
    new DataView(mutated.buffer).setBigUint64(7, 1n, true)
    expect(isAcceptedLighthouseTokenData(mutated)).toBe(false)
  })

  it("refuses a DelegatedAmount operator other than <=", () => {
    expect(isAcceptedLighthouseTokenData(withByte(tokenWithoutAmount(), 15, 4))).toBe(false)
  })

  it("refuses a replaced derived-owner assertion", () => {
    expect(isAcceptedLighthouseTokenData(withByte(tokenWithoutAmount(), 16, 3))).toBe(false)
  })

  it("refuses truncation", () => {
    expect(isAcceptedLighthouseTokenData(tokenWithoutAmount().subarray(0, 16))).toBe(false)
    expect(isAcceptedLighthouseTokenData(tokenWithoutAmount().subarray(0, 10))).toBe(false)
  })

  it("refuses trailing bytes", () => {
    const extended = Uint8Array.from([...tokenWithoutAmount(), 0])
    expect(extended).toHaveLength(18)
    expect(isAcceptedLighthouseTokenData(extended)).toBe(false)
  })

  it("refuses a duplicated assertion", () => {
    // Four assertions in 17 bytes cannot decode without overrunning.
    expect(
      isAcceptedLighthouseTokenData(
        bytes([10, 4, 4, 3, 0, 0, 6, ...u64(0n), 5, 8])
      )
    ).toBe(false)
  })

  it("never accepts the byte length alone", () => {
    for (let index = 0; index < 8; index += 1) {
      const filler = bytes([10, 4, 3, ...new Array(14).fill(index)])
      expect(isAcceptedLighthouseTokenData(filler)).toBe(false)
    }
  })
})
