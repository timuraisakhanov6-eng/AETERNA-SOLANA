/**
 * AETERNA — Credit Operation Coordinator Worker
 *
 * Dedicated Cloudflare Worker hosting the
 * CreditOperationCoordinator Durable Object.
 */

import { CreditOperationCoordinator } from "../creditOperationCoordinator";

export { CreditOperationCoordinator };

/**
 * Minimal Worker entrypoint.
 *
 * This Worker exists primarily to host the Durable Object.
 * All authoritative routing is performed by Pages Functions
 * via the CREDIT_OP_COORDINATOR binding.
 */
export default {
  async fetch(_request: Request, _env: unknown, _ctx: ExecutionContext): Promise<Response> {
    return new Response("AETERNA Credit Operation Coordinator", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  },
};
