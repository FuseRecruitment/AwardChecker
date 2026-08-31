/**
 * Shared sync log -- a running history of every sync attempt.
 *
 *   GET  /api/sync-log -> { entries: [ {...}, ... ] }  (newest first)
 *   POST /api/sync-log -> body is one log entry (any JSON object);
 *                         prepended to the list, older entries trimmed
 *                         beyond MAX_ENTRIES.
 *
 * WHY THIS EXISTS (unchanged from the Vercel version):
 * /api/synced-rates only holds the CURRENT rates, with no history. This
 * keeps a trail of when each sync ran and what it changed.
 *
 * PORTED FROM: Vercel Edge function api/sync-log.js
 *
 * WHAT CHANGED IN THE MOVE:
 *
 * 1. Storage backend: Upstash Redis -> Azure Table Storage, via managed
 *    identity. Same get/set-a-JSON-value shape, so the trim-to-50 logic
 *    below is unchanged. See shared/store.js for the reasoning.
 *
 * 2. Runtime: Edge -> standard Node. No behavioural difference.
 *
 * 3. The "who triggered it" limitation is now FIXABLE, though not fixed
 *    here. The Vercel version noted honestly that it could record WHEN a
 *    sync happened and WHAT it did, but never WHO -- because the tool had
 *    one shared site password and no individual logins. With Entra ID
 *    sign-in there IS now a real per-user identity available on each
 *    request (via the x-ms-client-principal header Easy Auth injects).
 *    Attributing entries to a named user is deliberately NOT done in this
 *    change, because it is scope beyond a like-for-like port -- but it is
 *    now a small change rather than an impossible one, and worth raising
 *    with Fuse as an option.
 *
 * DATA MIGRATION NOTE:
 * The existing Upstash log (25 entries at time of migration) was
 * exported and needs loading into Table Storage under the same key.
 */

import { app } from "@azure/functions";
import { get, set } from "../shared/store.js";
import { json, preflight } from "../shared/http.js";

const LOG_KEY = "fuse-sync-log";
const MAX_ENTRIES = 50;
const METHODS = "GET, POST";

app.http("sync-log", {
    methods: ["GET", "POST", "OPTIONS"],
    authLevel: "anonymous", // Entra Easy Auth gates this at the platform layer
    handler: async (request, context) => {
          if (request.method === "OPTIONS") {
                  return preflight(METHODS);
          }

      try {
              if (request.method === "GET") {
                        const entries = (await get(LOG_KEY)) || [];
                        return json({ entries }, 200, METHODS);
              }

            if (request.method === "POST") {
                      const entry = await request.json();
                      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
                                  return json({ error: "Expected a JSON log entry in the request body" }, 400, METHODS);
                      }
                      entry.loggedAt = Date.now(); // server-set, not trusted from the client

                const existing = (await get(LOG_KEY)) || [];
                      const updated = [entry, ...existing].slice(0, MAX_ENTRIES);
                      await set(LOG_KEY, updated);

                return json({ ok: true, count: updated.length }, 200, METHODS);
            }

            return json({ error: "Method not allowed" }, 405, METHODS);
      } catch (err) {
              context.error("Sync log failed", err);
              return json({ error: "Sync log unavailable", detail: String(err) }, 502, METHODS);
      }
    }
});
