/**
 * =========================================================
 * AETERNA Heartbeat Transport Layer (v1.3)
 * =========================================================
 *
 * Sends creator presence confirmation to server.
 *
 * Guarantees:
 * - creatorAuthorityFragment transmitted as capability token
 * - secret NEVER transmitted
 * - fragment ≠ decrypt authority
 * - capsuleId + fragment only transport
 * - retry-safe semantics
 * - overwrite-only semantics preserved
 *
 * Endpoint contract:
 *
 * POST /api/heartbeat
 * {
 *   capsuleId,
 *   creatorAuthorityFragment
 * }
 */

import {
  CAPSULE_ID_REGEX,
  SHA256_REGEX
} from "@/lib/crypto/validators";


export type SendHeartbeatResult =
  | "confirmed"
  | "expired"
  | "rejected"
  | "network-error";


export async function sendHeartbeat(
  capsuleId: string,
  creatorAuthorityFragment: string
): Promise<SendHeartbeatResult> {

  /**
   * capsuleId invariant guard (HEX64)
   */

  if (
    typeof capsuleId !== "string" ||
    !CAPSULE_ID_REGEX.test(capsuleId)
  ) {

    return "rejected";

  }


  /**
   * fragment invariant guard (HEX64)
   */

  if (
    typeof creatorAuthorityFragment !== "string" ||
    !SHA256_REGEX.test(
      creatorAuthorityFragment
    )
  ) {

    return "rejected";

  }


  try {

    const response =
      await fetch(

        "/api/heartbeat",

        {

          method: "POST",

          headers: {

            "Content-Type": "application/json",

            "Accept": "application/json"

          },

          body:
            JSON.stringify({

              capsuleId,
              creatorAuthorityFragment

            })

        }

      );


    /**
     * Confirmation window expired
     * Capsule already openable
     */

    if (response.status === 409) {

      return "expired";

    }


    /**
     * Capability rejected / server error
     */

    if (!response.ok) {

      return "rejected";

    }


    const data: unknown =
      await response.json();


    /**
     * Response shape invariant guard
     */

    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data)
    ) {

      return "rejected";

    }

    const result =
      data as {
        readonly ok?: unknown;
      };


    if (result.ok !== true) {

      return "rejected";

    }


    return "confirmed";

  }

  catch {

    /**
     * Network failure / worker failure
     * Retry-safe semantics preserved
     */

    return "network-error";

  }

}