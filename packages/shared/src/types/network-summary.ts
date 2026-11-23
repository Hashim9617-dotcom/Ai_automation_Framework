import type { FailingEndpoint, RunNetworkSummary } from './run';

/**
 * AGGREGATING A RUN'S REQUESTS, as a pure function.
 *
 * ## Why it lives here and not in the reporter
 *
 * The reporter reads attachment FILES off disk; this decides what the numbers
 * mean. Keeping them apart is what lets the meaning be tested with synthetic data
 * — no browser, no run, no application — which matters because the thing most
 * likely to be wrong is the split, not the file reading.
 *
 * ## The shape it consumes
 *
 * One record per test, exactly as `tests/apps/ecom/network.ts` writes it. The
 * fields are named there and read here, which is a coupling — so `requests` is
 * validated per entry rather than trusted, and an entry that is not a request is
 * skipped rather than counted as a zero-status one.
 */

/** One request, as the per-test attachment records it. */
export interface NetworkSummaryInput {
  method?: unknown;
  path?: unknown;
  status?: unknown;
  sameOrigin?: unknown;
}

const ALLOWED_READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** How many endpoints the summary names. More is a log, fewer is not a signal. */
export const TOP_FAILING_ENDPOINTS = 5;

interface Valid {
  method: string;
  path: string;
  status: number;
  sameOrigin: boolean;
}

/**
 * A malformed entry is SKIPPED, not coerced.
 *
 * A missing `status` coerced to 0 would land in `byStatus['0']` and look like a
 * category of response; a missing `sameOrigin` defaulted to `true` would blame the
 * application for somebody else's failure. Both are confident wrong answers, so an
 * entry that is not a request is simply not one.
 */
function validate(entry: NetworkSummaryInput): Valid | null {
  const { method, path, status, sameOrigin } = entry;
  if (typeof method !== 'string' || method === '') return null;
  if (typeof path !== 'string' || path === '') return null;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100) return null;
  if (typeof sameOrigin !== 'boolean') return null;
  return { method, path, status, sameOrigin };
}

const bump = (into: Record<string, number>, key: string): void => {
  into[key] = (into[key] ?? 0) + 1;
};

/**
 * Builds the run-level summary from every test's records.
 *
 * `testsReporting` is part of the result rather than something a caller counts,
 * because every other number here is meaningless without it: `appByStatus: {}` from
 * a run where nothing was instrumented and from a run that made no requests are the
 * same object, and only this field tells them apart (§T, as a field).
 */
export function summariseRunNetwork(
  perTest: ReadonlyArray<ReadonlyArray<NetworkSummaryInput>>,
): RunNetworkSummary {
  const byStatus: Record<string, number> = {};
  const appByStatus: Record<string, number> = {};
  const thirdPartyByStatus: Record<string, number> = {};
  const failing = new Map<string, FailingEndpoint>();
  let totalRequests = 0;
  let appWriteAttempts = 0;
  let testsReporting = 0;

  for (const records of perTest) {
    // A test that recorded an EMPTY list still reported — it ran with the
    // instrumentation and saw nothing. Only a test with no record at all is absent,
    // and the caller does not pass one for those.
    testsReporting += 1;
    for (const raw of records) {
      const request = validate(raw);
      if (!request) continue;
      totalRequests += 1;
      const code = String(request.status);
      bump(byStatus, code);
      bump(request.sameOrigin ? appByStatus : thirdPartyByStatus, code);

      if (request.sameOrigin && !ALLOWED_READ_METHODS.has(request.method)) {
        appWriteAttempts += 1;
      }

      if (request.status >= 400) {
        // Keyed on method+path+status, so one endpoint failing two different ways
        // is two rows. Merging them would hide a 403 behind a 404.
        const key = `${request.method} ${request.path} ${request.status}`;
        const existing = failing.get(key);
        if (existing) existing.count += 1;
        else {
          failing.set(key, {
            method: request.method,
            path: request.path,
            status: request.status,
            count: 1,
            sameOrigin: request.sameOrigin,
          });
        }
      }
    }
  }

  const topFailingEndpoints = [...failing.values()]
    .sort(
      (a, b) =>
        b.count - a.count ||
        // APP-ORIGIN FIRST on a tie: it is the half somebody has to act on.
        Number(b.sameOrigin) - Number(a.sameOrigin) ||
        a.path.localeCompare(b.path),
    )
    .slice(0, TOP_FAILING_ENDPOINTS);

  return {
    totalRequests,
    byStatus,
    appByStatus,
    thirdPartyByStatus,
    appWriteAttempts,
    topFailingEndpoints,
    testsReporting,
  };
}

/** `200:41 403:12` — one line for a report or a subject line. */
export function formatStatusCounts(byStatus: Record<string, number>): string {
  const entries = Object.entries(byStatus).sort(([a], [b]) => Number(a) - Number(b));
  return entries.length === 0 ? '(none)' : entries.map(([code, n]) => `${code}:${n}`).join(' ');
}
