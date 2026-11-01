import { describe, expect, it } from "vitest"

import {
  isAcceptedLighthouseInfoData,
  isAcceptedLighthouseTokenData,
} from "./lighthouseAssertions"

/** Little-endian u64 as plain byte values. */
function u64(value: bigint): number[] {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, value, true)
  return [...bytes]
}

function bytes(values: number[]): Uint8Array {
  return Uint8Array.from(values)
}

/** 16-byte legacy INFO: KnownOwner(System) ==, DataLength(0) ==. */
function legacyInfo(): Uint8Array {
  return bytes([6, 4, 2, 3, 0, 0, 1, ...u64(0n), 0])
}

/** 26-byte current INFO: Lamports(X) >=, KnownOwner(System) ==, DataLength(0) ==. */
function currentInfo(lamports: bigint): Uint8Array {
  return bytes([6, 4, 3, 0, ...u64(lamports), 4, 3, 0, 0, 1, ...u64(0n), 0])
}

/** 27-byte TOKEN: Amount(X) >=, Delegate(None) ==, DelegatedAmount(0) <=, derived. */
function token(amount: bigint): Uint8Array {
  return bytes([
    10, 4, 4,
    2, ...u64(amount), 4,
    3, 0, 0,
    6, ...u64(0n), 5,
    8,
  ])
}

function withByte(data: Uint8Array, index: number, value: number): Uint8Array {
  const copy = Uint8Array.from(data)
  copy[index] = value
  return copy
}

describe("lighthouse INFO acceptance", () => {
  it("accepts the 16-byte legacy pair", () => {
    expect(legacyInfo()).toHaveLength(16)
    expect(isAcceptedLighthouseInfoData(legacyInfo())).toBe(true)
  })

  it("accepts the 26-byte form with the historical 14 290 622 threshold", () => {
    const data = currentInfo(14_290_622n)
    expect(data).toHaveLength(26)
    expect(isAcceptedLighthouseInfoData(data)).toBe(true)
  })

  it("accepts the 26-byte form with the rejected-attempt 8 814 000 threshold", () => {
    expect(isAcceptedLighthouseInfoData(currentInfo(8_814_000n))).toBe(true)
  })

  /**
   * GOLDEN VECTOR — the exact 26-byte INFO payload copied verbatim from the
   * Chrome production diagnostic record: `Lamports >= 8 814 000`,
   * `KnownOwner(System) ==`, `DataLength(0) ==`.
   *
   * Kept as a literal (not only built by `currentInfo`) so that no future
   * parser change can silently stop accepting the form that was ACTUALLY
   * observed in production.
   */
  it("accepts the EXACT observed 26-byte production payload (golden vector)", () => {
    const observed = Uint8Array.from(
      Buffer.from(
        "06040300b07d8600000000000403000001000000000000000000",
        "hex"
      )
    )

    expect(observed).toHaveLength(26)
    // The literal really is the 8 814 000 / System / zero-length shape.
    expect(observed).toEqual(currentInfo(8_814_000n))
    expect(isAcceptedLighthouseInfoData(observed)).toBe(true)
  })

  it("treats the threshold as a structure, not a fixture value", () => {
    for (const value of [0n, 1n, 1_000_000n, 0xffffffffffffffffn]) {
      expect(isAcceptedLighthouseInfoData(currentInfo(value))).toBe(true)
    }
  })

  it("refuses a wrong discriminator", () => {
    expect(isAcceptedLighthouseInfoData(withByte(currentInfo(1n), 0, 5))).toBe(false)
  })

  it("refuses a wrong log level", () => {
    expect(isAcceptedLighthouseInfoData(withByte(currentInfo(1n), 1, 5))).toBe(false)
  })

  it("refuses the legacy payload with a three-assertion count", () => {
    expect(isAcceptedLighthouseInfoData(withByte(legacyInfo(), 2, 3))).toBe(false)
  })

  it("refuses a non-canonical assertion-count encoding", () => {
    // 0x82 0x00 is a second spelling of 2; the canonical form is one byte.
    const nonCanonical = bytes([6, 4, 0x82, 0x00, 3, 0, 0, 1, ...u64(0n), 0])
    expect(isAcceptedLighthouseInfoData(nonCanonical)).toBe(false)
  })

  it("refuses an unknown assertion tag", () => {
    // Tag 2 (Owner) is not part of either accepted INFO shape.
    expect(isAcceptedLighthouseInfoData(withByte(currentInfo(1n), 3, 2))).toBe(false)
  })

  it("refuses reordered assertions", () => {
    const reordered = bytes([
      6, 4, 3,
      3, 0, 0,
      0, ...u64(1n), 4,
      1, ...u64(0n), 0,
    ])
    expect(reordered).toHaveLength(26)
    expect(isAcceptedLighthouseInfoData(reordered)).toBe(false)
  })

  it("refuses a duplicated Lamports assertion", () => {
    const duplicated = bytes([
      6, 4, 4,
      0, ...u64(1n), 4,
      0, ...u64(2n), 4,
      3, 0, 0,
      1, ...u64(0n), 0,
    ])
    expect(isAcceptedLighthouseInfoData(duplicated)).toBe(false)
  })

  it("refuses Lamports with any operator other than >=", () => {
    for (const operator of [0, 1, 2, 3, 5, 6, 7]) {
      const data = currentInfo(1n)
      data[12] = operator
      expect(isAcceptedLighthouseInfoData(data)).toBe(false)
    }
  })

  it("refuses a KnownOwner that is not the System program", () => {
    const data = currentInfo(1n)
    data[14] = 1
    expect(isAcceptedLighthouseInfoData(data)).toBe(false)
  })

  it("refuses a KnownOwner operator other than ==", () => {
    const data = currentInfo(1n)
    data[15] = 1
    expect(isAcceptedLighthouseInfoData(data)).toBe(false)
  })

  it("refuses a non-zero DataLength", () => {
    const data = currentInfo(1n)
    data[17] = 1
    expect(isAcceptedLighthouseInfoData(data)).toBe(false)
  })

  it("refuses a DataLength operator other than ==", () => {
    const data = currentInfo(1n)
    data[25] = 1
    expect(isAcceptedLighthouseInfoData(data)).toBe(false)
  })

  it("refuses a truncated payload", () => {
    const truncated = currentInfo(1n).slice(0, 25)
    expect(isAcceptedLighthouseInfoData(truncated)).toBe(false)
  })

  it("refuses trailing bytes", () => {
    const withTrailing = Uint8Array.from([...currentInfo(1n), 0])
    expect(withTrailing).toHaveLength(27)
    expect(isAcceptedLighthouseInfoData(withTrailing)).toBe(false)
  })

  it("returns false instead of throwing on unexpected input", () => {
    expect(isAcceptedLighthouseInfoData(new Uint8Array(0))).toBe(false)
    expect(
      isAcceptedLighthouseInfoData(null as unknown as Uint8Array)
    ).toBe(false)
  })
})

