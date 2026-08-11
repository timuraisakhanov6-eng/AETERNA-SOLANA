/**
 * AETERNA — deepFreeze (protocol-safe recursive immutability)
 *
 * Guarantees:
 *
 * - freezes nested objects
 * - freezes arrays
 * - freezes symbol-keyed properties
 * - avoids getter execution side-effects
 * - prevents runtime mutation
 * - protects manifest integrity
 * - cycle-safe traversal (WeakSet guard)
 *
 * Used by:
 *
 * sealCapsuleCore.ts
 * manifest construction
 * runtime immutability boundary
 */

export function deepFreeze<T>(
  obj: T,
  seen = new WeakSet<object>()
): T {

  if (
    obj === null ||
    typeof obj !== "object"
  ) {
    return obj;
  }

  /**
   * Prevent infinite recursion
   * on circular references
   */

  if (seen.has(obj as object)) {
    return obj;
  }

  seen.add(obj as object);

  /**
   * Freeze container first
   * Prevents mutation during traversal
   */

  Object.freeze(obj);

  /**
   * Traverse all own keys
   * Includes symbol properties
   */

  for (const key of Reflect.ownKeys(obj)) {

    const descriptor =
      Object.getOwnPropertyDescriptor(obj, key);

    if (!descriptor) continue;

    /**
     * Only traverse data-properties
     * Never invoke getters
     */

    if ("value" in descriptor) {

      const value = descriptor.value;

      if (
        value &&
        typeof value === "object" &&
        !Object.isFrozen(value)
      ) {
        deepFreeze(value, seen);
      }

    }

  }

  return obj;

}