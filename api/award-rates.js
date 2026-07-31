/**
 * Vercel Edge Function proxy for the Fair Work Commission
 * Modern Awards Pay Database (MAPD) API.
 *
 * WHY THIS EXISTS:
 * - The rate card tool is a static HTML file with no server of its own.
 * - The MAPD API needs a registered API key sent server-side.
 * - Browsers won't let the HTML file call a keyed government API
 *   directly (no CORS on their end, and the key would be exposed
 *   in the page source anyway).
 * - This function holds the key as a server-side environment variable,
 *   calls FWC on the tool's behalf, and returns plain JSON.
 *
 * PROJECT LAYOUT (put this file in the same Vercel project as the tool):
 *   your-project/
 *     api/
 *       award-rates.js   <-- this file
 *     public/
 *       index.html       <-- fuse-rate-card-tool.html, renamed
 *
 * With this layout, the tool and the proxy are on the SAME domain once
 * deployed (e.g. https://fuse-rates.vercel.app/ and
 * https://fuse-rates.vercel.app/api/award-rates), so there's no CORS
 * problem to solve at all -- the fetch in the tool can just call
 * "/api/award-rates" as a relative path.
 *
 * SETUP:
 * 1. Add this file at api/award-rates.js in your Vercel project.
 * 2. In the Vercel dashboard: Project -> Settings -> Environment
 *    Variables -> add FWC_API_KEY (Production + Preview) with the
 *    key FWC issued you.
 * 3. Deploy (git push if git-connected, or `vercel --prod` via CLI).
 * 4. Test: https://<your-project>.vercel.app/api/award-rates?award=MA000010
 *
 * TODO ONCE YOU HAVE FWC'S ACTUAL API DOCS:
 * - Replace FWC_API_BASE below with the real base URL from your
 *   developer portal credentials.
 * - Replace the auth header name/scheme below (this assumes a
 *   simple "Ocp-Apim-Subscription-Key" / "x-api-key" style header --
 *   confirm the exact header name in your API docs).
 * - Confirm the award lookup path/query params (this assumes you
 *   look up by award code, e.g. MA000010).
 */

export const config = { runtime: "edge" };

const FWC_API_BASE = "https://api.fwc.gov.au/mapd/v1"; // <-- replace with real base URL

export default async function handler(request) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  const awardCode = url.searchParams.get("award"); // e.g. MA000010
  if (!awardCode) {
    return json({ error: "Missing ?award=MA000010 query param" }, 400);
  }

  try {
    const upstream = await fetch(`${FWC_API_BASE}/awards/${awardCode}/pay-rates`, {
      headers: {
        // Confirm exact header name/scheme against your FWC docs.
        "Ocp-Apim-Subscription-Key": process.env.FWC_API_KEY,
        "Accept": "application/json"
      }
    });

    if (!upstream.ok) {
      return json(
        { error: `FWC API responded ${upstream.status}`, detail: await safeText(upstream) },
        upstream.status
      );
    }

    const data = await upstream.json();
    return json(data, 200);
  } catch (err) {
    return json({ error: "Proxy fetch failed", detail: String(err) }, 502);
  }
}

function corsHeaders() {
  return {
    // Same-origin when hosted alongside the tool on Vercel, so this is
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
