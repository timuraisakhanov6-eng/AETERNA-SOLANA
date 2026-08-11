/**
 * =========================================================
 * AETERNA Runtime Client
 * =========================================================
 *
 * Browser adapter used to communicate with the Runtime
 * Service Worker.
 *
 * Responsibilities:
 *
 * ✔ send Runtime messages
 * ✔ receive Runtime messages
 *
 * MUST NOT:
 *
 * ✘ know Runtime implementation
 * ✘ know Crypto
 * ✘ know Storage
 * ✘ know Browser UI
 */

import type {
    RuntimeMessage,
} from "@/lib/capsule/open/runtimeMessages";

/**
 * Runtime transport timeout (milliseconds).
 */
const TRANSPORT_TIMEOUT = 10000;

/**
 * Sends one Runtime message.
 */
export async function sendRuntimeMessage(
    message: RuntimeMessage,
): Promise<RuntimeMessage> {

    if (
        typeof navigator === "undefined" ||
        !("serviceWorker" in navigator)
    ) {
        throw new Error(
            "[AETERNA] Service Worker is unavailable.",
        );
    }

    const registration =
        await navigator.serviceWorker.ready;

    const worker =
        registration.active;

    if (!worker) {
        throw new Error(
            "[AETERNA] Runtime Service Worker is not active.",
        );
    }

    const channel =
        new MessageChannel();

    const {
        port1,
        port2,
    } = channel;

    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    try {

        return await new Promise<RuntimeMessage>((
            resolve,
            reject,
        ) => {

            // FIX #1 + #2: clear timer and detach handlers
            // BEFORE settling the promise, so a late or duplicate
            // Service Worker message can never re-enter this
            // callback once we've already resolved/rejected.
            const settle = (
                fn: () => void,
            ) => {

                if (timeoutId !== null) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                }

                port1.onmessage = null;
                port1.onmessageerror = null;

                fn();

            };

            timeoutId =
                setTimeout(() => {

                    settle(() => reject(
                        new Error(
                            "[AETERNA] Runtime transport timeout.",
                        ),
                    ));

                }, TRANSPORT_TIMEOUT);

            port1.onmessage =
                (event: MessageEvent<RuntimeMessage>) => {

                    settle(() => resolve(
                        event.data,
                    ));

                };

            port1.onmessageerror =
                () => {

                    settle(() => reject(
                        new Error(
                            "[AETERNA] Runtime transport failed.",
                        ),
                    ));

                };

            worker.postMessage(
                message,
                [port2],
            );

        });

    } finally {

        if (timeoutId !== null) {
            clearTimeout(timeoutId);
        }

        port1.onmessage = null;
        port1.onmessageerror = null;
        port1.close();

    }

}