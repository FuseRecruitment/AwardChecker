/**
 * Shared "last synced rates" store, backed by Vercel KV.
 *
 * WHY THIS EXISTS:
 * Without this, a successful sync only lived in the browser that
 * clicked the button (originally not persisted at all; then patched to
 * persist per-browser via localStorage). Neither of those helps the
 * team as a whole -- if Sally syncs on her laptop, Tom's phone still
 * shows built-in rates until HE also clicks sync. This endpoint gives
 * everyone one shared, server-side "last synced" state instead.
 *
 * GET  /api/synced-rates  -> { rates: {...} | null, savedAt: <ms> | null }
 * POST /api/synced-rates  -> body { rates: {...} }, saves it with a
 *                            server-set timestamp, returns { ok: true, savedAt }
 *
 * ACCESS CONTROL:
 * This route sits behind the same whole-site password gate as
 * everything else (middleware.js) -- no separate auth needed here.
 * Only someone who's already logged into the tool can read or write
 * this shared cache.
 *
 * SETUP (one-time):
 * 1. Vercel dashboard -> your project -> Storage tab -> Create Database
 *    -> KV -> give it any name (e.g. "fuse-rates-cache") -> Connect to
 *    this project. This automatically adds the KV_REST_API_URL /
 *    KV_REST_API_TOKEN environment variables -- no manual env var
 *    typing needed.
 * 2. Add "@vercel/kv" to package.json's dependencies (already done in
 *    the version of package.json shipped alongside this file).
 * 3. Deploy as normal.
 *
 * PROJECT LAYOUT:
 *   your-project/
 *     package.json       <-- now includes @vercel/kv as a dependency
 *     middleware.js
 *     api/
 *       award-rates.js
 *       synced-rates.js  <-- this file
 *     public/
 *       index.html
 */

import { kv } from "@vercel/kv";

export const config = { runtime: "edge" };

const KV_KEY = "fuse-synced-rates";

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  try {
    if (request.method === "GET") {
      const stored = await kv.get(KV_KEY);
      if (!stored) {
        return json({ rates: null, savedAt: null }, 200);
      }
      return json({ rates: stored.rates, savedAt: stored.savedAt }, 200);
    }

    if (request.method === "POST") {
      const body = await request.json();
      if (!body || typeof body.rates !== "object") {
        return json({ error: "Expected JSON body with a 'rates' object" }, 400);
      }
      const savedAt = Date.now();
      await kv.set(KV_KEY, { rates: body.rates, savedAt });
      return json({ ok: true, savedAt }, 200);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    // Most likely cause: the KV database hasn't been created/connected
    // yet (see SETUP above) -- process.env.KV_REST_API_URL etc. won't
    // exist, and @vercel/kv throws when it can't find them.
    return json({ error: "Shared rate store unavailable", detail: String(err) }, 502);
  }
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}