describe("lighthouse TOKEN acceptance", () => {
  it("accepts the 27-byte fixture amount", () => {
    expect(token(464_418n)).toHaveLength(27)
    expect(isAcceptedLighthouseTokenData(token(464_418n))).toBe(true)
  })

  it("accepts any u64 amount without changing the shape", () => {
    for (const amount of [0n, 1n, 123_456_789n, 0xffffffffffffffffn]) {
      expect(isAcceptedLighthouseTokenData(token(amount))).toBe(true)
    }
  })

  it("refuses a wrong discriminator or log level", () => {
    expect(isAcceptedLighthouseTokenData(withByte(token(1n), 0, 11))).toBe(false)
    expect(isAcceptedLighthouseTokenData(withByte(token(1n), 1, 5))).toBe(false)
  })

  it("refuses a wrong assertion count", () => {
    expect(isAcceptedLighthouseTokenData(withByte(token(1n), 2, 3))).toBe(false)
    expect(isAcceptedLighthouseTokenData(withByte(token(1n), 2, 5))).toBe(false)
  })

  it("refuses an Amount operator other than >=", () => {
    for (const operator of [0, 1, 2, 3, 5, 6, 7]) {
      expect(isAcceptedLighthouseTokenData(withByte(token(1n), 12, operator))).toBe(false)
    }
  })

  it("refuses a present Delegate option", () => {
    expect(isAcceptedLighthouseTokenData(withByte(token(1n), 14, 1))).toBe(false)
  })

  it("refuses a Delegate operator other than ==", () => {
    expect(isAcceptedLighthouseTokenData(withByte(token(1n), 15, 1))).toBe(false)
  })

  it("refuses a non-zero DelegatedAmount", () => {
    expect(isAcceptedLighthouseTokenData(withByte(token(1n), 17, 1))).toBe(false)
  })

  it("refuses a DelegatedAmount operator other than <=", () => {
    expect(isAcceptedLighthouseTokenData(withByte(token(1n), 25, 4))).toBe(false)
  })

  it("refuses a replaced derived-owner assertion", () => {
    expect(isAcceptedLighthouseTokenData(withByte(token(1n), 26, 5))).toBe(false)
  })

  it("refuses truncation and trailing bytes", () => {
    expect(isAcceptedLighthouseTokenData(token(1n).slice(0, 26))).toBe(false)
    expect(
      isAcceptedLighthouseTokenData(Uint8Array.from([...token(1n), 0]))
    ).toBe(false)
  })

  it("returns false instead of throwing on unexpected input", () => {
    expect(isAcceptedLighthouseTokenData(new Uint8Array(0))).toBe(false)
    expect(
      isAcceptedLighthouseTokenData(null as unknown as Uint8Array)
    ).toBe(false)
  })
})
