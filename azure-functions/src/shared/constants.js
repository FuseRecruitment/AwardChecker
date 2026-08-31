/**
 * Shared Table Storage key names.
 *
 * Extracted here because both the HTTP endpoints (synced-rates.js,
 * sync-log.js) and the Timer Trigger sync (sync-timer.js) need to agree
 * on exactly which row they're reading and writing. Keeping two
 * separate copies of these strings risked one being edited without the
 * other -- a classic way to end up silently reading and writing
 * different rows.
 */

export const SYNCED_RATES_KEY = "fuse-synced-rates";
export const SYNC_LOG_KEY = "fuse-sync-log";
export const SYNC_LOG_MAX_ENTRIES = 50;
