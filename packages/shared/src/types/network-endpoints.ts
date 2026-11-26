import type { EndpointRow, RunEndpointSummary } from './run';

/**
 * WHAT THE RUN ASKED THE APPLICATION FOR, one row per endpoint.
 *
 * `summariseRunNetwork` answers "how many 403s were there"; this answers "which
 * endpoint, how often, from which modules, and how slow at worst". They are two
 * questions over one set of records, so they are two functions over one validated
 * shape rather than two passes that could disagree about what a request is.
 *
 * ## Three things are never in a row, and two of them are never even read
 *
 * - **No query string.** `tests/apps/ecom/network.ts` already drops it at
 *   recording time, and `templatePath` drops it again here. That is deliberate
 *   duplication: this module is what writes a file that leaves the machine, so it
 *   does not get to rely on an upstream promise. A query carries filter values and
 *   record ids from a live system.
 * - **No headers and no bodies.** Not recorded anywhere, so there is nothing to
 *   strip. An `Authorization` header is the obvious one; a `Set-Cookie` is the one
 *   people forget.
 * - **No id-like path segment.** `/api/tax/4821` and `/api/tax/4822` are one
 *   endpoint called twice, not two endpoints — and the number is a real record's
 *   identifier from a live customer system.
 */

/** One request, as the per-test attachment records it, plus its duration. */
export interface EndpointRequestInput {
  method?: unknown;
  path?: unknown;
  status?: unknown;
  sameOrigin?: unknown;
  durationMs?: unknown;
}

/** One test's records, with the module the reporter resolved for it. */
export interface EndpointTestInput {
  /** `null` when the title gave no module — never the string "null". */
  module: string | null;
  requests: ReadonlyArray<EndpointRequestInput>;
}

/**
 * HOW MANY ROWS REACH `run.json`, and why there is a cap at all.
 *
 * A content-hashed asset is a distinct path per build, and a run that visits 29
 * modules can produce several hundred rows. `run.json` is read by the API, parsed
 * by the Command Box and archived for every run, so it carries a bounded head and
 * `api-calls.csv` carries all of them.
 *
 * The cap is paired with `total` in `RunEndpointSummary`, never left to be
 * inferred from the array's length: "200 endpoints" and "the first 200 of 413" are
 * different facts, and a reader who cannot tell them apart will quote the wrong one.
 */
export const MAX_ENDPOINTS_IN_RUN_JSON = 200;

/**
 * How many module names a row names before it stops listing them.
 *
 * `moduleCount` carries the true number for the same reason `total` does above. An
 * endpoint every module calls is the common case here — the shell's own bundles —
 * and printing 29 names in a table cell helps nobody.
 */
export const MAX_MODULES_PER_ENDPOINT = 8;

/** The module name used in a row when the test's title gave none. */
export const UNKNOWN_MODULE = '(no module)';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALL_DIGITS = /^\d+$/;
const LONG_HEX = /^[0-9a-f]{16,}$/i;
/** An opaque token: long, mixed, and made only of the characters ids are made of. */
const TOKEN_SHAPED = /^[A-Za-z0-9_-]{12,}$/;

/**
 * Is this path segment an identifier rather than a name?
 *
 * An ALLOWLIST of id SHAPES, not a denylist of known-good words (§AC). The four
 * shapes, and what each is for:
 *
 *  - all digits — `/api/tax/4821`, the ordinary case
 *  - a GUID — `/api/runs/3f2a…`, the other ordinary case
 *  - 16+ hex characters — a digest used as an id
 *  - 12+ characters of `[A-Za-z0-9_-]` CONTAINING A DIGIT — an opaque token
 *
 * The last one is the one that earns its place, and the digit requirement is what
 * keeps it honest: `purchase-orders` is 15 characters of exactly those characters
 * and must survive, while `aBc123XyZ789Qq` must not. A human-written path segment
 * is a word; a generated one almost always carries a digit.
 *
 * It is deliberately not perfect, and the failure direction was chosen: a segment
 * this misses becomes its own row in a CSV, which is noise. A segment it wrongly
 * collapses merges two endpoints, which is a wrong number. Noise is the cheaper
 * mistake, so the rules are narrow.
 */
