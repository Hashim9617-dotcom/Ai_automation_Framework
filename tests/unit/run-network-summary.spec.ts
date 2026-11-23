import { test, expect } from '@playwright/test';
import {
  TOP_FAILING_ENDPOINTS,
  formatStatusCounts,
  summariseRunNetwork,
  type NetworkSummaryInput,
} from '@aitp/shared';

/**
 * THE RUN-LEVEL NETWORK SUMMARY, on synthetic data.
 *
 * ## What it replaces
 *
 * Per-test records existed and were unreachable. They were attached with `body:`,
 * so Playwright stored them inline and `run.json` recorded `path: "inline"` —
 * measured on 2026-11-18 by trying to read them back and finding nothing. Sixty-two
 * tests each "attached" their answer and the run-level question a report and a mail
 * actually ask could not be answered at all.
 *
 * ## Why the split is the thing under test
 *
 * Totalling app-origin and third-party status codes gives one number that answers
 * neither question: a 4xx from the application under test is a finding, and a 4xx
 * from somebody else's CDN is not. On Ecom every admin page calls a storefront API
 * on another origin for a cart the admin account does not have, and each call
 * returns 403 — a dozen per page. Merged into one count, the run would read as
 * riddled with client errors.
 */

const request = (over: Partial<NetworkSummaryInput> = {}): NetworkSummaryInput => ({
  method: 'GET',
  path: '/api/items',
  status: 200,
  sameOrigin: true,
  ...over,
});

