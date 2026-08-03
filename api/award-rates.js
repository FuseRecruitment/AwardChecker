/**
 * Vercel Edge Function proxy for the Fair Work Commission
 * Modern Awards Pay Database (MAPD) API.
 *
 * CONFIRMED against a real, live response (not a guess):
 *
 * - Base URL: https://api.fwc.gov.au/api/v1/awards
 * - Auth header: Ocp-Apim-Subscription-Key: <your key>
 * - GET /awards?limit=100  -> paginated list of every award, each row
 *   has BOTH a `code` (e.g. "MA000010") and a separate numeric
 *   `award_fixed_id` (e.g. 10). These are NOT interchangeable in the
 *   pay-rates endpoint below -- confirmed by testing MA000010 and
 *   MA000002 directly against /awards/{code}/pay-rates, which both
 *   returned a clean 404 "Resource not found" from FWC itself.
 * - GET /awards/{award_fixed_id}/pay-rates  -> pay rates for that award,
 *   keyed by the NUMERIC award_fixed_id, not the MA0000xx code.
 *   Supports ?employee_rate_type_code=AD (adult rates only) and
 *   ?limit=100 with pagination via _meta.page_count / &page=N.
 * - Response shape: { results: [ { classification_fixed_id, classification,
 *   classification_level, base_rate_type, base_rate,
 *   calculated_rate_type, calculated_rate, employee_rate_type_code, ... } ],
 *   _meta: { page_count, ... } }
 *   A row with calculated_rate_type === "Hourly" is the one you want;
 *   calculated_rate is the dollar figure.
 *
 * So this function does it in two steps for a given ?award=MA000010:
 *   1. Look up MA000010 in the awards list -> get its award_fixed_id.
 *   2. Call pay-rates using that award_fixed_id.
 * The awards list rarely changes, so the code -> fixed_id map is cached
 * in memory for the life of the warm function instance (best-effort --
 * a cold start just re-fetches it, which is fine).
 *
 * WHY A PROXY AT ALL:
 * The rate card tool is a static HTML file with no server of its own,
 * and this API needs a registered subscription key sent with every
 * call. Browsers can't be trusted to hold that key (visible in page
 * source) and the API isn't meant to be hit directly from arbitrary
 * browser origins. This function holds the key server-side (as a
 * Vercel environment variable), calls FWC on the tool's behalf, and
 * hands back a simplified JSON shape the tool can use directly.
 *
 * ACCESS CONTROL ON THIS ENDPOINT ITSELF:
 * Without anything extra, this endpoint is wide open -- anyone who
 * finds the URL can call it directly and burn through your FWC quota.
 * Two layers of defence, added below:
 *
 *  1. Shared secret. The tool sends a token (as an `x-proxy-token`
 *     header, or a `?token=` query param for manual browser testing)
 *     that must match the PROXY_SHARED_SECRET environment variable.
 *     Honest caveat: because the tool is a static HTML file, this
 *     token is visible to anyone who views its page source. This is
 *     NOT a real secret in the cryptographic sense -- it's a filter
 *     that stops opportunistic bots/scanners hitting the endpoint
 *     without ever having loaded the tool, which is the overwhelming
 *     majority of "random hammering." Someone who deliberately reads
 *     the deployed HTML's source can still find it and bypass this.
 *  2. Best-effort rate limiting. A simple per-warm-instance counter
 *     caps requests per IP per minute. This is NOT a guaranteed global
 *     limit (Vercel Edge runs many isolates, each with its own
 *     counter), but it does blunt a single script hammering the
 *     endpoint in a tight loop from one place. For a hard guarantee,
 *     the real fix is Vercel KV / Upstash Redis-backed rate limiting,
 *     which is a bigger change (adds a dependency + build step) --
 *     worth doing if this proves insufficient in practice.
 *
 * PROJECT LAYOUT (same Vercel project as the tool, so it's same-origin):
 *   your-project/
 *     package.json      <-- needs "type": "module"
 *     api/
 *       award-rates.js  <-- this file
 *     public/
 *       index.html      <-- fuse-rate-card-tool.html, renamed
 *
 * SETUP:
 * 1. Add this file at api/award-rates.js in your Vercel project.
 * 2. Vercel dashboard -> Project -> Settings -> Environment Variables:
 *    - FWC_API_KEY (Production + Preview) -- your FWC subscription key.
 *    - PROXY_SHARED_SECRET (Production + Preview) -- any long random
 *      string you generate yourself (e.g. run
 *      `openssl rand -hex 24` in a terminal, or use a password
 *      generator for a 32+ character string). This is NOT the FWC key
 *      -- it's a separate secret just for this endpoint.
 * 3. Put that SAME string into the tool's FWC_PROXY_TOKEN constant
 *    (see fuse-rate-card-tool.html) so the two sides match.
 * 4. Deploy (git push, or `vercel --prod` via CLI).
 * 5. Test: https://<your-project>.vercel.app/api/award-rates?award=MA000010&token=<your-secret>
 *
 * STILL WORTH CONFIRMING:
 * - This wrapper matches classifications back to the rate card by RANK
 *   ORDER (lowest-paid to highest-paid), not by name, since the tool's
 *   own classification ids (like "C14") aren't FWC's classification_fixed_id.
 *   If FWC returns a different number of classifications than the tool
 *   expects for an award, the tool skips that award rather than guess --
 *   check the sync status message if that happens.
 */

