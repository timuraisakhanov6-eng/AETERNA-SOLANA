/**
 * AETERNA — explicit wallet disconnect marker
 *
 * UX intent only.
 * MUST NOT be used for identity, verification, payment, or entitlement decisions.
 */

const MARKER_KEY = 'aeterna-wallet-disconnected';

function isSessionStorageAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const testKey = '__aeterna_storage_test__';
    sessionStorage.setItem(testKey, testKey);
    sessionStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

export function setExplicitDisconnectMarker(): void {
  if (!isSessionStorageAvailable()) return;
  try {
    sessionStorage.setItem(MARKER_KEY, '1');
  } catch {
    // ignore storage errors
  }
}

export function clearExplicitDisconnectMarker(): void {
  if (!isSessionStorageAvailable()) return;
  try {
    sessionStorage.removeItem(MARKER_KEY);
  } catch {
    // ignore storage errors
  }
}

export function hasExplicitDisconnectMarker(): boolean {
  if (!isSessionStorageAvailable()) return false;
  try {
    return sessionStorage.getItem(MARKER_KEY) === '1';
  } catch {
    return false;
  }
}
