/// <reference lib="webworker" />

export {};

declare let self: ServiceWorkerGlobalScope;

import {
    handleRuntimeMessage,
} from "@/lib/capsule/open/runtimeBridge";

import {
    RuntimeMessageType,
} from "@/lib/capsule/open/runtimeMessages";

import type {
    RuntimeMessage,
} from "@/lib/capsule/open/runtimeMessages";

/**
 * =========================================================
 * AETERNA Runtime Service Worker
 * =========================================================
 *
 * Browser adapter for the Runtime layer.
 *
 * Responsibilities:
 *
 * ✔ install
 * ✔ activate
 * ✔ transport Runtime messages
 *
 * MUST NOT:
 *
 * ✘ know Storage
 * ✘ know Crypto
 * ✘ know ByteRuntime implementation
 *
 * Runtime execution is delegated to RuntimeBridge.
 */

self.addEventListener(
    "install",
    (_event: ExtendableEvent) => {

        self.skipWaiting();

    },
);

self.addEventListener(
    "activate",
    (event: ExtendableEvent) => {

        event.waitUntil(
            self.clients.claim(),
        );

    },
);

self.addEventListener(
    "message",
    (event: ExtendableMessageEvent) => {

        const port =
            event.ports[0];

        if (!port) {
            return;
        }

        const message =
            event.data as RuntimeMessage;

        void (async () => {

            try {

                const response =
                    await handleRuntimeMessage(
                        message,
                    );

                port.postMessage(
                    response,
                );

            } catch (error) {

                port.postMessage({

                    type:
                        RuntimeMessageType.RUNTIME_ERROR,

                    sessionId:
                        typeof message === "object" &&
                        message !== null &&
                        "sessionId" in message
                            ? String(message.sessionId)
                            : "",

                    message:
                        error instanceof Error
                            ? error.message
                            : "[AETERNA] Runtime error.",

                });

            } finally {

                port.close();

            }

        })();

    },
);

/**
 * Runtime fetch lifecycle.
 *
 * HTTP Range support will be implemented
 * in the next stage.
 */
self.addEventListener(
    "fetch",
    (_event: FetchEvent) => {

        // Intentionally empty.

    },
);