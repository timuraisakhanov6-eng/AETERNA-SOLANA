/**
 * AETERNA — Capsule OG Preview Invariants
 *
 * Covers the crawler-facing social preview layer at
 * functions/capsule/[capsuleId].ts:
 *
 * - fixed branded title (never derived from description/capsuleId)
 * - og:description is EXACTLY the creator description (escaped,
 *   capped at 140), fallback when empty
 * - per-capsule preview isolation (no cross-contamination)
 * - URL fragments are structurally unreachable server-side
 * - browser (non-crawler) traffic passes through to the SPA
 * - all failure paths fall back to the normal SPA
 */

import { describe, it, expect } from "vitest";
import {
  onRequestGet,
  buildOgHtml,
} from "../capsule/[capsuleId]";

const SITE = "https://aeterna-solana.pages.dev";

const VALID_ID_A = "a".repeat(64);
const VALID_ID_B = "b".repeat(64);
const VALID_ID_MISSING = "c".repeat(64);

function makeManifest(fields: {
  capsuleId: string;
  description?: string;
  openAt?: number;
  extra?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    version: 1,
    capsuleId: fields.capsuleId,
    openAt: fields.openAt ?? 4102444800000,
    ...(fields.description !== undefined
      ? { description: fields.description }
      : {}),
    ...(fields.extra ?? {}),
  });
}

function makeContext(options: {
  capsuleId: string;
  kv?: Map<string, string>;
  userAgent?: string;
  ip?: string;
}) {
  const kvStore = options.kv ?? new Map<string, string>();
  const headers: Record<string, string> = {
    "user-agent": options.userAgent ?? "WhatsApp/2.23.20.0",
    "CF-Connecting-IP": options.ip ?? "10.0.0.1",
  };

  const nextResponses: string[] = [];

  const context = {
    request: new Request(
      `${SITE}/capsule/${options.capsuleId}`,
      { headers }
    ),
    env: {
      CAPSULE_MANIFESTS: {
        get: async (key: string) => kvStore.get(key) ?? null,
      },
    },
    params: { capsuleId: options.capsuleId },
    next: async () => {
      const spa =
        "<!doctype html><html><head><title>SPA</title></head><body></body></html>";
      nextResponses.push(spa);
      return new Response(spa, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    },
  };

  return { context: context as never, nextResponses };
}

async function getBody(response: Response): Promise<string> {
  return response.text();
}

describe("capsule OG preview — routing", () => {
  it("passes browser (non-crawler) traffic through to the SPA untouched", async () => {
    const { context, nextResponses } = makeContext({
      capsuleId: VALID_ID_A,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36",
      ip: "10.1.0.1",
    });

    const response = await onRequestGet(context);

    expect(nextResponses).toHaveLength(1);
    expect(await response.text()).toContain("<title>SPA</title>");
  });

  it("serves OG HTML to crawler user-agents", async () => {
    const kv = new Map<string, string>([
      [VALID_ID_A, makeManifest({ capsuleId: VALID_ID_A, description: "test" })],
    ]);
    const { context } = makeContext({
      capsuleId: VALID_ID_A,
      kv,
      ip: "10.1.0.2",
    });

    const response = await onRequestGet(context);

    expect(response.status).toBe(200);
    expect(await getBody(response)).toContain("og:title");
  });
});

describe("capsule OG preview — metadata contract", () => {
  it("uses the fixed branded title and the EXACT creator description", async () => {
    const description = "вот это писания я хочу чтобы было";
    const kv = new Map<string, string>([
      [VALID_ID_A, makeManifest({ capsuleId: VALID_ID_A, description })],
    ]);
    const { context } = makeContext({
      capsuleId: VALID_ID_A,
      kv,
      ip: "10.2.0.1",
    });

    const html = await getBody(await onRequestGet(context));

    expect(html).toContain('<title>AETERNA — Digital Time Capsule</title>');
    expect(html).toContain(
      '<meta property="og:title" content="AETERNA — Digital Time Capsule" />'
    );
    expect(html).toContain(
      `<meta property="og:description" content="${description}" />`
    );
    expect(html).toContain(
      `<meta name="twitter:description" content="${description}" />`
    );
  });

  it("never derives the title from the description or capsuleId", async () => {
    const description = "a very distinctive creator sentence";
    const kv = new Map<string, string>([
      [VALID_ID_A, makeManifest({ capsuleId: VALID_ID_A, description })],
    ]);
    const { context } = makeContext({
      capsuleId: VALID_ID_A,
      kv,
      ip: "10.2.0.2",
    });

    const html = await getBody(await onRequestGet(context));

    const titleMatches = html.match(/<title>([^<]*)<\/title>/g) ?? [];
    for (const match of titleMatches) {
      expect(match).toBe("<title>AETERNA — Digital Time Capsule</title>");
    }
    expect(html).not.toContain(`"a very distinctive creator sentence" — AETERNA`);
    // capsuleId MAY appear in canonical/og:url — but never inside a title
    const ogTitle = html.match(
      /<meta property="og:title" content="([^"]*)" \/>/
    )?.[1];
    expect(ogTitle).toBe("AETERNA — Digital Time Capsule");
  });

  it("caps the description at 140 characters", async () => {
    const long = "x".repeat(300);
    const kv = new Map<string, string>([
      [VALID_ID_A, makeManifest({ capsuleId: VALID_ID_A, description: long })],
    ]);
    const { context } = makeContext({
      capsuleId: VALID_ID_A,
      kv,
      ip: "10.2.0.3",
    });

    const html = await getBody(await onRequestGet(context));

    expect(html).toContain(`content="${"x".repeat(140)}" />`);
    expect(html).not.toContain("x".repeat(141));
  });

  it("HTML-escapes dangerous characters while preserving Unicode", async () => {
    const raw = `he said <b>"wait"</b> & didn't — сюрприз`;
    const kv = new Map<string, string>([
      [VALID_ID_A, makeManifest({ capsuleId: VALID_ID_A, description: raw })],
    ]);
    const { context } = makeContext({
      capsuleId: VALID_ID_A,
      kv,
      ip: "10.2.0.4",
    });

    const html = await getBody(await onRequestGet(context));

    expect(html).not.toContain("<b>");
    expect(html).toContain(
      "he said &lt;b&gt;&quot;wait&quot;&lt;/b&gt; &amp; didn&#x27;t — сюрприз"
    );
  });

  it("uses the canonical OG image and live origin", async () => {
    const kv = new Map<string, string>([
      [VALID_ID_A, makeManifest({ capsuleId: VALID_ID_A, description: "d" })],
    ]);
    const { context } = makeContext({
      capsuleId: VALID_ID_A,
      kv,
      ip: "10.2.0.5",
    });

    const html = await getBody(await onRequestGet(context));

    expect(html).toContain(
      `${SITE}/og/aeterna-og-1200x630.png`
    );
    expect(html).not.toContain("aeternacapsule.com");
    expect(html).not.toContain("og-cover.png");
  });
});

