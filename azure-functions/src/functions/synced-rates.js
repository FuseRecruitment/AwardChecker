/**
 * Shared "last synced rates" store.
 *
 *   GET  /api/synced-rates -> { rates: {...} | null, savedAt: <ms> | null }
 *   POST /api/synced-rates -> body { rates: {...} }, saves with a
 *                             server-set timestamp, returns { ok, savedAt }
 *
 * WHY THIS EXISTS (unchanged from the Vercel version):
 * Without it, a successful sync only lived in the browser that ran it.
 * This gives the whole team one shared server-side "last synced" state,
 * so a sync by one person is visible to everyone.
 *
 * PORTED FROM: Vercel Edge function api/synced-rates.js
 *
 * WHAT CHANGED IN THE MOVE:
 *
 * 1. Storage backend: Upstash Redis -> Azure Table Storage.
 *    The Vercel version used @upstash/redis with Redis.fromEnv(),
 *    reading UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN. Those
 *    credentials were a shared bearer token in app settings. The Azure
 *    version uses the Function App's managed identity instead, so there
 *    is no storage credential to hold, rotate or leak.
 *    The read/write shape is deliberately identical (get/set of a JSON
 *    value under one key), so the logic below is otherwise unchanged.
 *
 * 2. Runtime: Edge -> standard Node. No behavioural difference here;
 *    this function does no Edge-specific work.
 *
 * 3. Access control: the Vercel version relied on the whole-site
 *    password gate in middleware.js. That is replaced by Entra ID
 *    sign-in, which is enforced at the platform layer before any
 *    request reaches this code.
 *
 * DATA MIGRATION NOTE:
 * The existing Upstash value for this key was exported during the
 * migration and needs loading into Table Storage under the same key
 * name, so the tool does not show "never synced" on cutover.
 */

import { app } from "@azure/functions";
import { get, set } from "../shared/store.js";
import { json, preflight } from "../shared/http.js";

const STORE_KEY = "fuse-synced-rates";
const METHODS = "GET, POST";

app.http("synced-rates", {
    methods: ["GET", "POST", "OPTIONS"],
    authLevel: "anonymous", // Entra Easy Auth gates this at the platform layer
    handler: async (request, context) => {
          if (request.method === "OPTIONS") {
                  return preflight(METHODS);
          }

      try {
              if (request.method === "GET") {
                        const stored = await get(STORE_KEY);
                        if (!stored) {
                                    return json({ rates: null, savedAt: null }, 200, METHODS);
                        }
                        return json({ rates: stored.rates, savedAt: stored.savedAt }, 200, METHODS);
              }

            if (request.method === "POST") {
                      const body = await request.json();
                      if (!body || typeof body.rates !== "object" || body.rates === null) {
                                  return json({ error: "Expected JSON body with a 'rates' object" }, 400, METHODS);
                      }
                      const savedAt = Date.now(); // server-set, not trusted from the client
                await set(STORE_KEY, { rates: body.rates, savedAt });
                      return json({ ok: true, savedAt }, 200, METHODS);
            }

            return json({ error: "Method not allowed" }, 405, METHODS);
      } catch (err) {
              context.error("Shared rate store failed", err);
              return json({ error: "Shared rate store unavailable", detail: String(err) }, 502, METHODS);
      }
    }
});