test.describe('summariseRunNetwork @unit', () => {
  test('S1: statuses are split by origin, not merged', () => {
    // wrong: one `byStatus` map. Ecom's own 403s and a third party's 403s then land
    // in one bucket, and a reader cannot tell a finding from somebody else's
    // service being strict — which on Ecom is a dozen third-party 403s per page
    // against zero app-origin ones. The merged total is also kept, because a report
    // legitimately wants "how many requests did this run make".
    const summary = summariseRunNetwork([
      [
        request(),
        request({ status: 403, sameOrigin: false, path: '/api/web/cart' }),
        request({ status: 500, path: '/api/items' }),
      ],
    ]);
    expect(summary.totalRequests).toBe(3);
    expect(summary.byStatus).toEqual({ '200': 1, '403': 1, '500': 1 });
    expect(summary.appByStatus).toEqual({ '200': 1, '500': 1 });
    expect(summary.thirdPartyByStatus).toEqual({ '403': 1 });
  });

  test('S2: a non-GET to the APP is counted; one to another origin is not', () => {
    // wrong: counting every non-GET. A third party's own POST — an analytics
    // beacon, a font service — is not this suite writing to the application under
    // test, and counting it would make a read-only run report a write it did not
    // make. That false positive is worse than useless: it would train somebody to
    // ignore the one number that must stay zero.
    const summary = summariseRunNetwork([
      [
        request({ method: 'POST', path: '/api/items' }),
        request({ method: 'PATCH', path: '/api/items/1' }),
        request({ method: 'POST', sameOrigin: false, path: '/collect' }),
        // HEAD and OPTIONS are reads: a preflight is not a write.
        request({ method: 'HEAD' }),
        request({ method: 'OPTIONS' }),
      ],
    ]);
    expect(summary.appWriteAttempts).toBe(2);
  });

  test('S3: failing endpoints are ranked, and one endpoint failing two ways is two rows', () => {
    // wrong: keying on method+path alone. A 403 and a 404 on one endpoint would
    // merge, and the merged row would carry whichever status happened to arrive
    // first — hiding one of the two entirely. They are different problems with
    // different causes, so they stay separate.
    const summary = summariseRunNetwork([
      [
        request({ status: 404, path: '/api/a' }),
        request({ status: 404, path: '/api/a' }),
        request({ status: 403, path: '/api/a' }),
        request({ status: 500, path: '/api/b' }),
      ],
    ]);
    const rows = summary.topFailingEndpoints;
    expect(rows[0]).toMatchObject({ path: '/api/a', status: 404, count: 2 });
    expect(rows.map((r) => `${r.path} ${r.status}`)).toEqual([
      '/api/a 404',
      '/api/a 403',
      '/api/b 500',
    ]);
    // 2xx and 3xx are not failures and never appear here.
    expect(rows.some((r) => r.status < 400)).toBe(false);
  });

  test('S4: on a tie, the APPLICATION’s endpoint ranks above another origin’s', () => {
    // wrong: an arbitrary order, so the five rows a reader sees could be five
    // third-party rows while the application's own failure sat in sixth place. The
    // list is bounded, so what it drops matters as much as what it keeps — and the
    // half somebody can act on is the half that must survive the cut.
    const summary = summariseRunNetwork([
      [
        request({ status: 500, sameOrigin: false, path: '/their/one' }),
        request({ status: 500, sameOrigin: true, path: '/our/one' }),
      ],
    ]);
    expect(summary.topFailingEndpoints[0]).toMatchObject({ path: '/our/one', sameOrigin: true });
  });

  test('S5: the list is bounded to five, worst first', () => {
    // wrong: every failing endpoint. A run against a broken environment would put
    // hundreds into run.json, which then travels into an email — and a list that
    // long is a log, not a signal. The CAP is asserted along with the ordering,
    // because a cap applied before sorting would keep an arbitrary five.
    const records = Array.from({ length: 9 }, (_, i) =>
      Array.from({ length: i + 1 }, () => request({ status: 500, path: `/api/${i}` })),
    );
    const summary = summariseRunNetwork(records);
    expect(summary.topFailingEndpoints).toHaveLength(TOP_FAILING_ENDPOINTS);
    expect(summary.topFailingEndpoints.map((r) => r.count)).toEqual([9, 8, 7, 6, 5]);
  });

  test('S6: testsReporting distinguishes "nothing requested" from "nothing instrumented"', () => {
    // wrong: a summary of zeroes with no way to tell the two apart. `appByStatus:
    // {}` from a run where no test was instrumented and from a run that genuinely
    // made no app requests are the same object — and only the first means the
    // numbers are meaningless. §T as a FIELD rather than as an assertion.
    const instrumentedButQuiet = summariseRunNetwork([[], []]);
    expect(instrumentedButQuiet.testsReporting).toBe(2);
    expect(instrumentedButQuiet.totalRequests).toBe(0);

    const nothingInstrumented = summariseRunNetwork([]);
    expect(nothingInstrumented.testsReporting).toBe(0);
  });

  test('S7: a malformed entry is SKIPPED, never coerced into a category', () => {
    // wrong: coercing. A missing `status` becomes 0 and appears in byStatus as a
    // kind of response that does not exist; a missing `sameOrigin` defaulted to
    // true blames the application for another service's failure. Both are confident
    // wrong answers, and the good entry beside them must still be counted — which
    // is why they are in one fixture rather than tested alone.
    const summary = summariseRunNetwork([
      [
        request(),
        { method: 'GET', path: '/api/x', sameOrigin: true } as NetworkSummaryInput,
        { method: 'GET', path: '/api/x', status: 500 } as NetworkSummaryInput,
        { method: '', path: '/api/x', status: 500, sameOrigin: true },
        { method: 'GET', path: '', status: 500, sameOrigin: true },
        { method: 'GET', path: '/api/x', status: 12, sameOrigin: true },
      ],
    ]);
    expect(summary.totalRequests).toBe(1);
    expect(summary.byStatus).toEqual({ '200': 1 });
    expect(summary.topFailingEndpoints).toEqual([]);
  });

  test('S8: formatStatusCounts is ordered by code and says so when there are none', () => {
    // wrong: object key order, which for numeric-looking keys is insertion order in
    // some engines and ascending in others — so the same run would print a
    // different line on a different machine. And an empty map must read as
    // "(none)", never as an empty string a reader cannot see.
    expect(formatStatusCounts({ '500': 2, '200': 41, '403': 12 })).toBe('200:41 403:12 500:2');
    expect(formatStatusCounts({})).toBe('(none)');
  });
});