export const config = { runtime: "edge" };

const FWC_API_BASE = "https://api.fwc.gov.au/api/v1/awards";
const RATE_LIMIT_MAX = 20;       // requests
const RATE_LIMIT_WINDOW_MS = 60000; // per minute, per warm instance

// In-memory cache of code -> award_fixed_id, populated on first use in
// a given warm instance. Cold starts just rebuild it -- harmless, one
// extra request.
let awardIdCache = null;

// Best-effort rate limiter state -- see caveat in the comment block above.
let rateLimitState = new Map();

export default async function handler(request) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  // --- Layer 1: shared secret ---
  const expectedSecret = process.env.PROXY_SHARED_SECRET;
  if (!expectedSecret) {
    return json({ error: "PROXY_SHARED_SECRET is not set on this deployment" }, 500);
  }
  const providedSecret = request.headers.get("x-proxy-token") || url.searchParams.get("token");
  if (providedSecret !== expectedSecret) {
    return json({ error: "Unauthorized" }, 401);
  }

  // --- Layer 2: best-effort rate limit ---
  const clientIp = request.headers.get("x-forwarded-for") || "unknown";
  const now = Date.now();
  const entry = rateLimitState.get(clientIp);
  if (entry && now - entry.windowStart < RATE_LIMIT_WINDOW_MS) {
    if (entry.count >= RATE_LIMIT_MAX) {
      return json({ error: "Too many requests -- slow down and try again shortly" }, 429);
    }
    entry.count++;
  } else {
    rateLimitState.set(clientIp, { count: 1, windowStart: now });
  }

  const awardCode = url.searchParams.get("award"); // e.g. MA000010
  if (!awardCode) {
    return json({ error: "Missing ?award=MA000010 query param" }, 400);
  }

  const apiKey = process.env.FWC_API_KEY;
  if (!apiKey) {
    return json({ error: "FWC_API_KEY is not set on this deployment" }, 500);
  }

  const headers = {
    "Ocp-Apim-Subscription-Key": apiKey,
    "Accept": "application/json"
  };

  try {
    const fixedId = await lookupAwardFixedId(awardCode, headers);
    if (!fixedId) {
      return json({ error: `Award code ${awardCode} not found in FWC's awards list` }, 404);
    }

    // Adult rates only (AD) -- excludes junior/apprentice/trainee rows,
    // which the tool's local classification list doesn't model.
    const allRows = await fetchAllPages(
      `${FWC_API_BASE}/${fixedId}/pay-rates?employee_rate_type_code=AD&limit=100`,
      headers
    );

    // Keep only the hourly figure per classification -- FWC also returns
    // weekly base rates in the same list, which we don't want here.
    const hourlyRows = allRows
      .filter((row) => row.calculated_rate_type === "Hourly")
      .map((row) => ({
        classificationFixedId: row.classification_fixed_id,
        label: row.classification,
        classificationLevel: row.classification_level,
        rate: row.calculated_rate,
        operativeFrom: row.operative_from
      }));

    return json({ award: awardCode, awardFixedId: fixedId, classifications: hourlyRows }, 200);
  } catch (err) {
    return json({ error: "Proxy fetch failed", detail: String(err) }, 502);
  }
}

async function lookupAwardFixedId(awardCode, headers) {
  if (!awardIdCache) {
    const rows = await fetchAllPages(`${FWC_API_BASE}?limit=100`, headers);
    awardIdCache = {};
    rows.forEach((row) => {
      if (row.code) awardIdCache[row.code.toUpperCase()] = row.award_fixed_id;
    });
  }
  return awardIdCache[awardCode.toUpperCase()];
}

async function fetchAllPages(firstUrl, headers) {
  let page = 1;
  let pageCount = 1;
  const rows = [];

  do {
    const pageUrl = firstUrl.includes("?")
      ? (page === 1 ? firstUrl : `${firstUrl}&page=${page}`)
      : (page === 1 ? firstUrl : `${firstUrl}?page=${page}`);
    const res = await fetch(pageUrl, { headers });

    if (!res.ok) {
      const detail = await safeText(res);
      throw new Error(`FWC API responded ${res.status}: ${detail}`);
    }

    const data = await res.json();
    if (Array.isArray(data.results)) rows.push(...data.results);
    pageCount = data._meta && data._meta.page_count ? data._meta.page_count : 1;
    page++;
  } while (page <= pageCount);

  return rows;
}

function corsHeaders() {
  return {
    // Same-origin when hosted alongside the tool on Vercel -- this is
    // mostly a safety net for local testing from a different origin.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}

async function safeText(res) {
  try { return await res.text(); } catch (e) { return ""; }
}
