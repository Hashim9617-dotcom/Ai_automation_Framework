import type { BrowserContext, Request, Response, TestInfo } from '@playwright/test';

/**
 * EVERY APPLICATION REQUEST THIS RUN MADE, and the two guards over it.
 *
 * ## What is recorded, and what is deliberately not
 *
 * Method, path, status, duration. **The query string is dropped entirely** and no
 * body is ever read. A query carries filter values and ids from a live system, and
 * this record is attached to a test result that travels into a report and an email
 * — so the one place a record value could leak is closed by not reading it rather
 * than by redacting it afterwards.
 *
 * ## The non-GET guard is the SECOND layer, not the first
 *
 * The Drawer component refuses to click a submit control, which PREVENTS a write.
 * This DETECTS one — after the request has been sent, which on a shared development
 * environment is after the damage. It is here because prevention by allowlist can
 * only cover the controls somebody thought of: a form that submits on Enter, an
 * auto-save, a background PATCH. Those are exactly what this catches and the
 * component cannot.
 *
 * Both layers, because either alone has a hole the other closes.
 */

/** One request, reduced to what can safely be kept. */
export interface RecordedRequest {
  method: string;
  /** Path only. The query string is never recorded — it carries live values. */
  path: string;
  status: number;
  durationMs: number;
  /** True when this is a request to the application's own origin. */
  sameOrigin: boolean;
}

export interface NetworkRecord {
  requests: RecordedRequest[];
  /** Count by status code, for the per-run summary. */
  byStatus: Record<string, number>;
  /** Non-GET requests to the app that were NOT allowlisted. Any entry fails a test. */
  writeAttempts: RecordedRequest[];
  /** 5xx responses. Any entry fails a test. */
  serverErrors: RecordedRequest[];
  /** 4xx responses that are not allowlisted. Any entry fails a test. */
  clientErrors: RecordedRequest[];
}

/**
 * The ONLY non-GET requests a read-only run may make, and why each is permitted.
 *
 * Both are the sign-in itself. Logging in is a write — it mints a session — and it
 * is the one write this suite cannot avoid, because every page needs a session. The
 * list is deliberately two entries long and matched on the PATH, so a POST to any
 * business endpoint is a failure however it was triggered.
 *
 * It is an ALLOWLIST: an unrecognised non-GET request fails rather than passes
 * (§AC). A denylist of business endpoints would be fail-open against the first
 * endpoint nobody thought of.
 */
export const ALLOWED_NON_GET = [
  {
    test: (path: string) => /\/api\/auth\/(login|callback|session|token)\b/i.test(path),
    why: 'the sign-in itself — it mints a session, and every page needs one',
  },
  {
    test: (path: string) => /\/(login|signin|sign-in)\/?$/i.test(path),
    why: 'the login form post, for an app that posts to the page rather than to an API',
  },
] as const;

/**
 * 4xx responses that do not fail a run, with the reason each is tolerated.
 *
 * Short on purpose and each entry is a fact about this application rather than a
 * convenience. A 404 on a business endpoint is a finding; a 401 on a probe the app
 * makes before it has a session is not.
 */
export const ALLOWED_4XX = [
  {
    test: (r: RecordedRequest) => r.status === 401 && /\/api\/auth\//i.test(r.path),
    why: 'the app probes its own session endpoint before signing in; a 401 there is the answer',
  },
  {
    test: (r: RecordedRequest) =>
      r.status === 404 && /\.(png|jpg|svg|ico|woff2?|map)$/i.test(r.path),
    why: 'a missing static asset is a cosmetic defect, not a smoke failure',
  },
] as const;

/**
 * Console messages that do not fail a run.
 *
 * Deliberately almost empty. A console error on a list page usually IS the finding
 * — the sheet's own list-load cases say "no console errors are logged" — so an
 * allowlist here is admitting something, and each entry says what.
 */
export const ALLOWED_CONSOLE = [
  {
    test: (text: string) => /favicon/i.test(text),
    why: 'a missing favicon is cosmetic and is reported by the browser, not by the app',
  },
  {
    test: (text: string) => /ResizeObserver loop/i.test(text),
    why: 'a benign browser notice from a resize-aware grid; it is not an application error',
  },
  {
    /**
     * The browser's generic line for a request that failed. It carries NO
     * information the network record lacks — no URL, no origin, no method — and
     * the record has already judged that request by origin and status.
     *
     * Measured on 2026-11-18: every module page produced this, from three
     * CROSS-ORIGIN storefront calls (`ecommapi.aitalkx.com` — cart, profile,
     * wishlist) returning 403 for an admin account. They are a real observation
     * about the application and they are reported as a `third-party-4xx`
     * annotation; they are not a failure of the module page, and the network
     * guard already declines to fail on another origin's status codes.
     *
     * Allowlisting the console line while REPORTING the requests keeps the two
     * halves honest: the duplicate is dropped and the finding is not.
     */
    test: (text: string) => /^Failed to load resource/i.test(text),
    why:
      'a duplicate of a request the network record already judged by origin and status; ' +
      'the record is the authority and this line adds nothing',
  },
] as const;

