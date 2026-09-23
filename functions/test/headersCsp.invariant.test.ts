/**
 * AETERNA — production CSP invariants (`public/_headers`).
 *
 * The Irys L1 mainnet node (`IRYS_NODE_URL = https://uploader.irys.xyz`) is
 * reached at runtime for `/info`, `/price/{token}/{bytes}`, `/tx/{token}` and
 * `/graphql`. While `connect-src` did not allow that origin, `GET /info` failed
 * with `blocked:csp` and Irys funding never started
 * ("[AETERNA] creatorIrys: funding failed: Network Error").
 *
 * Proves:
 *   - connect-src allows the Irys L1 node origin, exactly once;
 *   - no wildcard was introduced for it;
 *   - the rest of the policy (including Solana / Phantom / API origins) is
 *     unchanged.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const headersPath = resolve(repoRoot, "public/_headers");

const headers = readFileSync(headersPath, "utf8");

const IRYS_NODE_ORIGIN = "https://uploader.irys.xyz";

function directive(name: string): string {
  const match = headers.match(new RegExp(`${name} ([^;]+);`));
  return match?.[1] ?? "";
}

describe("public/_headers — production CSP", () => {
  it("connect-src allows the Irys L1 mainnet node origin", () => {
    expect(directive("connect-src")).toContain(IRYS_NODE_ORIGIN);
  });

  it("allows it exactly once (no accidental duplicate)", () => {
    const occurrences = headers.split(IRYS_NODE_ORIGIN).length - 1;
    expect(occurrences).toBe(1);
  });

  it("does not use a wildcard for the Irys origin", () => {
    const connect = directive("connect-src");

    expect(connect).not.toContain("*");
    expect(connect).not.toContain("https://*.irys.xyz");
    // An origin only — never a path-scoped entry.
    expect(connect).not.toContain(`${IRYS_NODE_ORIGIN}/`);
  });

  it("keeps the rest of the policy — directives and Solana / Phantom / API origins", () => {
    expect(headers).toContain("Content-Security-Policy:");
    expect(headers).toContain("default-src 'self'");
    expect(headers).toContain("frame-ancestors 'none'");

    expect(directive("script-src")).toContain("'self'");
    expect(directive("style-src")).toContain("'self'");
    expect(directive("font-src")).toContain("https://fonts.gstatic.com");
    expect(directive("img-src")).toContain("https://api.web3modal.org");

    const connect = directive("connect-src");
    expect(connect).toContain("'self'");
    expect(connect).toContain("https://api.mainnet-beta.solana.com");
    expect(connect).toContain("wss://relay.walletconnect.org");
    expect(connect).toContain("https://api.web3modal.org");
  });
});
