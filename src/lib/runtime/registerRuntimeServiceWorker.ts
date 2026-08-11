/**
 * =========================================================
 * AETERNA Runtime Service Worker Registration
 * =========================================================
 *
 * Browser bootstrap for the Runtime Service Worker.
 *
 * Responsibilities:
 *
 * ✔ register Runtime Service Worker
 * ✔ wait until Runtime becomes active
 *
 * MUST NOT:
 *
 * ✘ know Runtime protocol
 * ✘ know Runtime messages
 * ✘ know Media sessions
 * ✘ know Crypto
 * ✘ know Storage
 */

/**
 * Registers the Runtime Service Worker.
 *
 * Registration failures are intentionally
 * non-fatal: Browser Runtime is an adapter
 * layer and must not prevent the application
 * from starting.
 *
 * Returns:
 *
 *  • ServiceWorkerRegistration when Browser
 *    Runtime is available.
 *
 *  • null when Service Workers are unsupported.
 */
export async function registerRuntimeServiceWorker(): Promise<ServiceWorkerRegistration | null> {

    if (
        typeof window === "undefined" ||
        !("serviceWorker" in navigator)
    ) {

        return null;

    }

    try {

        const registration =
            await navigator.serviceWorker.register(
                "/runtime-sw.js",
            );

        await navigator.serviceWorker.ready;

        return registration;

    } catch (error) {

        console.error(
            "[AETERNA] Failed to register Runtime Service Worker.",
            error,
        );

        return null;

    }

}