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
 *   - connect-src allows the Irys gateway's Datasprite CDN redirect host,
 *     because `gateway.irys.xyz` 302-redirects every object read to
 *     `*.mainnet-1.datasprite-cdn.com` and CSP validates redirect targets;
 *   - exactly ONE wildcard host-source exists, scoped to that proven host;
 *   - no over-broad source (`*`, `https:`, `https://*.datasprite-cdn.com`);
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

/**
 * The only wildcard permitted in `connect-src`.
 *
 * `gateway.irys.xyz` redirects object reads to a per-object host of the form
 * `<txid>.mainnet-1.datasprite-cdn.com` (whole-object form) or
 * `<txid>-data.mainnet-1.datasprite-cdn.com` (`/tx/<txid>/data` range form).
 * Both are covered by this single wildcard; the narrower pattern is sufficient
 * per observed production evidence, so no broader source is allowed.
 */
const DATASPRITE_REDIRECT_WILDCARD =
  "https://*.mainnet-1.datasprite-cdn.com";

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

    expect(connect).not.toContain("https://*.irys.xyz");
    expect(connect).not.toContain("https://irys.xyz");
    // An origin only — never a path-scoped entry.
    expect(connect).not.toContain(`${IRYS_NODE_ORIGIN}/`);
  });

  it("allows the Irys gateway's Datasprite CDN redirect host", () => {
    // Without this, CSP blocks the gateway's 302 target and every
    // browser-side object read fails with `TypeError: Failed to fetch`.
    expect(directive("connect-src")).toContain(DATASPRITE_REDIRECT_WILDCARD);
  });

  it("uses exactly ONE wildcard host-source, scoped to the proven host", () => {
    const wildcards = directive("connect-src")
      .split(/\s+/)
      .filter((token) => token.includes("*"));

    expect(wildcards).toEqual([DATASPRITE_REDIRECT_WILDCARD]);
  });

  it("introduces no over-broad source", () => {
    const connect = directive("connect-src");
    const tokens = connect.split(/\s+/);

    // Bare wildcard / scheme-only sources are never acceptable.
    expect(tokens).not.toContain("*");
    expect(tokens).not.toContain("https:");
    // The narrower mainnet-1 pattern is sufficient; broader CDN scopes are not.
    expect(connect).not.toContain("https://*.datasprite-cdn.com");
    expect(connect).not.toContain("https://datasprite-cdn.com");
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
