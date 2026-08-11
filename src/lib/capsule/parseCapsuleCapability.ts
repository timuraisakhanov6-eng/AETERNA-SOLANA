import {
  SECRET_REGEX,
  CREATOR_AUTHORITY_FRAGMENT_REGEX,
} from "@/lib/crypto/validators";


export type ParsedCapsuleCapability = {

  recipientSecret?: string;

  creatorAuthorityFragment?: string;

};


/**
 * parseCapsuleCapability
 *
 * Canonical capability fragment parser.
 *
 * Supported forms:
 *
 * #HEX64
 * #HEX64&c=HEX64
 * #c=HEX64
 *
 * Fail-closed:
 * malformed fragments return null
 */

export function parseCapsuleCapability(
  hash: string
): ParsedCapsuleCapability | null {

  if (typeof hash !== "string") {
    return null;
  }


  const fragment =
    hash.startsWith("#")
      ? hash.slice(1)
      : hash;


  if (!fragment) {
    return null;
  }


  const parts =
    fragment.split("&");


  if (
    parts.length === 0 ||
    parts.length > 2
  ) {
    return null;
  }


  let recipientSecret:
    string | undefined;

  let creatorAuthorityFragment:
    string | undefined;


  for (const part of parts) {

    if (!part) {
      return null;
    }


    /**
     * creator capability
     *
     * c=HEX64
     */

    if (part.startsWith("c=")) {

      const value =
        part.slice(2);


      if (
        !CREATOR_AUTHORITY_FRAGMENT_REGEX.test(value)
      ) {
        return null;
      }


      if (
        creatorAuthorityFragment
      ) {
        return null;
      }


      creatorAuthorityFragment =
        value;

      continue;

    }


    /**
     * recipient capability
     *
     * HEX64
     */

    if (
      SECRET_REGEX.test(part)
    ) {

      if (recipientSecret) {
        return null;
      }


      recipientSecret = part;

      continue;

    }


    /**
     * unknown capability segment
     */

    return null;

  }


  /**
   * at least one capability required
   */

  if (
    !recipientSecret &&
    !creatorAuthorityFragment
  ) {
    return null;
  }


  const result:
  ParsedCapsuleCapability = {};

  if (recipientSecret) {
    result.recipientSecret =
      recipientSecret;
  }

  if (creatorAuthorityFragment) {
    result.creatorAuthorityFragment =
      creatorAuthorityFragment;
  }

  return result;

}