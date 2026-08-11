/**
 * =========================================================
 * AETERNA Runtime Message Protocol
 * =========================================================
 *
 * Canonical protocol used between:
 *
 * Window
 * ⇅
 * Service Worker
 *
 * Runtime messages are implementation-only.
 *
 * They MUST NEVER become part of:
 *
 * - Manifest
 * - Vault
 * - Capability
 * - Authority Model
 * - Protocol Layer
 */

/**
 * Runtime message discriminator.
 */
export const enum RuntimeMessageType {

    READ_RANGE = "READ_RANGE",

    READ_RESULT = "READ_RESULT",

    DISPOSE_SESSION = "DISPOSE_SESSION",

    RUNTIME_ERROR = "RUNTIME_ERROR",

}

/**
 * Request a byte range from an active Runtime session.
 */
export interface RuntimeReadRangeMessage {

    /**
     * Message discriminator.
     */
    readonly type: RuntimeMessageType.READ_RANGE;

    /**
     * Runtime session identifier.
     */
    readonly sessionId: string;

    /**
     * Half-open byte interval.
     *
     * [start, end)
     */
    readonly start: number;

    readonly end: number;

}

/**
 * Successful byte range response.
 */
export interface RuntimeReadResultMessage {

    /**
     * Message discriminator.
     */
    readonly type: RuntimeMessageType.READ_RESULT;

    /**
     * Runtime session identifier.
     */
    readonly sessionId: string;

    /**
     * Half-open byte interval.
     *
     * [start, end)
     */
    readonly start: number;

    readonly end: number;

    /**
     * Requested decrypted bytes.
     *
     * Ownership transfers to the receiver.
     */
    readonly bytes: Uint8Array;

}

/**
 * Requests disposal of a Runtime session.
 */
export interface RuntimeDisposeSessionMessage {

    /**
     * Message discriminator.
     */
    readonly type: RuntimeMessageType.DISPOSE_SESSION;

    /**
     * Runtime session identifier.
     */
    readonly sessionId: string;

}

/**
 * Runtime error response.
 */
export interface RuntimeErrorMessage {

    /**
     * Message discriminator.
     */
    readonly type: RuntimeMessageType.RUNTIME_ERROR;

    /**
     * Runtime session identifier.
     */
    readonly sessionId: string;

    /**
     * Runtime error message.
     *
     * Human-readable only.
     * No stack traces or internal objects.
     */
    readonly message: string;

}

/**
 * Canonical Runtime message union.
 */
export type RuntimeMessage =

    | RuntimeReadRangeMessage

    | RuntimeReadResultMessage

    | RuntimeDisposeSessionMessage

    | RuntimeErrorMessage;