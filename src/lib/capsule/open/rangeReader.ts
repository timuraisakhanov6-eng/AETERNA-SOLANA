import type {
    MediaSession,
} from "./openTypes";

/**
 * Reads a byte range from a Media Runtime session.
 *
 * This adapter exists to isolate Browser-facing range
 * requests from the underlying Runtime implementation.
 */
export async function readRange(
    session: MediaSession,
    start: number,
    end: number,
): Promise<Uint8Array> {

    if (
        !Number.isInteger(start) ||
        !Number.isInteger(end)
    ) {
        throw new Error(
            "Range bounds must be integers.",
        );
    }

    if (
        start < 0 ||
        end <= start
    ) {
        throw new Error(
            "Invalid byte range.",
        );
    }

    return session.read(
        start,
        end,
    );

}