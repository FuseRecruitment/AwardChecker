/**
 * Shared sync log, backed by the same Upstash Redis used for the
 * synced rates themselves.
 *
 * WHY THIS EXISTS:
 * /api/synced-rates only ever holds the CURRENT rates -- there's no
 * history. This endpoint keeps a running log of every sync attempt
 * (when it happened, which awards updated, which needed review) so
 * the team can see a trail of what's changed over time, not just the
 * latest snapshot.
 *
 * GET  /api/sync-log   -> { entries: [ {...}, ... ] }  (newest first)
 * POST /api/sync-log   -> body is one log entry (any JSON-serialisable
 *                         object); appended to the front of the list,
 *                         older entries trimmed beyond MAX_ENTRIES.
 *
 * ACCESS CONTROL:
 * Same as everything else -- sits behind the whole-site password gate
 * in middleware.js. No separate auth needed here.
 *
 * HONEST LIMITATION:
 * There's no individual login in this tool, just one shared site
 * password -- so a log entry can say WHEN a sync happened and WHAT it
 * did, but not WHO specifically triggered it. If that becomes
 * important later, it needs real per-user accounts, which is a much
 * bigger change than this tool currently has.
 *
 * SETUP: none beyond what synced-rates.js already needs -- same
 * UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN environment
 * variables, already configured if synced-rates.js is working.
 */

import { Redis } from "@upstash/redis";

export const config = { runtime: "edge" };

const LOG_KEY = "fuse-sync-log";
const MAX_ENTRIES = 50;

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  try {
    const redis = Redis.fromEnv();

    if (request.method === "GET") {
      const entries = (await redis.get(LOG_KEY)) || [];
      return json({ entries: entries }, 200);
    }

    if (request.method === "POST") {
      const entry = await request.json();
      if (!entry || typeof entry !== "object") {
        return json({ error: "Expected a JSON log entry in the request body" }, 400);
      }
      entry.loggedAt = Date.now(); // server-set, not trusted from the client

      const existing = (await redis.get(LOG_KEY)) || [];
      const updated = [entry, ...existing].slice(0, MAX_ENTRIES);
      await redis.set(LOG_KEY, updated);

      return json({ ok: true, count: updated.length }, 200);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    return json({ error: "Sync log unavailable", detail: String(err) }, 502);
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