const pathOf = (url: string): string => {
  try {
    const parsed = new URL(url);
    // PATH ONLY. The query is dropped before anything is stored, so a filter value
    // or a record id never enters the record at all.
    return parsed.pathname;
  } catch {
    return url;
  }
};

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/**
 * Starts recording, and returns the record the test will assert on.
 *
 * `appOrigin` is PASSED IN rather than read from the environment here, so a test
 * decides what "the application" means and nothing in this module reads ambient
 * state (§AJ). Third-party requests — fonts, analytics — are recorded with
 * `sameOrigin: false` and are never a failure: they are not this application's
 * behaviour, and failing on them would make the suite a monitor for somebody
 * else's CDN.
 */
export function recordNetwork(context: BrowserContext, appOrigin: string): NetworkRecord {
  const record: NetworkRecord = {
    requests: [],
    byStatus: {},
    writeAttempts: [],
    serverErrors: [],
    clientErrors: [],
  };
  const started = new WeakMap<Request, number>();

  context.on('request', (request: Request) => started.set(request, Date.now()));

  context.on('response', (response: Response) => {
    const request = response.request();
    const url = request.url();
    const path = pathOf(url);
    const entry: RecordedRequest = {
      method: request.method(),
      path,
      status: response.status(),
      durationMs: Date.now() - (started.get(request) ?? Date.now()),
      sameOrigin: originOf(url) === appOrigin,
    };
    record.requests.push(entry);
    record.byStatus[String(entry.status)] = (record.byStatus[String(entry.status)] ?? 0) + 1;

    if (!entry.sameOrigin) return;

    if (entry.method !== 'GET' && entry.method !== 'HEAD' && entry.method !== 'OPTIONS') {
      if (!ALLOWED_NON_GET.some((rule) => rule.test(path))) record.writeAttempts.push(entry);
    }
    if (entry.status >= 500) record.serverErrors.push(entry);
    else if (entry.status >= 400 && !ALLOWED_4XX.some((rule) => rule.test(entry))) {
      record.clientErrors.push(entry);
    }
  });

  return record;
}

/** A one-line-per-code summary, for the report and the mail. */
export function summariseStatuses(record: NetworkRecord): string {
  const entries = Object.entries(record.byStatus).sort(([a], [b]) => Number(a) - Number(b));
  return entries.length === 0
    ? '(no responses)'
    : entries.map(([code, n]) => `${code}:${n}`).join(' ');
}

/**
 * Attaches the record and fails the test on anything the guards caught.
 *
 * The attachment happens FIRST, before any assertion, so a failing test still
 * carries the evidence that explains it. An assertion that threw before attaching
 * would leave the reader with a message and no way to see what preceded it.
 */
export async function assertNetworkClean(
  record: NetworkRecord,
  testInfo: TestInfo,
  consoleErrors: string[],
): Promise<void> {
  await testInfo.attach('network.json', {
    body: JSON.stringify(
      {
        summary: summariseStatuses(record),
        counts: record.byStatus,
        total: record.requests.length,
        requests: record.requests,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });

  /**
   * THIRD-PARTY 4xx ARE REPORTED, not failed on and not hidden.
   *
   * They are not this application's status codes, so failing on them would make
   * the suite a monitor for somebody else's service. But dropping them silently
   * would lose a real observation — on Ecom every admin page calls the storefront
   * API for a cart, a profile and a wishlist the admin account does not have, and
   * each returns 403. That is worth telling the Ecom team, once, per run.
   */
  const thirdPartyErrors = record.requests.filter((r) => !r.sameOrigin && r.status >= 400);
  if (thirdPartyErrors.length > 0) {
    const distinct = [...new Set(thirdPartyErrors.map((r) => `${r.status} ${r.method} ${r.path}`))];
    testInfo.annotations.push({
      type: 'third-party-4xx',
      description:
        `${thirdPartyErrors.length} failed request(s) to another origin, not failed on: ` +
        distinct.join(', '),
    });
  }

  const problems: string[] = [];
  if (record.writeAttempts.length > 0) {
    problems.push(
      `READ-ONLY VIOLATION: ${record.writeAttempts.length} non-GET request(s) reached the ` +
        `application — ${record.writeAttempts.map((r) => `${r.method} ${r.path}`).join(', ')}. ` +
        'This suite must not write to a shared development environment. The Drawer component ' +
        'refuses submit-shaped controls, so a write that got here came from something else: a ' +
        'form submitting on Enter, an auto-save, or a background request.',
    );
  }
  if (record.serverErrors.length > 0) {
    problems.push(
      `${record.serverErrors.length} server error(s): ` +
        record.serverErrors.map((r) => `${r.status} ${r.method} ${r.path}`).join(', '),
    );
  }
  if (record.clientErrors.length > 0) {
    problems.push(
      `${record.clientErrors.length} unexpected 4xx: ` +
        record.clientErrors.map((r) => `${r.status} ${r.method} ${r.path}`).join(', '),
    );
  }
  const unexpectedConsole = consoleErrors.filter(
    (text) => !ALLOWED_CONSOLE.some((rule) => rule.test(text)),
  );
  if (unexpectedConsole.length > 0) {
    problems.push(
      `${unexpectedConsole.length} console error(s): ` +
        unexpectedConsole.map((text) => text.slice(0, 160)).join(' | '),
    );
  }

  if (problems.length > 0) throw new Error(problems.join('\n'));
}
