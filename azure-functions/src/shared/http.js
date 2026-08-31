/**
 * Shared HTTP response helpers.
 *
 * The Vercel version built raw Response objects. Azure Functions' Node
 * v4 model wants a plain object back instead, so these wrap that.
 *
 * CORS NOTE:
 * Still wildcard, carried over unchanged from the Vercel code. This is
 * a known open item (logged as a low-severity issue on the delivery
 * board) -- it should be locked down to the Fuse domain and the
 * Bullhorn origin, but that is deliberately deferred so the migration
 * stays a like-for-like port first.
 */

export function corsHeaders(methods) {
    return {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": `${methods}, OPTIONS`,
          "Access-Control-Allow-Headers": "Content-Type"
    };
}

export function json(obj, status, methods = "GET") {
    return {
          status,
          headers: { "Content-Type": "application/json", ...corsHeaders(methods) },
          body: JSON.stringify(obj)
    };
}

export function preflight(methods) {
    return { status: 204, headers: corsHeaders(methods) };
}
