/**
 * Daily scheduled sync of award rates from Fair Work.
 *
 * WHY THIS EXISTS:
 * There has never been a scheduled sync -- on Vercel, "sync" meant a
 * person clicking the "Check for latest award rates" button in the
 * browser, which ran entirely client-side (see public/index.html).
 * This Timer Trigger is a genuinely new build, not a port of existing
 * server-side code: it re-implements that browser-only logic to run
 * unattended, once a day, so rates are current before the team starts
 * work without anyone having to remember to click sync.
 *
 * SCHEDULE:
 * NCRONTAB "0 0 16 * * *" = 16:00 UTC = 2:00am AEST (UTC+10).
 *
 * CAVEAT: this is a fixed UTC offset, so it does NOT track daylight
 * saving. In states that observe AEDT (UTC+11) it will fire at 1:00am
 * local time during DST, not 2:00am. If the team is in a DST-observing
 * state and the exact local time matters, the fix is to set the
 * WEBSITE_TIME_ZONE app setting to "AUS Eastern Standard Time" (Windows
 * tz id, honoured by Azure Functions on Windows/Flex Consumption) so
 * the schedule below is interpreted in local time instead of UTC.
 * Left as a fixed UTC offset here since it wasn't confirmed which
 * state's calendar applies -- flagged for Fuse to confirm.
 *
 * WHAT THIS PORTS FROM THE FRONTEND, AND WHY IT HAD TO BE PORTED:
 * The frontend's sync button read FWC data via the (now-retired)
 * proxy, matched it against classifications by name (see
 * shared/awards.js for the correction to older "rank order"
 * documentation), and diffed against its own in-memory AWARDS object
 * to log what changed. A Timer Trigger has no browser session and no
 * long-lived memory between runs, so "the current rates" and "what
 * changed" both need a durable source -- that's the Table Storage
 * snapshot from synced-rates.js, read and updated here directly via
 * shared/store.js rather than via an HTTP self-call.
 *
 * WHAT'S DELIBERATELY UNCHANGED:
 * The matching rule (name-based, via matchKey), the "one unmatched
 * classification doesn't skip the whole award" safety rule, and the
 * "log every attempt regardless of outcome" behaviour are all carried
 * over as-is from the frontend -- see shared/awards.js.
 *
 * ONE BEHAVIOUR CHANGE FROM THE FRONTEND:
 * The frontend only pushed to the shared store when totalUpdated > 0.
 * That's preserved here for the rates snapshot (no pointless writes
 * when nothing changed) -- but a log entry is always written, exactly
 * as the frontend did, including for a fully failed run.
 */

import { app } from "@azure/functions";
import { getAwardRates } from "../shared/fwc.js";
import { AWARDS, applyFwcRates } from "../shared/awards.js";
import { get, set } from "../shared/store.js";
import { SYNCED_RATES_KEY, SYNC_LOG_KEY, SYNC_LOG_MAX_ENTRIES } from "../shared/constants.js";

function friendlyError(err) {
    if (err && err.notFound) return "not found in the Fair Work database";
    const message = String(err && err.message ? err.message : err);
    if (message.includes("FWC_API_KEY")) return "FWC_API_KEY is not configured";
    return message;
}

async function runDailySync(context) {
    const awardKeys = Object.keys(AWARDS);

  const stored = (await get(SYNCED_RATES_KEY)) || { rates: {} };
    const rates = { ...stored.rates };

  let totalUpdated = 0;
    const failures = [];
    const skippedAwards = [];
    const partialAwards = [];
    const allChanges = [];

  for (const key of awardKeys) {
        const award = AWARDS[key];
        try {
                const fwcResult = await getAwardRates(award.code);
                const currentForAward = rates[key] || {};
                const result = applyFwcRates(key, currentForAward, fwcResult.classifications || []);

          if (result.skipped) {
                    skippedAwards.push(`${award.code} (${result.reason})`);
                    continue;
          }

          rates[key] = result.updatedRates;
                totalUpdated += result.updated;

          if (result.unmatched.length > 0) {
                    partialAwards.push(`${award.code} (couldn't find: ${result.unmatched.join(", ")})`);
          }
                if (result.changes.length > 0) {
                          allChanges.push(...result.changes);
                }
        } catch (err) {
                failures.push(`${award.code} — ${friendlyError(err)}`);
        }
  }

  const outcome = failures.length === 0 && skippedAwards.length === 0 && partialAwards.length === 0 ? "ok" : "err";

  // Only write the snapshot when something actually changed -- avoids
  // pointless writes on a no-op day, same as the frontend's behaviour.
  if (totalUpdated > 0) {
        await set(SYNCED_RATES_KEY, { rates, savedAt: Date.now() });
  }

  // Always log the attempt, whatever the outcome -- a fully failed run
  // is still worth a record, same as the frontend's behaviour.
  const entry = {
        awardsAttempted: awardKeys.length,
        totalUpdated,
        failures,
        skippedAwards,
        partialAwards,
        changes: allChanges,
        outcome,
        loggedAt: Date.now()
  };
    const existingLog = (await get(SYNC_LOG_KEY)) || [];
    await set(SYNC_LOG_KEY, [entry, ...existingLog].slice(0, SYNC_LOG_MAX_ENTRIES));

  context.log(
        `Daily award sync: ${totalUpdated} rate(s) updated, ${failures.length} failure(s), ` +
          `${skippedAwards.length} skipped, ${partialAwards.length} partial. Outcome: ${outcome}.`
      );

  if (failures.length > 0) {
        context.warn("Sync failures:", failures);
  }
}

app.timer("sync-timer", {
    schedule: "0 0 16 * * *", // 16:00 UTC = 2:00am AEST -- see DST caveat above
    handler: async (myTimer, context) => {
          if (myTimer.isPastDue) {
                  context.warn("Timer trigger is running late");
          }
          try {
                  await runDailySync(context);
          } catch (err) {
                  // A totally unexpected failure (e.g. Table Storage itself
            // unreachable) -- log it loudly rather than let the function
            // fail silently with no record anywhere.
            context.error("Daily award sync failed unexpectedly", err);
                  throw err;
          }
    }
});
