/**
 * =========================================================
 * AETERNA Runtime Bridge
 * =========================================================
 *
 * Dispatches Runtime protocol messages.
 *
 * Responsibilities:
 *
 * ✔ dispatch Runtime messages
 * ✔ isolate Runtime protocol
 *
 * MUST NOT:
 *
 * ✘ know Service Worker
 * ✘ know HTTP
 * ✘ know Browser APIs
 * ✘ know Storage
 * ✘ know Crypto
 */

import {
    RuntimeMessageType,
} from "./runtimeMessages";

import type {
    RuntimeMessage,
} from "./runtimeMessages";

import {
    handleReadRange,
} from "./runtimeBridgeReadRange";

/**
 * Dispatches one Runtime message.
 */
export async function handleRuntimeMessage(
    message: RuntimeMessage,
): Promise<RuntimeMessage> {

    switch (message.type) {

        case RuntimeMessageType.READ_RANGE:

            return handleReadRange(
                message,
            );

        default:

            throw new Error(
                "[AETERNA] Unsupported Runtime message.",
            );

    }

}