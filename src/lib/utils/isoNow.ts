import { getUiTime } from "@/lib/utils/getUiTime";
import type { IsoUtcString } from "@/types/vault";

/**
 * UI-safe timestamp helper
 *
 * Used only in client/editor layers
 *
 * Returns canonical ISO UTC string
 * branded as IsoUtcString
 */

export function isoNow(): IsoUtcString {

  return new Date()
    .toISOString() as IsoUtcString;

}


/**
 * Protocol-safe timestamp helper
 *
 * Uses trusted monotonic time boundary
 *
 * Required for:
 * - seal boundary timestamps
 * - heartbeat runtime actions
 * - authority-sensitive events
 */

export async function isoNowTrusted(): Promise<IsoUtcString> {

  const { nowUtc } =
    await getUiTime();

  return new Date(nowUtc)
    .toISOString() as IsoUtcString;

}