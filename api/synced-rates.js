/**
 * Shared "last synced rates" store, backed by Upstash Redis.
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
 * WHY UPSTASH DIRECTLY, NOT VERCEL'S "REDIS" MARKETPLACE PRODUCT:
 * Vercel's Storage tab now routes Redis through a marketplace
 * integration that requires a paid plan. The actual underlying service
 * is Upstash either way -- signing up directly at upstash.com gives you
 * the same Redis, with a genuinely free tier, without needing Vercel Pro.
 *
 * SETUP (one-time):
 * 1. Sign up at https://upstash.com (free, no card required).
 * 2. Create a Redis database on the free tier.
 * 3. On that database's page, find the REST API section -- copy the
 *    URL and token shown there.
 * 4. Vercel dashboard -> your project -> Settings -> Environment
 *    Variables -> add both (Production + Preview), using these exact
 *    names (Upstash's own dashboard uses this naming by convention,
 *    so this should just work without renaming anything):
 *      UPSTASH_REDIS_REST_URL
 *      UPSTASH_REDIS_REST_TOKEN
 * 5. Deploy as normal.
 *
 * PROJECT LAYOUT:
 *   your-project/
 *     package.json       <-- now includes @upstash/redis as a dependency
 *     middleware.js
 *     api/
 *       award-rates.js
 *       synced-rates.js  <-- this file
 *     public/
 *       index.html
 */

import { Redis } from "@upstash/redis";

export const config = { runtime: "edge" };

const STORE_KEY = "fuse-synced-rates";

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  try {
    const redis = Redis.fromEnv(); // reads UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN

    if (request.method === "GET") {
      const stored = await redis.get(STORE_KEY);
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
      await redis.set(STORE_KEY, { rates: body.rates, savedAt });
      return json({ ok: true, savedAt }, 200);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    // Most likely cause: the Upstash environment variables aren't set
    // yet (see SETUP above) -- Redis.fromEnv() throws when it can't
    // find UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.
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
