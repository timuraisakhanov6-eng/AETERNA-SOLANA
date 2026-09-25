import { defineConfig } from "vitest/config";
import path from "path";
import { fileURLToPath } from "url";

const __dirname =
  path.dirname(
    fileURLToPath(import.meta.url)
  );

/**
 * Isolated Vitest config.
 *
 * Deliberately NOT sharing vite.config.ts: that file swaps
 * "@/lib/storage" and "@/lib/capsule/loadManifest" between dev/prod
 * implementations and wires in browser-only plugins (node polyfills,
 * component tagger, dev middleware). Unit tests for pure runtime
 * math (byteRuntime.ts) don't touch storage, crypto, or the DOM at
 * all — mocking chunkLoader.ts is sufficient — so pulling in that
 * branching here would only add irrelevant surface area to keep in
 * sync.
 *
 * Only the "@" -> src alias is needed for the modules under test.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    // PATCH-2M: jsdom component tests use a per-file
    // @vitest-environment jsdom docblock; the default node environment
    // stays for the pure-logic .test.ts set.
    //
    // The .test.tsx set is opted in per file, NOT via src/**/*.test.tsx:
    // the older dormant component tests (CreditRuntimePatch2B.restore,
    // CreditRuntimePatch2) were never in the suite and still assert
    // pre-PATCH-2K-A mount-time signing that the canonical flow no
    // longer performs (signature only on an explicit Create Capsule
    // click). Enabling them would require rewriting unrelated tests;
    // they stay dormant exactly as in the baseline until separately
    // reconciled.
    include: [
      "src/**/*.test.ts",
      "src/components/capsule/CapsuleBuilderRestoreBatching.test.tsx",
      "src/components/capsule/CapsuleBuilderPhantomGate.test.tsx",
      "src/components/capsule/ErrorNoticeOverflow.test.tsx",
      "functions/**/*.test.ts",
    ],
    // The default "forks" pool crashed with a worker-exit error in
    // this sandbox (likely process-fork restrictions); "threads"
    // runs the same tests without that dependency.
    pool: "threads",
    poolOptions: {
      threads: {
        // PATCH-2M test infra: preload the Node 20 undici/jsdom polyfill
        // into every worker thread (see the script header). Harmless on
        // Node versions that already ship the API.
        execArgv: [
          "--require",
          path.resolve(__dirname, "./scripts/vitest-node20-undici-polyfill.cjs"),
        ],
      },
    },
  },
});