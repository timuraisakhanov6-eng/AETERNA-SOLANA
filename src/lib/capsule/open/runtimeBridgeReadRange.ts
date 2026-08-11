/**
 * =========================================================
 * AETERNA Runtime Bridge
 * READ_RANGE Handler
 * =========================================================
 *
 * Handles Runtime READ_RANGE messages.
 *
 * Responsibilities:
 *
 * ✔ resolve Runtime session
 * ✔ read requested byte range
 * ✔ produce Runtime READ_RESULT message
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
    resolveRuntimeSession,
} from "./runtimeRegistry";

import {
    RuntimeMessageType,
} from "./runtimeMessages";

import type {
    RuntimeReadRangeMessage,
    RuntimeReadResultMessage,
} from "./runtimeMessages";

/**
 * Handles one READ_RANGE Runtime message.
 */
export async function handleReadRange(
    message: RuntimeReadRangeMessage,
): Promise<RuntimeReadResultMessage> {

    const session =
        resolveRuntimeSession(
            message.sessionId,
        );

    const bytes =
        await session.read(
            message.start,
            message.end,
        );

    return {

        type: RuntimeMessageType.READ_RESULT,

        sessionId:
            message.sessionId,

        start:
            message.start,

        end:
            message.end,

        bytes,

    };

}