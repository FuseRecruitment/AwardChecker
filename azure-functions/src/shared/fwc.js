/**
 * Fair Work Commission Modern Awards Pay Database (MAPD) API client.
 *
 * Ported from the Vercel Edge function api/award-rates.js. The FWC
 * behaviour documented there was confirmed against live responses and
 * is unchanged by the move to Azure -- it is restated here in short:
 *
 * - Base URL: https://api.fwc.gov.au/api/v1/awards
 * - Auth header: Ocp-Apim-Subscription-Key
 * - An award has BOTH a code ("MA000010") and a separate numeric
 *   award_fixed_id (10). The pay-rates endpoint only accepts the
 *   NUMERIC id, so every lookup is two steps: resolve code -> id, then
 *   fetch rates by id.
 * - Pay-rates returns every historical version of each classification's
 *   rate, so the caller has to pick the most recent one already in
 *   effect. That filtering happens here.
 *
 * WHY THIS IS ITS OWN MODULE NOW:
 * On Vercel this logic lived inside the HTTP handler, because the HTTP
 * handler was the only thing that ever called FWC -- the daily sync ran
 * in the browser and looped over this endpoint. In Azure the scheduled
 * sync runs server-side (Timer Trigger), and it needs exactly the same
 * lookup. Extracting it here means one implementation, not two that can
 * drift apart.
 *
 * CACHING CHANGE FROM VERCEL:
 * The code -> award_fixed_id map was cached in memory for the life of a
 * warm Edge isolate. That still works the same way here (module scope
 * persists across invocations on a warm instance, rebuilds on cold
 * start) -- harmless either way, it is one extra request.
 */

const FWC_API_BASE = "https://api.fwc.gov.au/api/v1/awards";

let awardIdCache = null;

function apiHeaders() {
    const apiKey = process.env.FWC_API_KEY;
    if (!apiKey) {
          throw new Error("FWC_API_KEY is not configured on this Function App");
    }
    return {
          "Ocp-Apim-Subscription-Key": apiKey,
          Accept: "application/json"
    };
}

/**
 * Walk FWC's pagination (_meta.page_count) and return every row.
 */
async function fetchAllPages(firstUrl, headers) {
    let page = 1;
    let pageCount = 1;
    const rows = [];

  do {
        const separator = firstUrl.includes("?") ? "&" : "?";
        const pageUrl = page === 1 ? firstUrl : `${firstUrl}${separator}page=${page}`;
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

async function safeText(res) {
    try {
          return await res.text();
    } catch {
          return "";
    }
}

/**
 * Resolve an award code ("MA000010") to FWC's numeric award_fixed_id.
 * Returns undefined when FWC does not list that code.
 */
export async function lookupAwardFixedId(awardCode) {
    const headers = apiHeaders();
    if (!awardIdCache) {
          const rows = await fetchAllPages(`${FWC_API_BASE}?limit=100`, headers);
          awardIdCache = {};
          rows.forEach((row) => {
                  if (row.code) awardIdCache[row.code.toUpperCase()] = row.award_fixed_id;
          });
    }
    return awardIdCache[awardCode.toUpperCase()];
}

/**
 * Fetch the current hourly adult rates for one award code.
 *
 * Returns { award, awardFixedId, classifications: [...] } -- the same
 * shape the Vercel endpoint returned, so the frontend needs no change.
 * Throws if the award code is unknown to FWC.
 */
export async function getAwardRates(awardCode) {
    const headers = apiHeaders();

  const fixedId = await lookupAwardFixedId(awardCode);
    if (!fixedId) {
          const err = new Error(`Award code ${awardCode} not found in FWC's awards list`);
          err.notFound = true;
          throw err;
    }

  // Adult rates only (AD) -- excludes junior/apprentice/trainee rows,
  // which the tool's local classification list does not model.
  const allRows = await fetchAllPages(
        `${FWC_API_BASE}/${fixedId}/pay-rates?employee_rate_type_code=AD&limit=100`,
        headers
      );

  // FWC also returns weekly base rates in the same list -- keep hourly.
  const hourlyRows = allRows
      .filter((row) => row.calculated_rate_type === "Hourly")
      .map((row) => ({
              classificationFixedId: row.classification_fixed_id,
              label: row.classification,
              classificationLevel: row.classification_level,
              rate: row.calculated_rate,
              operativeFrom: row.operative_from
      }));

  // Keep only the most recent version already in effect for each
  // classification -- some of these awards go back to 2010, so this can
  // otherwise be 10-20+ rows per classification.
  const today = new Date().toISOString().slice(0, 10);
    const currentByClassification = new Map();
    hourlyRows.forEach((row) => {
          if (!row.operativeFrom || row.operativeFrom.slice(0, 10) > today) return; // not yet in effect
                           const existing = currentByClassification.get(row.classificationFixedId);
          if (!existing || row.operativeFrom > existing.operativeFrom) {
                  currentByClassification.set(row.classificationFixedId, row);
          }
    });

  return {
        award: awardCode,
        awardFixedId: fixedId,
        classifications: Array.from(currentByClassification.values())
  };
}
