/**
 * AETERNA — Capsule Route Handler
 *
 * GET /capsule/:capsuleId
 *
 * Spec §28: OG Preview Model
 */

import type { EventContext } from "@cloudflare/workers-types";
import { rateLimit, getClientIp } from "../lib/rateLimit";
import { getTrustedTime } from "../api/time";
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

const SITE_URL  = "https://aeternacapsule.com";
const SITE_NAME = "AETERNA Capsule";
const OG_IMAGE  = `${SITE_URL}/og/og-cover.png`;

/**
 * NOTE on isCrawler(): this is a UX/perf routing decision, not a
 * security boundary. Any client can spoof one of these User-Agent
 * substrings to receive the static OG HTML instead of the SPA shell.
 * That's acceptable here because the OG branch only ever serves
 * already-public preview fields (openAt, truncated description) —
 * nothing secret is gated behind crawler detection. The actual
 * abuse control for this branch is the IP-based rateLimit() call
 * below, which applies regardless of what User-Agent is presented.
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

function formatUTCDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "2-digit",
    timeZone: "UTC",
  });
}

function buildOgHtml(params: {
  title: string;
  description: string;
  openAt: string;
  url: string;
  updatedTimeSec: number;
}): string {

  const { title, description, openAt, url, updatedTimeSec } = params;

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

<meta property="og:type" content="article" />
<meta property="og:locale" content="en_US" />
<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}" />
<meta property="og:url" content="${escapeHtml(url)}" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:image" content="${escapeHtml(OG_IMAGE)}" />
<meta property="og:image:secure_url" content="${escapeHtml(OG_IMAGE)}" />
<meta property="og:image:type" content="image/png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="AETERNA Capsule preview" />

<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(title)}" />
<meta name="twitter:description" content="${escapeHtml(description)}" />
<meta name="twitter:image" content="${escapeHtml(OG_IMAGE)}" />
<meta name="twitter:image:alt" content="AETERNA Capsule preview" />

<meta property="og:updated_time" content="${updatedTimeSec}" />
<meta http-equiv="content-language" content="en" />

</head>

<body>

<p>Opens on: ${escapeHtml(openAt)}</p>
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
   * Browser → SPA passthrough
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
   * Validate capsuleId
   */

  const capsuleId = params?.capsuleId;

  if (
    !capsuleId ||
    typeof capsuleId !== "string" ||
    !CAPSULE_ID_REGEX.test(capsuleId)
  ) {
    return new Response("Not Found", {
      status: 404,
    });
  }

  /**
   * KV binding check
   */

  if (!bindings?.CAPSULE_MANIFESTS) {

    console.error(
      "[og] CAPSULE_MANIFESTS binding unavailable"
    );

    return new Response("Service Unavailable", {
      status: 503,
    });
  }

  /**
   * Load manifest
   */

  let raw: string | null = null;

  try {

    raw = await bindings.CAPSULE_MANIFESTS.get(capsuleId);

  } catch {

    return new Response("Service Unavailable", {
      status: 503,
    });

  }

  if (!raw) {

    return new Response("Not Found", {
      status: 404,
    });

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

    return new Response("Not Found", {
      status: 404,
    });

  }

  /**
   * Validate minimal safe fields only
   */

  if (
    manifest.version !== 1 ||
    manifest.capsuleId !== capsuleId ||
    typeof manifest.openAt !== "number" ||
    !Number.isSafeInteger(manifest.openAt)
  ) {

    return new Response("Not Found", {
      status: 404,
    });

  }

  /**
   * Format preview data
   */

  const openAtFormatted = formatUTCDate(
    manifest.openAt as number
  );

  const rawDescription =
    typeof manifest.description === "string"
      ? manifest.description.slice(0, 140)
      : null;

  const title = rawDescription
    ? `"${rawDescription}" — AETERNA Capsule`
    : "AETERNA Time Capsule";

  const description =
    `Sealed and time-locked. Opens on ${openAtFormatted} (UTC). ` +
    `Created with AETERNA — zero-knowledge digital time capsule protocol.`;

  const canonicalUrl =
    `${SITE_URL}/capsule/${capsuleId}`;

  const { nowUtc } = await getTrustedTime();

  const html = buildOgHtml({

    title,
    description,
    openAt: openAtFormatted,
    url: canonicalUrl,
    updatedTimeSec: Math.floor(nowUtc / 1000)

  });

  return new Response(html, {

    status: 200,

    headers: {

      "Content-Type":
        "text/html; charset=utf-8",

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