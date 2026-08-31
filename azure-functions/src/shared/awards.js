/**
 * Award and classification configuration, plus the logic that matches
 * Fair Work's returned classifications back to this tool's simplified
 * local list.
 *
 * PORTED FROM: public/index.html (the AWARDS object, findFwcMatch, and
 * applyFwcRates -- all previously client-side only).
 *
 * IMPORTANT CORRECTION TO EARLIER DOCUMENTATION:
 * The original Vercel proxy (api/award-rates.js) carried a comment
 * claiming classifications were matched back "by RANK ORDER (lowest-
 * paid to highest-paid), not by name." That was never actually true of
 * the shipped tool. The real matching logic -- in the frontend,
 * unchanged here -- matches by NAME: each local classification has a
 * `matchKey` (e.g. "C14") that is tested as a whole-word, case-
 * insensitive pattern against FWC's classification `label` (e.g.
 * "C14 / V1"). Rank order is not used anywhere. This module ports the
 * real (name-based) mechanism, not the one described in the old
 * comment.
 *
 * WHY THIS NEEDS PORTING AT ALL, NOT JUST THE FWC CALL:
 * On the frontend, "the current rates" live in the AWARDS object in
 * browser memory, mutated in place each time a sync runs, with changes
 * detected by diffing against that same in-memory object. There is no
 * equivalent long-lived state in a server-side Timer Trigger -- each
 * run starts fresh. The Timer Trigger (sync-timer.js) uses the last
 * saved snapshot in Table Storage as the "before" state to diff
 * against instead, via applyFwcRates below.
 *
 * SIX AWARDS, NOT SEVEN:
 * This AWARDS object is the tool's actual source of truth for which
 * awards are configured, and it has always had six entries. An earlier
 * assumption of seven awards (before this file was inspected) was
 * simply incorrect from the start, not something that changed over
 * time -- confirmed by both this config and the exported historical
 * sync log, which shows six awards attempted in every one of its 25
 * entries.
 */

export const AWARDS = {
    manufacturing: {
          code: "MA000010",
          classifications: [
            { id: "C14", matchKey: "C14", rate: 25.74 },
            { id: "C13", matchKey: "C13", rate: 26.44 },
            { id: "C12", matchKey: "C12", rate: 27.08 },
            { id: "C11", matchKey: "C11", rate: 27.97 },
            { id: "C10", matchKey: "C10", rate: 29.45 }
                ]
    },
    storage: {
          code: "MA000084",
          classifications: [
            { id: "G1", matchKey: "Grade 1", rate: 27.08 },
            { id: "G2", matchKey: "Grade 2", rate: 27.97 },
            { id: "G3", matchKey: "Grade 3", rate: 28.90 },
            { id: "G4", matchKey: "Grade 4", rate: 29.75 }
                ]
    },
    meat: {
          code: "MA000059",
          classifications: [
            { id: "MI1", matchKey: "MI 1", rate: 25.74 },
            { id: "MI2", matchKey: "MI 2", rate: 26.44 },
            { id: "MI4", matchKey: "MI 4", rate: 27.23 },
            { id: "MI6", matchKey: "MI 6", rate: 27.99 }
                ]
    },
    transport: {
          code: "MA000038",
          classifications: [
            { id: "Grade1", matchKey: "Grade 1", rate: 26.87 },
            { id: "Grade4", matchKey: "Grade 4", rate: 27.90 },
            { id: "Grade7", matchKey: "Grade 7", rate: 29.42 }
                ]
    },
    construction: {
          code: "MA000020",
          // See the frontend's original comment (carried over): FWC splits
          // "Level 1" into four sub-levels (a/b/c/d) with different rates.
          // "Level 1" as a matchKey matches all four -- findFwcMatch takes
          // the first one FWC returns, which happens to line up with these
          // rates. This relies on FWC's response ordering, not an explicit
          // sub-level selector -- worth re-checking if FWC ever reorders it.
          classifications: [
            { id: "CW1", matchKey: "Level 1", rate: 26.67 },
            { id: "CW2", matchKey: "Level 2", rate: 27.60 },
            { id: "CW3", matchKey: "Level 3", rate: 28.85 },
            { id: "CW5", matchKey: "Level 5", rate: 30.10 }
                ]
    },
    clerks: {
          code: "MA000002",
          classifications: [
            { id: "L1", matchKey: "Level 1", rate: 26.97 },
            { id: "L2", matchKey: "Level 2", rate: 29.45 },
            { id: "L3", matchKey: "Level 3", rate: 31.11 },
            { id: "L4", matchKey: "Level 4", rate: 32.67 },
            { id: "L5", matchKey: "Level 5", rate: 33.99 }
                ]
    }
};

/**
 * Find the FWC row matching a local classification's matchKey.
 * Whole-word, case-insensitive -- e.g. matchKey "C14" matches a label
 * of "C14 / V1" but not "C140" or "XC14".
 */
export function findFwcMatch(matchKey, fwcRows) {
    const pattern = new RegExp(`\\b${matchKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    return fwcRows.filter((row) => row.label && pattern.test(row.label))[0];
}

/**
 * Apply FWC's current rates to one award's classifications, diffing
 * against `currentRates` (the last saved snapshot for this award --
 * e.g. { C14: 25.74, C13: 26.44, ... }) rather than a live in-memory
 * object as the frontend does.
 *
 * Returns the same shape the frontend's applyFwcRates produced, plus
 * `updatedRates` (the new rates object to save back), so the caller
 * doesn't have to separately reconstruct it:
 *   { updated, skipped, reason?, unmatched, changes, updatedRates }
 *
 * Safety rule (unchanged from the frontend): if a classification's
 * matchKey isn't found in FWC's response, that ONE classification
 * keeps its existing rate and is reported by name -- not a reason to
 * skip the whole award, since others may still have matched fine.
 */
export function applyFwcRates(awardKey, currentRates, fwcRows) {
    const award = AWARDS[awardKey];
    if (!award || !Array.isArray(fwcRows) || fwcRows.length === 0) {
          return {
                  updated: 0,
                  skipped: true,
                  reason: "no data returned",
                  unmatched: [],
                  changes: [],
                  updatedRates: currentRates
          };
    }

  const updatedRates = { ...currentRates };
    let updated = 0;
    const unmatched = [];
    const changes = []; // only classifications whose rate actually changed

  award.classifications.forEach((local) => {
        const match = findFwcMatch(local.matchKey || local.id, fwcRows);
        const rate = match ? parseFloat(match.rate) : NaN;
        const existing = updatedRates[local.id] ?? local.rate; // fall back to built-in if never synced

                                    if (match && !isNaN(rate)) {
                                            if (rate !== existing) {
                                                      changes.push({ award: award.code, classId: local.id, before: existing, after: rate });
                                            }
                                            updatedRates[local.id] = rate;
                                            updated++;
                                    } else {
                                            unmatched.push(local.id);
                                    }
  });

  if (unmatched.length === award.classifications.length) {
        return {
                updated: 0,
                skipped: true,
                reason: "none of this award's classifications were found in FWC's response",
                unmatched,
                changes: [],
                updatedRates: currentRates
        };
  }

  return { updated, skipped: false, unmatched, changes, updatedRates };
}
