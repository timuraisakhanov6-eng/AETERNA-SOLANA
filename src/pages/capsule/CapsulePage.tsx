import { useParams, useLocation } from "react-router-dom";

import CapsuleController from "./CapsuleController";

import {
  CAPSULE_ID_REGEX,
} from "@/lib/crypto/validators";

import {
  parseCapsuleCapability,
} from "@/lib/capsule/parseCapsuleCapability";


/**
 * CapsulePage (CANONICAL)
 *
 * Recipient runtime entry boundary.
 *
 * Responsibilities:
 *
 * ✔ validate capsuleId
 * ✔ parse capability fragment
 * ✔ enforce fail-closed routing
 * ✔ delegate runtime orchestration
 *
 * MUST NOT:
 *
 * ✘ render UI logic
 * ✘ derive keys
 * ✘ fetch manifest
 * ✘ access trusted time
 * ✘ persist secrets
 */

export default function CapsulePage() {

  const { capsuleId } =
    useParams<{ capsuleId: string }>();

  const location =
    useLocation();


  /**
   * FAIL-CLOSED:
   * capsuleId missing or invalid → reject
   */

  if (
    typeof capsuleId !== "string" ||
    !CAPSULE_ID_REGEX.test(capsuleId)
  ) {

    return null;

  }


  /**
   * Canonical capability parsing
   */

  const capability =
    parseCapsuleCapability(
      location.hash
    );


  if (!capability) {

    return null;

  }


  /**
   * Delegate runtime orchestration
   */

  return (

    <div className="min-h-screen bg-background">

      <CapsuleController

        capsuleId={capsuleId}

        {
          ...(
            capability.recipientSecret
              ? {
                  secret:
                    capability.recipientSecret,
                }
              : {}
          )
        }

        {
          ...(
            capability.creatorAuthorityFragment
              ? {
                  creatorAuthorityFragment:
                    capability.creatorAuthorityFragment,
                }
              : {}
          )
        }

      />

    </div>

  );

}