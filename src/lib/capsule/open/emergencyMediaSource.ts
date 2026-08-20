/**
 * AETERNA Emergency MediaSource Streamer
 *
 * Thin browser adapter for progressive video/audio playback.
 *
 * This module MUST NOT:
 * - alter protocol semantics
 * - alter chunk semantics
 * - alter crypto
 * - become protocol authority
 */

import type {
  MediaSession,
} from "./openTypes";

export function emergencyMediaSourceStream(args: {
  session: MediaSession;
  mimeType: string;
  size: number;
  signal: AbortSignal;
  onError: () => void;
}): string | null {
  if (
    typeof MediaSource === "undefined" ||
    !MediaSource.isTypeSupported(args.mimeType)
  ) {
    return null;
  }

  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);

  const settled = { value: null as string | null };

  const done = (outcome: string | null) => {
    if (settled.value === undefined) {
      settled.value = outcome;
    }
  };

  const cleanup = () => {
    try {
      if (
        settled.value === null &&
        mediaSource.readyState === "open"
      ) {
        mediaSource.endOfStream();
      }
    } catch {
      // preserve current state on terminal errors
    }
  };

  try {
    mediaSource.addEventListener(
      "sourceopen",
      async () => {
        if (args.signal.aborted) {
          cleanup();
          done(null);
          return;
        }

        try {
          const sourceBuffer =
            mediaSource.addSourceBuffer(args.mimeType);

          let offset = 0;
          const chunkSize = 256 * 1024;

          const appendNext = async () => {
            if (args.signal.aborted || offset >= args.size) {
              if (
                offset >= args.size &&
                mediaSource.readyState === "open"
              ) {
                try {
                  mediaSource.endOfStream();
                } catch {
                  // already closed / closing
                }
              }
              return;
            }

            const end = Math.min(
              offset + chunkSize,
              args.size,
            );

            let bytes: Uint8Array;

            try {
              bytes = await args.session.read(offset, end);
            } catch {
              cleanup();
              args.onError();
              done(null);
              return;
            }

            if (args.signal.aborted) {
              return;
            }

            try {
              sourceBuffer.appendBuffer(bytes);
            } catch {
              cleanup();
              args.onError();
              done(null);
              return;
            }

            offset = end;
          };

          sourceBuffer.addEventListener(
            "updateend",
            appendNext,
          );

          sourceBuffer.addEventListener(
            "error",
            () => {
              cleanup();
              args.onError();
              done(null);
            },
          );

          await appendNext();
          done(objectUrl);
        } catch {
          args.onError();
          done(null);
        }
      },
      { once: true },
    );
  } catch {
    args.onError();
    done(null);
  }

  return settled.value ?? null;
}