describe("capsule OG preview — secrets and privacy", () => {
  it("never reflects recipientSecret, creatorAuthority, or ciphertext", async () => {
    const SECRET = "f".repeat(64);
    const AUTHORITY = "e".repeat(64);
    const CIPHERTEXT = "Q2lwaGVydGV4dA==";

    const kv = new Map<string, string>([
      [
        VALID_ID_A,
        makeManifest({
          capsuleId: VALID_ID_A,
          description: "public text only",
          extra: {
            recipientSecret: SECRET,
            creatorAuthority: AUTHORITY,
            ciphertext: CIPHERTEXT,
          },
        }),
      ],
    ]);
    const { context } = makeContext({
      capsuleId: VALID_ID_A,
      kv,
      ip: "10.3.0.1",
    });

    const html = await getBody(await onRequestGet(context));

    expect(html).not.toContain(SECRET);
    expect(html).not.toContain(AUTHORITY);
    expect(html).not.toContain(CIPHERTEXT);
    expect(html).toContain("public text only");
  });

  it("never emits a URL fragment (secret stays client-side only)", async () => {
    const kv = new Map<string, string>([
      [VALID_ID_A, makeManifest({ capsuleId: VALID_ID_A, description: "d" })],
    ]);
    const { context } = makeContext({
      capsuleId: VALID_ID_A,
      kv,
      ip: "10.3.0.2",
    });

    const html = await getBody(await onRequestGet(context));

    // URL-bearing attributes must be fragment-free (the secret can
    // only ever live in the client-side location.hash).
    const urlValues = [
      ...(html.match(/href="([^"]*)"/g) ?? []),
      ...(html.match(/property="og:url" content="([^"]*)"/g) ?? []),
    ];
    for (const value of urlValues) {
      expect(value).not.toContain("#");
    }
    expect(html).toContain(`href="${SITE}/capsule/${VALID_ID_A}"`);
  });
});

