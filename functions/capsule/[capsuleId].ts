/**
 * AETERNA — Capsule Route Handler
 *
 * GET /capsule/:capsuleId#<recipientSecret>
 *
 * Crawler-facing social preview layer (Spec §28: OG Preview Model).
 *
 * Security model:
 * - The URL fragment (#recipientSecret / #c=creatorAuthority) is
 *   client-side only and NEVER reaches this function — it cannot be
 *   reflected into any response.
 * - Only public manifest metadata (description) is ever served here.
 * - Browsers (non-crawlers) pass straight through to the SPA; the
 *   capsule URL format and application behavior are unchanged.
 */

import type { EventContext } from "@cloudflare/workers-types";
import { rateLimit, getClientIp } from "../lib/rateLimit";
import { CAPSULE_ID_REGEX } from "../../src/lib/crypto/validators";

/**
 * Canonical plain-object guard.
 * Mirrors the shared guard used across the AETERNA API layer —
 * accepts both Object.prototype and null-prototype objects.
 */
function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

interface OgEnv {
  CAPSULE_MANIFESTS: KVNamespace;
}

/**
 * Single-point origin configuration.
 *
 * Switching to the future canonical domain is a ONE-LINE change here
 * (plus the static index.html meta). Do not scatter absolute URLs.
 */
const SITE_URL = "https://aeterna-solana.pages.dev";
const SITE_NAME = "AETERNA";
const OG_IMAGE_PATH = "/og/aeterna-og-1200x630.png";
const OG_IMAGE = `${SITE_URL}${OG_IMAGE_PATH}`;
const OG_IMAGE_WIDTH = 1733;
const OG_IMAGE_HEIGHT = 908;

const FALLBACK_TITLE = "AETERNA — Digital Time Capsule";
const FALLBACK_DESCRIPTION =
  "A non-custodial digital time capsule. Time decides. Not people.";

/**
 * Canonical creator description limit (client enforces the same
 * value in CapsuleBuilder: MAX_DESCRIPTION = 140).
 */
const OG_DESCRIPTION_LIMIT = 140;

/**
 * NOTE on isCrawler(): this is a UX/perf routing decision, not a
 * security boundary. Any client can spoof one of these User-Agent
 * substrings to receive the static OG HTML instead of the SPA shell.
 * That's acceptable here because the OG branch only ever serves
 * already-public preview fields (the creator description) — nothing
 * secret is gated behind crawler detection. The actual abuse control
 * for this branch is the IP-based rateLimit() call below, which
 * applies regardless of what User-Agent is presented.
 */

const CRAWLER_UA_PATTERNS = [
  "facebookexternalhit",
  "twitterbot",
  "whatsapp",
  "telegrambot",
  "linkedinbot",
  "slackbot",
  "discordbot",
  "googlebot",
  "bingbot",
  "applebot",
  "iframely",
  "embedly",
];

