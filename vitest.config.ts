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
    include: ["src/**/*.test.ts", "functions/**/*.test.ts"],
    // The default "forks" pool crashed with a worker-exit error in
    // this sandbox (likely process-fork restrictions); "threads"
    // runs the same tests without that dependency.
    pool: "threads",
  },
});