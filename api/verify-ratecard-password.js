/**
 * Verifies the Rate Card lock's password server-side, so the real
 * password lives only in a Vercel environment variable -- never in the
 * client-side HTML/JS where anyone viewing page source could see it.
 *
 * POST /api/verify-ratecard-password
 *   body: { password: "whatever the user typed" }
 *   returns: { ok: true } or { ok: false }
 *
 * SETUP:
 * 1. Vercel dashboard -> your project -> Settings -> Environment
 *    Variables -> add RATE_CARD_PASSWORD (Production + Preview) with
 *    whatever plain password you want the team to use.
 * 2. Deploy.
 * No hashing step needed here -- the comparison happens entirely on
 * the server, so the plain password never has to leave Vercel's
 * environment variables or reach the browser.
 *
 * HONEST LIMITATION (same as before, just re-stated for this version):
 * This still only gates whether the Rate Card TAB is shown -- it's not
 * protecting genuinely secret data (the award rates are public Fair
 * Work figures either way). This is about limiting casual access to
 * your margin/pricing process, not defending a secret at rest.
 */

export const config = { runtime: "edge" };

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const expected = process.env.RATE_CARD_PASSWORD;
  if (!expected) {
    return json({ error: "RATE_CARD_PASSWORD is not set on this deployment" }, 500);
  }

  try {
    const body = await request.json();
    const submitted = body && body.password;
    return json({ ok: submitted === expected }, 200);
  } catch (err) {
    return json({ error: "Invalid request body" }, 400);
  }
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}