export function isIdLike(segment: string): boolean {
  if (ALL_DIGITS.test(segment)) return true;
  if (GUID.test(segment)) return true;
  if (LONG_HEX.test(segment)) return true;
  return TOKEN_SHAPED.test(segment) && /\d/.test(segment);
}

/**
 * `/api/tax/4821?include=all` becomes `/api/tax/:id`.
 *
 * The query and fragment go first and unconditionally — before any segment is even
 * looked at — because everything after `?` is values, and a value is the one thing
 * this file exists to keep out of a report.
 */
export function templatePath(raw: string): string {
  const withoutQuery = raw.split('?')[0]!.split('#')[0]!;
  return withoutQuery
    .split('/')
    .map((segment) => (isIdLike(segment) ? ':id' : segment))
    .join('/');
}

interface Valid {
  method: string;
  path: string;
  status: number;
  sameOrigin: boolean;
  durationMs: number;
}

/**
 * A malformed entry is SKIPPED, exactly as `summariseRunNetwork` skips it.
 *
 * `durationMs` is the one field that may legitimately be absent — it was added
 * after the first records were written — so it degrades to 0 rather than voiding
 * the row. Everything else that identifies a request is required, because a row
 * with a guessed method or a guessed origin is a confident wrong answer in a table
 * somebody reads.
 */
function validate(entry: EndpointRequestInput): Valid | null {
  const { method, path, status, sameOrigin, durationMs } = entry;
  if (typeof method !== 'string' || method === '') return null;
  if (typeof path !== 'string' || path === '') return null;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100) return null;
  if (typeof sameOrigin !== 'boolean') return null;
  const duration =
    typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0
      ? durationMs
      : 0;
  return { method, path, status, sameOrigin, durationMs: duration };
}

/** `200×40, 304×12` — ascending by code, so the healthy majority reads first. */
export function formatStatusMix(byStatus: Record<string, number>): string {
  const entries = Object.entries(byStatus).sort(([a], [b]) => Number(a) - Number(b));
  return entries.length === 0 ? '(none)' : entries.map(([code, n]) => `${code}×${n}`).join(', ');
}

/** True when this endpoint answered 4xx or 5xx at least once. */
export function hasErrorStatus(row: Pick<EndpointRow, 'byStatus'>): boolean {
  return Object.keys(row.byStatus).some((code) => Number(code) >= 400);
}

/**
 * THE ORDER, which is a decision and not an accident.
 *
 * Specified for this report as: anything that returned 4xx or 5xx first, app
 * origin before third-party WITHIN that group, then everything by call count.
 *
 * The parenthetical placement is why `sameOrigin` is compared only among failures:
 * among healthy endpoints the useful order is "what did this run hammer", and
 * hoisting every app-origin 200 above a third-party one would bury a chatty
 * third-party call that is the actual reason a suite is slow. If that turns out to
 * be the wrong call it is this comparator and one test, not a rewrite.
 */
export function compareEndpoints(a: EndpointRow, b: EndpointRow): number {
  const aFails = hasErrorStatus(a);
  const bFails = hasErrorStatus(b);
  if (aFails !== bFails) return aFails ? -1 : 1;
  if (aFails && bFails && a.sameOrigin !== b.sameOrigin) return a.sameOrigin ? -1 : 1;
  if (a.calls !== b.calls) return b.calls - a.calls;
  if (a.api !== b.api) return a.api.localeCompare(b.api);
  return a.method.localeCompare(b.method);
}

/**
 * Every endpoint this run touched, ordered, with nothing truncated.
 *
 * The caller decides what to cap: `api-calls.csv` takes all of these and
 * `run.json` takes `boundEndpoints` of them. One list, two renderings — the same
 * discipline `sheet-drift` already follows, and for the same reason: a mail saying
 * `403×1` and a CSV with no such row is a contradiction nobody can resolve.
 */
