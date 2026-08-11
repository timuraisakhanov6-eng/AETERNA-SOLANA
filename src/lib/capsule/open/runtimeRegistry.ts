/**
 * =========================================================
 * AETERNA Runtime Registry
 * =========================================================
 *
 * Owns active Runtime sessions.
 *
 * Responsibilities:
 *
 * ✔ register Runtime sessions
 * ✔ resolve Runtime sessions
 * ✔ dispose Runtime sessions
 *
 * MUST NOT:
 *
 * ✘ know Service Worker
 * ✘ know HTTP
 * ✘ know Manifest
 * ✘ know Vault
 * ✘ know Crypto
 * ✘ know Storage
 *
 * Registry owns Runtime session lifetime only.
 */

import type {
    MediaSession,
} from "./openTypes";

/**
 * Runtime session identifier.
 */
export type RuntimeSessionId = string;

/**
 * Active Runtime sessions.
 *
 * Implementation detail.
 */
const runtimeSessions =
    new Map<
        RuntimeSessionId,
        MediaSession
    >();

/**
 * Registers a Runtime session.
 */
export function registerRuntimeSession(
    sessionId: RuntimeSessionId,
    session: MediaSession,
): void {

    if (
        runtimeSessions.has(
            sessionId,
        )
    ) {

        throw new Error(
            "[AETERNA] Runtime session already exists.",
        );

    }

    runtimeSessions.set(
        sessionId,
        session,
    );

}

/**
 * Resolves a Runtime session.
 */
export function resolveRuntimeSession(
    sessionId: RuntimeSessionId,
): MediaSession {

    const session =
        runtimeSessions.get(
            sessionId,
        );

    if (!session) {

        throw new Error(
            "[AETERNA] Runtime session not found.",
        );

    }

    return session;

}

/**
 * Removes a Runtime session.
 */
export function disposeRuntimeSession(
    sessionId: RuntimeSessionId,
): void {

    const session =
        runtimeSessions.get(
            sessionId,
        );

    if (!session) {

        throw new Error(
            "[AETERNA] Runtime session not found.",
        );

    }

    session.dispose();

    runtimeSessions.delete(
        sessionId,
    );

}