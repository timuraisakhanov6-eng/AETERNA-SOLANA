/**
 * AETERNA — last used wallet persistence
 *
 * Stores ONLY wallet id
 * Safe under fragment-secret boundary contract
 */

const KEY = "aeterna:lastWallet";


function isBrowser(): boolean {

  return (
    typeof window !== "undefined" &&
    typeof localStorage !== "undefined"
  );

}


function normalizeWalletId(
  id: unknown
): string {

  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > 64
  ) {

    throw new Error(
      "[AETERNA] Invalid wallet id"
    );

  }

  return id;

}


export function saveLastWallet(
  id: string
): void {

  if (!isBrowser()) {
    return;
  }

  try {

    const normalized =
      normalizeWalletId(id);

    localStorage.setItem(
      KEY,
      normalized
    );

  }

  catch {

    // ignore storage errors

  }

}


export function getLastWallet():
string | null {

  if (!isBrowser()) {
    return null;
  }

  try {

    const value =
      localStorage.getItem(KEY);

    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 64
    ) {

      return null;

    }

    return value;

  }

  catch {

    return null;

  }

}


export function clearLastWallet():
void {

  if (!isBrowser()) {
    return;
  }

  try {

    localStorage.removeItem(KEY);

  }

  catch {

    // ignore storage errors

  }

}