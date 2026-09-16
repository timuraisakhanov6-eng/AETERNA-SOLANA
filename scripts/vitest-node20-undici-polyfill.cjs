/**
 * AETERNA — test environment polyfill (PATCH-2M test infra).
 *
 * undici 8.10.0 (pulled in by jsdom 30 for the jsdom test environment)
 * destructures `markAsUncloneable` from `node:worker_threads` at module
 * load time. That API is absent on Node 20 (added in newer Node lines),
 * so the jsdom environment crashes with
 * `webidl.util.markAsUncloneable is not a function` before any test
 * runs. Defining a no-op when missing lets the environment load; the
 * real function only affects structuredClone semantics of undici's
 * CacheStorage instance, which no test relies on.
 *
 * Loaded ONLY via vitest worker `execArgv --require` (see
 * vitest.config.ts). Never imported by production runtime code.
 */
const workerThreads = require("node:worker_threads");

if (typeof workerThreads.markAsUncloneable !== "function") {
  workerThreads.markAsUncloneable = function markAsUncloneable() {};
}