export function summariseEndpoints(perTest: ReadonlyArray<EndpointTestInput>): EndpointRow[] {
  interface Acc {
    method: string;
    api: string;
    sameOrigin: boolean;
    calls: number;
    byStatus: Record<string, number>;
    modules: Set<string>;
    maxDurationMs: number;
  }
  const rows = new Map<string, Acc>();

  for (const test of perTest) {
    const module = test.module ?? UNKNOWN_MODULE;
    for (const raw of test.requests) {
      const request = validate(raw);
      if (!request) continue;
      const api = templatePath(request.path);
      // Keyed on method, templated path AND origin. Origin is in the key because a
      // path can legitimately exist on both — `/api/health` on the app and on a
      // third-party probe — and merging them would attribute somebody else's
      // failure to the application under test.
      const key = `${request.method} ${api} ${request.sameOrigin ? 'app' : '3p'}`;
      let row = rows.get(key);
      if (!row) {
        row = {
          method: request.method,
          api,
          sameOrigin: request.sameOrigin,
          calls: 0,
          byStatus: {},
          modules: new Set<string>(),
          maxDurationMs: 0,
        };
        rows.set(key, row);
      }
      row.calls += 1;
      const code = String(request.status);
      row.byStatus[code] = (row.byStatus[code] ?? 0) + 1;
      row.modules.add(module);
      if (request.durationMs > row.maxDurationMs) row.maxDurationMs = request.durationMs;
    }
  }

  return [...rows.values()]
    .map((row) => {
      const modules = [...row.modules].sort();
      return {
        method: row.method,
        api: row.api,
        sameOrigin: row.sameOrigin,
        calls: row.calls,
        byStatus: row.byStatus,
        // FULL here. Every consumer bounds for itself, and `moduleCount` is the
        // authority either way — a row whose `modules` has been capped still says
        // how many there really were.
        modules,
        moduleCount: modules.length,
        maxDurationMs: row.maxDurationMs,
      } satisfies EndpointRow;
    })
    .sort(compareEndpoints);
}

/**
 * The bounded head that goes into `run.json`, with the true totals beside it.
 *
 * Two caps, because `run.json` is archived for every run, parsed by the API and
 * searched by the Command Box:
 *   - at most `MAX_ENDPOINTS_IN_RUN_JSON` rows, with `total` giving the real count
 *   - at most `MAX_MODULES_PER_ENDPOINT` names per row, with the row's own
 *     `moduleCount` giving the real count
 *
 * Both totals survive the cap on purpose. "200 endpoints" and "the first 200 of
 * 413" are different facts, and a reader who cannot tell them apart will quote the
 * wrong one — the whole argument for welding a number to its assumption.
 */
export function boundEndpoints(all: ReadonlyArray<EndpointRow>): RunEndpointSummary {
  return {
    total: all.length,
    shown: Math.min(all.length, MAX_ENDPOINTS_IN_RUN_JSON),
    rows: all.slice(0, MAX_ENDPOINTS_IN_RUN_JSON).map((row) => ({
      ...row,
      modules: row.modules.slice(0, MAX_MODULES_PER_ENDPOINT),
    })),
  };
}

/** The header `api-calls.csv` carries, and the order its columns are written in. */
export const API_CALLS_CSV_HEADER = [
  'Method',
  'API',
  'Origin',
  'Calls',
  'Status codes',
  'Max ms',
  'Modules',
] as const;

const csvCell = (value: string): string =>
  /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

/**
 * EVERY endpoint, as CSV. No cap of any kind — this is the file the mail points at.
 *
 * Give it the rows from `summariseEndpoints`, never the ones from
 * `boundEndpoints`: the whole reason the mail and `run.json` may truncate is that
 * this file does not, and a CSV built from a bounded list would leave the answer
 * nowhere. That is a real mistake to make, so the row count is asserted against
 * `moduleCount` by the unit test rather than left to the caller's memory.
 */
export function apiCallsCsv(all: ReadonlyArray<EndpointRow>): string {
  const lines = [API_CALLS_CSV_HEADER.join(',')];
  for (const row of all) {
    lines.push(
      [
        csvCell(row.method),
        csvCell(row.api),
        csvCell(row.sameOrigin ? 'app' : 'third-party'),
        String(row.calls),
        csvCell(formatStatusMix(row.byStatus)),
        String(row.maxDurationMs),
        csvCell(row.modules.join(' | ')),
      ].join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}
