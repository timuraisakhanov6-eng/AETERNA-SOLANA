/**
 * AETERNA — explicit wallet disconnect marker
 *
 * UX intent only.
 * MUST NOT be used for identity, verification, payment, or entitlement decisions.
 */

const MARKER_KEY = 'aeterna-wallet-disconnected';

function isLocalStorageAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const testKey = '__aeterna_storage_test__';
    localStorage.setItem(testKey, testKey);
    localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

export function setExplicitDisconnectMarker(): void {
  if (!isLocalStorageAvailable()) return;
  try {
    localStorage.setItem(MARKER_KEY, '1');
  } catch {
    // ignore storage errors
  }
}

export function clearExplicitDisconnectMarker(): void {
  if (!isLocalStorageAvailable()) return;
  try {
    localStorage.removeItem(MARKER_KEY);
  } catch {
    // ignore storage errors
  }
}

export function hasExplicitDisconnectMarker(): boolean {
  if (!isLocalStorageAvailable()) return false;
  try {
    return localStorage.getItem(MARKER_KEY) === '1';
  } catch {
    return false;
  }
}