describe("capsule OG preview — per-capsule isolation", () => {
  it("never cross-contaminates previews between two capsules", async () => {
    const descA = "capsule A private-ish public text";
    const descB = "capsule B completely different text";
    const kv = new Map<string, string>([
      [VALID_ID_A, makeManifest({ capsuleId: VALID_ID_A, description: descA })],
      [VALID_ID_B, makeManifest({ capsuleId: VALID_ID_B, description: descB })],
    ]);

    const { context: contextA } = makeContext({
      capsuleId: VALID_ID_A,
      kv,
      ip: "10.4.0.1",
    });
    const { context: contextB } = makeContext({
      capsuleId: VALID_ID_B,
      kv,
      ip: "10.4.0.2",
    });

    const htmlA = await getBody(await onRequestGet(contextA));
    const htmlB = await getBody(await onRequestGet(contextB));

    expect(htmlA).toContain(descA);
    expect(htmlA).not.toContain(descB);
    expect(htmlB).toContain(descB);
    expect(htmlB).not.toContain(descA);

    expect(htmlA).toContain(`canonical" href="${SITE}/capsule/${VALID_ID_A}"`);
    expect(htmlB).toContain(`canonical" href="${SITE}/capsule/${VALID_ID_B}"`);

    const cacheA =
      (await onRequestGet(
        makeContext({ capsuleId: VALID_ID_A, kv, ip: "10.4.0.3" }).context
      ) as Response).headers.get("cache-control") ?? "";

    expect(cacheA).toContain("max-age");
  });
});

describe("capsule OG preview — fallbacks", () => {
  it("falls back to the normal SPA when the manifest is missing", async () => {
    const { context, nextResponses } = makeContext({
      capsuleId: VALID_ID_MISSING,
      ip: "10.5.0.1",
    });

    const response = await onRequestGet(context);

    expect(nextResponses).toHaveLength(1);
    expect(await response.text()).toContain("<title>SPA</title>");
  });

  it("falls back to the normal SPA on a malformed capsuleId", async () => {
    const { context, nextResponses } = makeContext({
      capsuleId: "not-a-valid-id",
      ip: "10.5.0.2",
    });

    const response = await onRequestGet(context);

    expect(nextResponses).toHaveLength(1);
    expect(await response.text()).toContain("<title>SPA</title>");
  });

  it("falls back to the normal SPA when the KV binding is unavailable", async () => {
    const { context, nextResponses } = makeContext({
      capsuleId: VALID_ID_A,
      ip: "10.5.0.3",
    });
    (context as { env: Record<string, unknown> }).env =
      {} as unknown as Record<string, unknown>;

    const response = await onRequestGet(context);

    expect(nextResponses).toHaveLength(1);
    expect(await response.text()).toContain("<title>SPA</title>");
  });

  it("falls back to the generic AETERNA description when description is empty", async () => {
    const kv = new Map<string, string>([
      [VALID_ID_A, makeManifest({ capsuleId: VALID_ID_A, description: "" })],
    ]);
    const { context } = makeContext({
      capsuleId: VALID_ID_A,
      kv,
      ip: "10.5.0.4",
    });

    const html = await getBody(await onRequestGet(context));

    expect(html).toContain(
      "A non-custodial digital time capsule. Time decides. Not people."
    );
  });

  it("falls back to the generic description when description is whitespace-only", async () => {
    const kv = new Map<string, string>([
      [VALID_ID_A, makeManifest({ capsuleId: VALID_ID_A, description: "   " })],
    ]);
    const { context } = makeContext({
      capsuleId: VALID_ID_A,
      kv,
      ip: "10.5.0.5",
    });

    const html = await getBody(await onRequestGet(context));

    expect(html).toContain(
      "A non-custodial digital time capsule. Time decides. Not people."
    );
  });

  it("falls back to the normal SPA when the manifest is corrupt JSON", async () => {
    const kv = new Map<string, string>([
      [VALID_ID_A, "{{{ not json"],
    ]);
    const { context, nextResponses } = makeContext({
      capsuleId: VALID_ID_A,
      kv,
      ip: "10.5.0.6",
    });

    const response = await onRequestGet(context);

    expect(nextResponses).toHaveLength(1);
    expect(await response.text()).toContain("<title>SPA</title>");
  });
});

describe("capsule OG preview — buildOgHtml unit", () => {
  it("escapes the five dangerous characters and preserves Unicode", () => {
    const html = buildOgHtml({
      title: "AETERNA — Digital Time Capsule",
      description: `&<>"' — тест`,
      url: `${SITE}/capsule/${VALID_ID_A}`,
    });

    expect(html).toContain("&amp;&lt;&gt;&quot;&#x27; — тест");
  });

  it("emits a fragment-free canonical URL", () => {
    const html = buildOgHtml({
      title: "AETERNA — Digital Time Capsule",
      description: "d",
      url: `${SITE}/capsule/${VALID_ID_A}`,
    });

    const urlValues = [
      ...(html.match(/href="([^"]*)"/g) ?? []),
      ...(html.match(/property="og:url" content="([^"]*)"/g) ?? []),
    ];
    for (const value of urlValues) {
      expect(value).not.toContain("#");
    }
    expect(html).toContain(`href="${SITE}/capsule/${VALID_ID_A}"`);
  });
});
