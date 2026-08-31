/**
 * GET /api/award-rates?award=MA000010
 *
 * Server-side proxy to the Fair Work Commission pay-rates API. The tool
 * is a static page and cannot hold the FWC subscription key, so this
 * function holds it and calls FWC on the tool's behalf.
 *
 * PORTED FROM: Vercel Edge function api/award-rates.js
 *
 * WHAT CHANGED IN THE MOVE, AND WHY:
 *
 * 1. Runtime. The Vercel version declared `runtime: "edge"`. Azure has
 *    no Edge equivalent, so this is a standard Node function. The FWC
 *    call logic itself is unaffected.
 *
 * 2. Shared secret (PROXY_SHARED_SECRET) -- REMOVED.
 *    On Vercel this was a token the static HTML sent to prove the
 *    request came from the tool. Its own source comments admitted it
 *    was not a real secret: the token was visible to anyone who viewed
 *    the page source. It was a filter against opportunistic bots, not
 *    real access control, and in the committed HTML it was set to an
 *    empty string, so it was doing nothing at all in practice.
 *    Entra ID sign-in now gates every request to this app with real
 *    per-user authentication, which is strictly stronger. Keeping a
 *    dead shared secret alongside it would imply a protection that
 *    isn't there.
 *
 * 3. Per-IP rate limiter -- REMOVED.
 *    This counted requests per IP in a module-level Map. It was
 *    best-effort even on Vercel (each Edge isolate had its own counter,
 *    so the limit was never global) and it gets weaker on Azure, not
 *    stronger. Its purpose was to stop an anonymous script hammering an
 *    open endpoint and burning the FWC quota -- but the endpoint is no
 *    longer anonymous or open. Anything reaching this code has already
 *    passed Entra sign-in as a named Fuse user.
 *    If FWC quota exhaustion ever becomes a real problem, the honest
 *    fix is a durable counter (Table Storage) or Azure API Management
 *    throttling -- not an in-memory Map that resets on every cold start.
 *
 * 4. FWC lookup logic moved to shared/fwc.js so the scheduled sync can
 *    reuse it instead of re-implementing it.
 *
 * CONFIGURATION:
 *   FWC_API_KEY -- set as a Key Vault reference in the Function App's
 *   app settings, pointing at the FWC-API-KEY secret in
 *   kv-awardchecker-prod. Azure resolves it at runtime, so the code
 *   still just reads process.env.FWC_API_KEY and never handles the
 *   secret itself.
 */

import { app } from "@azure/functions";
import { getAwardRates } from "../shared/fwc.js";
import { json, preflight } from "../shared/http.js";

app.http("award-rates", {
    methods: ["GET", "OPTIONS"],
    authLevel: "anonymous", // Entra Easy Auth gates this at the platform layer
    handler: async (request, context) => {
          if (request.method === "OPTIONS") {
                  return preflight("GET");
          }

      const awardCode = request.query.get("award"); // e.g. MA000010
      if (!awardCode) {
              return json({ error: "Missing ?award=MA000010 query param" }, 400);
      }

      try {
              const result = await getAwardRates(awardCode);
              return json(result, 200);
      } catch (err) {
              if (err.notFound) {
                        return json({ error: err.message }, 404);
              }
              // Config problems are the app's fault, not the caller's -- surface
            // them as 500 so they are not mistaken for an FWC outage.
            if (String(err.message).includes("FWC_API_KEY")) {
                      context.error("FWC_API_KEY missing", err);
                      return json({ error: err.message }, 500);
            }
              context.error("FWC proxy fetch failed", err);
              return json({ error: "Proxy fetch failed", detail: String(err) }, 502);
      }
    }
});
