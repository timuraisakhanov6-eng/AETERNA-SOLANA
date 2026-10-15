// @vitest-environment node
/**
 * AETERNA — isolated typecheck for the strict broadcast endpoint
 *
 * `functions/api/**` is covered by NO other tsconfig, so the security-
 * critical signed-transaction broadcast endpoint and its transaction
 * parser would otherwise have no TypeScript verification at all (only
 * ESLint and vitest, neither of which typechecks).
 *
 * These invariants pin the `typecheck:broadcast` check itself:
 *
 *  1. it PASSES on the current tree, and its program really CONTAINS
 *     `functions/api/solana/broadcast.ts` and
 *     `functions/lib/solana/legacyTransaction.ts` — i.e. it checks the
 *     endpoint, not merely a config;
 *  2. it FAILS when a type error is introduced into that same program
 *     (here: into a copy of the parser, placed next to the real one so
 *     its relative imports still resolve).
 *
 * The check is spawned as a real `tsc` process, so this suite is slower
 * than a pure unit test. All probe artefacts are removed afterwards.
 */

import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const TSC = path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
const BROADCAST_CONFIG = path.join(REPO_ROOT, "tsconfig.broadcast.json");

/** Temporary probe artefacts (removed in afterEach). */
const PROBE_DIR = path.join(REPO_ROOT, ".wb-broadcast-typecheck");
const PARSER_PROBE = path.join(
  REPO_ROOT,
  "functions",
  "lib",
  "solana",
  "__typecheck_probe__.ts"
);

/** Files the isolated check must cover. */
const REQUIRED_COVERAGE = [
  "functions/api/solana/broadcast.ts",
  "functions/lib/solana/legacyTransaction.ts",
  "functions/lib/solanaIdentityProof.ts",
  "functions/lib/solana/rpc.ts",
  "functions/lib/rateLimit.ts",
  "src/lib/creator/creatorIdentityStore.ts",
];

interface RunResult {
  code: number;
  output: string;
}

function runTsc(args: string[]): RunResult {
  try {
    const output = execFileSync(process.execPath, [TSC, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return {
      code: typeof e.status === "number" ? e.status : 1,
      output: `${e.stdout ?? ""}${e.stderr ?? ""}`,
    };
  }
}

/** Normalize Windows separators so path assertions hold on every platform. */
function normalize(text: string): string {
  return text.replace(/\\/g, "/");
}

afterEach(() => {
  rmSync(PROBE_DIR, { recursive: true, force: true });
  rmSync(PARSER_PROBE, { force: true });
});

describe("isolated broadcast typecheck", () => {
  it("passes on the current tree", () => {
    const result = runTsc(["-p", BROADCAST_CONFIG, "--noEmit"]);
    expect(result.output).not.toContain("error TS");
    expect(result.code).toBe(0);
  });

  it("really INCLUDES the broadcast endpoint and the transaction parser", () => {
    const result = runTsc(["-p", BROADCAST_CONFIG, "--noEmit", "--listFiles"]);
    expect(result.code).toBe(0);

    const listed = normalize(result.output);
    for (const required of REQUIRED_COVERAGE) {
      expect(listed).toContain(required);
    }
  });

  it("FAILS when a type error is introduced into the parser program", () => {
    // A COPY of the real parser, with a deliberate type error appended.
    // It lives beside the real parser so its relative imports still
    // resolve — i.e. the error lands in parser code inside the SAME
    // program the real check compiles.
    const parserSource = readFileSync(
      path.join(REPO_ROOT, "functions", "lib", "solana", "legacyTransaction.ts"),
      "utf8"
    );
    writeFileSync(
      PARSER_PROBE,
      `${parserSource}\nexport const __probeTypeError: number = "deliberate-type-error";\n`
    );

    mkdirSync(PROBE_DIR, { recursive: true });
    writeFileSync(
      path.join(PROBE_DIR, "tsconfig.json"),
      JSON.stringify(
        {
          extends: "../tsconfig.broadcast.json",
          compilerOptions: { baseUrl: ".." },
          include: [
            "../functions/api/solana/broadcast.ts",
            "../functions/lib/solana/legacyTransaction.ts",
            "../functions/lib/solana/rpc.ts",
            "../functions/lib/solanaIdentityProof.ts",
            "../functions/lib/rateLimit.ts",
            "../src/lib/creator/creatorIdentityStore.ts",
            "../functions/lib/solana/__typecheck_probe__.ts",
          ],
        },
        null,
        2
      )
    );

    const result = runTsc(["-p", path.join(PROBE_DIR, "tsconfig.json"), "--noEmit"]);

    expect(result.code).not.toBe(0);
    expect(result.output).toContain("error TS");
    expect(normalize(result.output)).toContain("__typecheck_probe__.ts");
  });
});
