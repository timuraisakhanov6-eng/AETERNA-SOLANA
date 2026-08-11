/**
 * =========================================================
 * AETERNA HTTP Range Parser
 * =========================================================
 *
 * Parses a single HTTP Range header.
 *
 * Supported forms:
 *
 * bytes=<start>-<end>
 * bytes=<start>-
 *
 * Runtime uses half-open intervals:
 *
 * [start, end)
 *
 * The open-ended form returns end = null.
 *
 * Suffix ranges (bytes=-500) are intentionally
 * unsupported in the current Runtime stage.
 */

/**
 * Parsed HTTP Range.
 */
export interface ParsedRange {

    /**
     * Inclusive start offset.
     */
    readonly start: number;

    /**
     * Exclusive end offset.
     *
     * null means:
     *
     * "until end of file"
     */
    readonly end: number | null;

}

/**
 * Parses an HTTP Range header.
 */
export function parseRangeHeader(
    header: string,
): ParsedRange {

    const value =
        header.trim();

    /**
     * bytes=<start>-<end>
     */
    let match =
        /^bytes=(\d+)-(\d+)$/.exec(
            value,
        );

    if (match) {

        const start =
            Number(match[1]);

        const inclusiveEnd =
            Number(match[2]);

        validateRange(
            start,
            inclusiveEnd,
        );

        return {

            start,

            end: inclusiveEnd + 1,

        };

    }

    /**
     * bytes=<start>-
     */
    match =
        /^bytes=(\d+)-$/.exec(
            value,
        );

    if (match) {

        const start =
            Number(match[1]);

        validateStart(
            start,
        );

        return {

            start,

            end: null,

        };

    }

    throw new Error(
        "Invalid HTTP Range header.",
    );

}

/**
 * Validates a closed range.
 */
function validateRange(
    start: number,
    inclusiveEnd: number,
): void {

    validateStart(
        start,
    );

    if (
        !Number.isSafeInteger(
            inclusiveEnd,
        )
    ) {

        throw new Error(
            "Invalid HTTP Range header.",
        );

    }

    if (
        inclusiveEnd < start
    ) {

        throw new Error(
            "Invalid HTTP Range header.",
        );

    }

}

/**
 * Validates the start offset.
 */
function validateStart(
    start: number,
): void {

    if (
        !Number.isSafeInteger(
            start,
        )
    ) {

        throw new Error(
            "Invalid HTTP Range header.",
        );

    }

    if (
        start < 0
    ) {

        throw new Error(
            "Invalid HTTP Range header.",
        );

    }

}