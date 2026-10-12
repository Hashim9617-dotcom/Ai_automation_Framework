/**
 * WHERE THE API LISTENS, AND WHO MAY CALL IT FROM A BROWSER.
 *
 * Both answers used to be "everyone". `app.listen(port)` with no host binds
 * `::` — measured, and already recorded in this repo at
 * `tests/support/free-port.ts:16` — and `enableCors({ origin: … ?? true })`
 * REFLECTS whatever `Origin` the caller sent. Together, on a machine with a
 * saved session for a customer system, that is an unauthenticated run trigger
 * reachable from the network and from any page the operator happens to visit.
 *
 * ## Pure, and injected
 *
 * Neither function reads `process.env`. A guard that reads the environment is
 * testing the machine it runs on until it SUPPLIES that environment itself
 * (§AJ), and these two decide where a process listens — the one answer that
 * must give the same result on a clean checkout as it does here.
 *
 * ## Ambiguity resolves toward refusal
 *
 * An origin that can never match is a gate that LOOKS open, so a malformed
 * entry is refused by name rather than dropped. `*` is refused for the same
 * reason and one more: dropping it silently would leave an operator believing
 * they had opened the API up, with no header to show otherwise (§AC).
 */

/** Loopback, and the only address reached without an explicit `API_HOST`. */
export const DEFAULT_API_HOST = '127.0.0.1';

/**
 * The address to bind, from `API_HOST` or the loopback default.
 *
 * An empty or whitespace-only value is NOT an override: nobody writes
 * `API_HOST=` meaning "listen on everything". It falls back, which is the
 * fail-closed reading.
 */
export function resolveApiHost(raw: string | undefined): string {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : DEFAULT_API_HOST;
}

/**
 * The exact origins allowed to call this API from a browser.
 *
 * An empty list is the default and means CORS is never enabled at all — no
 * `Access-Control-Allow-Origin` header on any response, so every cross-origin
 * read is blocked by the browser. That is a different thing from an allowlist
 * that happens to match nothing, and the caller treats it as such.
 *
 * @throws when an entry is `*` or is not a bare origin.
 */
export function resolveAllowedOrigins(raw: string | undefined): string[] {
  const entries = (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  for (const entry of entries) {
    if (entry === '*') {
      throw new Error(
        'API_ALLOWED_ORIGINS may not contain "*". A wildcard would let any site on the ' +
          "internet read this API from a logged-in operator's browser. List the exact " +
          'origins instead, comma separated — for example ' +
          'API_ALLOWED_ORIGINS=http://localhost:5173',
      );
    }

    // An `Origin` header is a bare origin: scheme, host and optional port, never
    // a path and never a trailing slash. An entry with either can never equal the
    // header, so it would sit in the config looking like an allowance while
    // matching nothing.
    let parsed: URL;
    try {
      parsed = new URL(entry);
    } catch {
      throw new Error(
        `API_ALLOWED_ORIGINS entry "${entry}" is not a URL. Each entry must be an exact ` +
          'origin such as https://qa.example.com — no path, no trailing slash.',
      );
    }
    if (parsed.origin !== entry) {
      throw new Error(
        `API_ALLOWED_ORIGINS entry "${entry}" is not a bare origin (its origin is ` +
          `"${parsed.origin}"). An Origin header never carries a path or a trailing ` +
          'slash, so this entry could never match anything.',
      );
    }
  }

  return entries;
}
