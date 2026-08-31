/**
 * Shared key/value store backed by Azure Table Storage.
 *
 * Replaces the Upstash Redis store used on Vercel. The old code used
 * redis.get(key) / redis.set(key, value) with arbitrary JSON values, so
 * this module keeps that same shape to minimise changes in the callers.
 *
 * WHY TABLE STORAGE:
 * The data is tiny (one rates snapshot, one 50-entry log), read and
 * written a handful of times a day. Table Storage is the cheapest thing
 * in Azure that does this job and it lives in the storage account the
 * Function App already needs, so it adds no new resource.
 *
 * HOW VALUES ARE STORED:
 * Table Storage columns are typed and size-limited (64KB per property),
 * which does not suit arbitrary nested JSON. So each logical key is one
 * row, with the whole value JSON-stringified into a single `Data`
 * column. The caller never sees this -- get() parses it back.
 *
 * AUTH:
 * Uses the Function App's system-assigned managed identity via
 * DefaultAzureCredential. The identity needs the "Storage Table Data
 * Contributor" role on the storage account. No connection string, no
 * key in app settings.
 *
 * Required app setting:
 *   STORAGE_ACCOUNT_NAME   e.g. stawardcheckerprod
 */

import { TableClient } from "@azure/data-tables";
import { DefaultAzureCredential } from "@azure/identity";

const TABLE_NAME = "awardcheckerstate";
const PARTITION_KEY = "state";

let clientPromise = null;

function getClient() {
    if (!clientPromise) {
          const account = process.env.STORAGE_ACCOUNT_NAME;
          if (!account) {
                  throw new Error("STORAGE_ACCOUNT_NAME app setting is not configured");
          }
          const client = new TableClient(
                  `https://${account}.table.core.windows.net`,
                  TABLE_NAME,
                  new DefaultAzureCredential()
                );
          // createTable is idempotent -- it resolves if the table already
      // exists, so this doubles as first-run setup without a separate
      // provisioning step.
      clientPromise = client
            .createTable()
            .catch((err) => {
                      if (err.statusCode !== 409) throw err; // 409 = already exists
            })
            .then(() => client);
    }
    return clientPromise;
}

/**
 * Read a value. Returns null when the key has never been written,
 * matching the old redis.get() behaviour the callers already handle.
 */
export async function get(key) {
    const client = await getClient();
    try {
          const entity = await client.getEntity(PARTITION_KEY, key);
          return entity.Data ? JSON.parse(entity.Data) : null;
    } catch (err) {
          if (err.statusCode === 404) return null;
          throw err;
    }
}

/**
 * Write a value, overwriting anything already there.
 */
export async function set(key, value) {
    const client = await getClient();
    await client.upsertEntity(
      {
              partitionKey: PARTITION_KEY,
              rowKey: key,
              Data: JSON.stringify(value)
      },
          "Replace"
        );
}
