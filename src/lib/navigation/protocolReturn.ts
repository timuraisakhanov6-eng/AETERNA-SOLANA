/**
 * AETERNA - Protocol return context (R9-A57).
 *
 * The Protocol footer used to be a fixed `<- Back to Home`. It now returns
 * the user to where they came from, using React Router navigation state
 * written by the in-app links themselves.
 *
 * TRUST MODEL
 * Only three origins exist, and each maps to a FIXED destination. The state
 * carries an origin token, never a URL:
 *
 *   home    -> "/"          (pushed navigation, safe fixed path)
 *   create  -> "/create"    (pushed navigation, safe fixed path)
 *   capsule -> history back (the ONLY origin that can carry a secret)
 *
 * Nothing here reads `document.referrer`, `history.length` or the current
 * URL to infer a destination, and no state value is ever used as a path -
 * so forged/tampered state can at worst fall back to Home.
 *
 * CAPSULE SECRET PROTECTION
 * A recipient capsule URL may carry its capability fragment after `#`.
 * That fragment must never be copied into the Protocol URL, a query string,
 * navigation state, or logs. The capsule origin therefore does NOT carry a
 * destination at all: the footer issues a browser history step, so the
 * exact original capsule entry (fragment included) is restored by the
 * browser itself. No code ever reads or rebuilds that URL.
 */

/** Navigation-state key. Namespaced so foreign state can never match. */
export const PROTOCOL_RETURN_KEY = "aeternaProtocolReturn";

export type ProtocolReturnOrigin = "home" | "create" | "capsule";

/** Shape written into `navigate(..., { state })` / `<Link state>`. */
export type ProtocolReturnState = {
  [PROTOCOL_RETURN_KEY]: {
    from: ProtocolReturnOrigin;
  };
};

/** What the Protocol footer should do for the current entry. */
export type ProtocolReturnTarget =
  | { kind: "history" }
  | { kind: "path"; path: "/" | "/create" };

const FALLBACK: ProtocolReturnTarget = { kind: "path", path: "/" };

/** Build the state for an in-app link into the Protocol. */
export function protocolReturnState(
  from: ProtocolReturnOrigin
): ProtocolReturnState {
  return {
    [PROTOCOL_RETURN_KEY]: { from },
  };
}

function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Resolve the footer destination from a navigation state.
 *
 * Unknown, malformed, forged or absent context -> Home. The capsule origin
 * is the only one that resolves to a history step.
 */
export function resolveProtocolReturn(
  state: unknown
): ProtocolReturnTarget {

  if (!isPlainObject(state)) {
    return FALLBACK;
  }

  const context =
    state[PROTOCOL_RETURN_KEY];

  if (!isPlainObject(context)) {
    return FALLBACK;
  }

  const from =
    context["from"];

  switch (from) {
    case "home":
      return { kind: "path", path: "/" };
    case "create":
      return { kind: "path", path: "/create" };
    case "capsule":
      return { kind: "history" };
    default:
      return FALLBACK;
  }
}
