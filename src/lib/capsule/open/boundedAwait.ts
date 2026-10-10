/**
 * =========================================================
 * AETERNA Bounded Await Helper
 * =========================================================
 *
 * Presentation/runtime-only utility.
 *
 * Provides a single primitive for awaiting a DOM event or an async
 * operation with an explicit DEADLINE, so no MediaSource / media
 * handshake can block forever.
 *
 * This module:
 * - does NOT touch protocol, crypto, chunk, or authority semantics;
 * - does NOT own lifecycle policy — callers decide what a timeout means.
 */

export class BoundedAwaitTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`[AETERNA] ${label} timed out after ${ms}ms`);
    this.name = "BoundedAwaitTimeoutError";
  }
}

/**
 * Awaits `promise` but rejects with a BoundedAwaitTimeoutError if it
 * has not settled within `ms`. The original promise is not cancelled
 * (JS cannot cancel a pending promise) — the caller is expected to
 * treat the timeout as terminal and dispose any resources it owns.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new BoundedAwaitTimeoutError(label, ms));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Awaits a single DOM event on `target` with an explicit deadline.
 *
 * Resolves as soon as the event fires; rejects with a
 * BoundedAwaitTimeoutError otherwise. The listener is always removed.
 */
export function awaitEvent(
  target: EventTarget,
  type: string,
  ms: number,
  label: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onEvent = () => {
      clearTimeout(timer);
      target.removeEventListener(type, onEvent);
      resolve();
    };

    const timer = setTimeout(() => {
      target.removeEventListener(type, onEvent);
      reject(new BoundedAwaitTimeoutError(label, ms));
    }, ms);

    target.addEventListener(type, onEvent, { once: true });
  });
}