function isCrawler(userAgent: string): boolean {
  const ua = userAgent.toLowerCase();
  return CRAWLER_UA_PATTERNS.some((p) => ua.includes(p));
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

export function buildOgHtml(params: {
  title: string;
  description: string;
  url: string;
}): string {

  const { title, description, url } = params;

  return `<!DOCTYPE html>
<html lang="en">
<head>

<meta charset="UTF-8" />
<title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="theme-color" content="#0d0f14" />

<meta name="description" content="${escapeHtml(description)}" />
<meta name="robots" content="noindex, nofollow" />

<link rel="canonical" href="${escapeHtml(url)}" />

<meta property="og:type" content="website" />
<meta property="og:locale" content="en_US" />
<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}" />
<meta property="og:url" content="${escapeHtml(url)}" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:image" content="${escapeHtml(OG_IMAGE)}" />
<meta property="og:image:secure_url" content="${escapeHtml(OG_IMAGE)}" />
<meta property="og:image:type" content="image/png" />
<meta property="og:image:width" content="${OG_IMAGE_WIDTH}" />
<meta property="og:image:height" content="${OG_IMAGE_HEIGHT}" />
<meta property="og:image:alt" content="AETERNA — Digital Time Capsule" />

<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(title)}" />
<meta name="twitter:description" content="${escapeHtml(description)}" />
<meta name="twitter:image" content="${escapeHtml(OG_IMAGE)}" />
<meta name="twitter:image:alt" content="AETERNA — Digital Time Capsule" />

<meta http-equiv="content-language" content="en" />

</head>

<body>

<p><a href="${escapeHtml(url)}">Open capsule</a></p>

</body>
</html>`;
}

export const onRequestGet = async (
  context: EventContext<Record<string, unknown>, string, OgEnv>
) => {

  const { request, env, params } = context;

  const bindings = env as unknown as OgEnv;

  const userAgent = request.headers.get("user-agent") ?? "";

  /**
   * Browser → SPA passthrough.
   * The capsule URL (including its fragment) is untouched; the SPA
   * bootstraps exactly as it does without this function.
   */

  if (!isCrawler(userAgent)) {
    return context.next();
  }

  /**
   * Rate limit crawler access
   */

  const ip = getClientIp(request);

  if (!rateLimit(ip)) {
    return new Response("Too Many Requests", {
      status: 429,
    });
  }

  /**
   * Validate capsuleId.
   *
   * Malformed id → normal SPA (client renders its canonical
   * NotFound view); never an error page a crawler could miscast.
   */

  const capsuleId = params?.capsuleId;

  if (
    !capsuleId ||
    typeof capsuleId !== "string" ||
    !CAPSULE_ID_REGEX.test(capsuleId)
  ) {
    return context.next();
  }

  /**
   * KV binding check
   */

  if (!bindings?.CAPSULE_MANIFESTS) {

    console.error(
      "[og] CAPSULE_MANIFESTS binding unavailable"
    );

    return context.next();
  }

  /**
   * Load manifest
   */

  let raw: string | null = null;

  try {

    raw = await bindings.CAPSULE_MANIFESTS.get(capsuleId);

  } catch {

    return context.next();

  }

  if (!raw) {

    return context.next();

  }

  /**
   * Parse manifest safely
   */

  let manifest: Record<string, unknown>;

  try {

    const parsed = JSON.parse(raw);

    if (!isPlainObject(parsed)) {
      throw new Error();
    }

    manifest = parsed;

  } catch {

    return context.next();

  }

  /**
   * Validate minimal safe fields only
   */

  if (
    manifest.version !== 1 ||
    manifest.capsuleId !== capsuleId
  ) {

    return context.next();

  }

  /**
   * Creator description ONLY — exactly the text the creator typed
   * into "Capsule Description". No title/name derivation, no
   * capsuleId, no secrets, no encrypted content.
   */

  const description =
    typeof manifest.description === "string" &&
    manifest.description.trim().length > 0
      ? manifest.description.slice(0, OG_DESCRIPTION_LIMIT)
      : FALLBACK_DESCRIPTION;

  const html = buildOgHtml({
    title: FALLBACK_TITLE,
    description,
    url: `${SITE_URL}/capsule/${capsuleId}`
  });

  return new Response(html, {

    status: 200,

    headers: {

      "Content-Type":
        "text/html; charset=utf-8",

      /**
       * Cache key is the full request path (unique per capsuleId),
       * so previews of different capsules can never share an edge
       * or browser cache entry. Sealed manifests are immutable;
       * the short max-age only bounds crawler staleness.
       */

      "Cache-Control":
        "public, max-age=300, stale-while-revalidate=600",

      "X-Content-Type-Options":
        "nosniff",

      "X-Robots-Tag":
        "noindex, nofollow",

      "Referrer-Policy":
        "no-referrer",

      "Content-Security-Policy":
        "default-src 'none'; img-src https:; style-src 'unsafe-inline';"

    }

  });

};
