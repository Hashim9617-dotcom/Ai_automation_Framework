import { test, expect } from '@playwright/test';
import {
  API_CALLS_CSV_HEADER,
  MAX_ENDPOINTS_IN_RUN_JSON,
  MAX_MODULES_PER_ENDPOINT,
  UNKNOWN_MODULE,
  apiCallsCsv,
  boundEndpoints,
  formatStatusMix,
  isIdLike,
  summariseEndpoints,
  templatePath,
  type EndpointRequestInput,
  type EndpointTestInput,
} from '@aitp/shared';

/**
 * THE PER-ENDPOINT TABLE, on synthetic data.
 *
 * ## The two questions this file keeps apart
 *
 * `summariseRunNetwork` answers "how many 403s"; this answers "which endpoint,
 * how often, from where". The second one is the one that can leak, because it
 * prints a URL — so half of what is below is about what must NOT survive into a
 * row, and the planted-secret case is in `notify-zip.spec.ts` where the bundle is
 * the subject.
 *
 * ## Why templating is tested on its own and not only through the summary
 *
 * `templatePath` is where a record id from a live system is destroyed. Asserted
 * through `summariseEndpoints` it would be asserted at a point where a merge has
 * already happened, and a test that merely sees two calls collapse into one row
 * cannot tell "the id was templated" from "the fixture had the same path twice".
 */

const request = (over: Partial<EndpointRequestInput> = {}): EndpointRequestInput => ({
  method: 'GET',
  path: '/api/items',
  status: 200,
  sameOrigin: true,
  durationMs: 10,
  ...over,
});

const from = (
  requests: ReadonlyArray<EndpointRequestInput>,
  module: string | null = 'Tax',
): EndpointTestInput[] => [{ module, requests }];

test.describe('path templating @unit', () => {
  test('N1: a numeric id becomes :id, so two records are one endpoint', () => {
    // wrong: leaving the number. `/api/tax/4821` and `/api/tax/4822` then become two
    // rows that are really one endpoint called twice — and 4821 is a real record's
    // identifier out of a live customer system, written into a CSV that is emailed.
    expect(templatePath('/api/tax/4821')).toBe('/api/tax/:id');
    expect(templatePath('/api/tax/4822')).toBe('/api/tax/:id');
    // Two segments, both numeric, both gone.
    expect(templatePath('/api/tax/4821/lines/7')).toBe('/api/tax/:id/lines/:id');
  });

  test('N2: a GUID becomes :id in either case', () => {
    // wrong: a `^\d+$` rule alone. Half the ids in a .NET application are GUIDs, so
    // a numeric-only rule would template the easy half and let the other half
    // through — which reads as working, because the rows that remain look fine.
    expect(templatePath('/api/runs/3f2a9c71-4b1e-4d55-9f0a-7c2e8b1d6a44')).toBe('/api/runs/:id');
    expect(templatePath('/api/runs/3F2A9C71-4B1E-4D55-9F0A-7C2E8B1D6A44')).toBe('/api/runs/:id');
  });

  test('N3: a long hex digest and an opaque token are ids too', () => {
    // wrong: stopping at numbers and GUIDs. A session key, a share token or a
    // content digest in a path is exactly the thing that must not travel, and none
    // of them is either shape.
    expect(templatePath('/files/9a7c3e5f1b2d4068aa11')).toBe('/files/:id');
    expect(templatePath('/share/aBc123XyZ789Qq')).toBe('/share/:id');
  });

  test('N4: a WORD is not an id, however long — the rule must discriminate', () => {
    // wrong: §W, and the reversed form of rule 2. A rule that templated every
    // segment over 11 characters would pass N1–N3 perfectly and turn the whole table
    // into `/:id/:id/:id` — refusing everything, which looks safe because nothing
    // wrong gets through. These are the real path segments the rule must leave
    // alone, and `purchase-orders` is 15 characters of exactly the characters an id
    // is made of; only the absence of a digit separates them.
    for (const word of [
      'purchase-orders',
      'admin',
      'domains',
      'Tax',
      'attribute-sets',
      'goods-receipt-notes',
    ]) {
      expect(isIdLike(word), `${word} must not read as an id`).toBe(false);
      expect(templatePath(`/api/${word}`)).toBe(`/api/${word}`);
    }
    // A short version segment stays: `v1` is two characters, so the length floor
    // keeps it even though it carries a digit.
    expect(templatePath('/api/v1/tax')).toBe('/api/v1/tax');
  });

  test('N5: mixed paths template only the id-shaped segments', () => {
    // wrong: an all-or-nothing rule. The endpoint's own name is what makes the row
    // worth reading, so a template that lost `lines` with the number would collapse
    // genuinely different endpoints together.
    expect(templatePath('/api/purchase-orders/88/lines/3f2a9c71-4b1e-4d55-9f0a-7c2e8b1d6a44')).toBe(
      '/api/purchase-orders/:id/lines/:id',
    );
  });

  test('N6: the query string and the fragment are DROPPED, not templated', () => {
    // wrong: templating the query's segments and keeping the rest. A query carries
    // filter values — a supplier name, an email, a date range — and none of those is
    // id-shaped, so a template rule would preserve every one of them. The fix is not
    // a better rule: it is that nothing after `?` is kept at all.
    expect(templatePath('/api/tax?name=ACME%20Trading&email=a@b.test')).toBe('/api/tax');
    expect(templatePath('/api/tax?token=supersecret')).toBe('/api/tax');
    expect(templatePath('/api/tax#section-2')).toBe('/api/tax');
    expect(templatePath('/api/tax?a=1#b')).toBe('/api/tax');
  });
});

test.describe('endpoint aggregation @unit', () => {
  test('N7: calls, statuses, modules and the slowest call are aggregated per endpoint', () => {
    // wrong: a row per request. The table is meant to answer "what did this run talk
    // to"; one row per call is the log it already has.
    const rows = summariseEndpoints([
      {
        module: 'Tax',
        requests: [
          request({ path: '/api/tax/1', durationMs: 50 }),
          request({ path: '/api/tax/2', durationMs: 120, status: 304 }),
        ],
      },
      { module: 'Products', requests: [request({ path: '/api/tax/3', durationMs: 90 })] },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      method: 'GET',
      api: '/api/tax/:id',
      sameOrigin: true,
      calls: 3,
      byStatus: { '200': 2, '304': 1 },
      modules: ['Products', 'Tax'],
      moduleCount: 2,
      // The MAXIMUM, not the last and not the mean: the slowest call is the one
      // somebody investigates, and a mean hides it behind the fast ones.
      maxDurationMs: 120,
    });
  });

  test('N8: the same path on two ORIGINS is two rows', () => {
    // wrong: keying on method and path alone. `/api/health` exists on the
    // application and on a third-party probe, and merging them attributes somebody
    // else's 503 to the application under test — the exact confusion the whole
    // app/third-party split exists to prevent.
    const rows = summariseEndpoints(
      from([
        request({ path: '/api/health', sameOrigin: true }),
        request({ path: '/api/health', sameOrigin: false, status: 503 }),
      ]),
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.sameOrigin, row.byStatus])).toEqual([
      [false, { '503': 1 }],
      [true, { '200': 1 }],
    ]);
  });

  test('N9: a test with no module is named, never left blank or called "null"', () => {
    // wrong: `String(null)`, which puts the literal text `null` in a report column,
    // or an empty string, which reads as a column that failed to populate. Neither
    // tells a reader that the test's title simply had no suite in it.
    const rows = summariseEndpoints(from([request()], null));
    expect(rows[0]!.modules).toEqual([UNKNOWN_MODULE]);
  });

  test('N10: a malformed entry is SKIPPED, and a missing duration is not', () => {
    // wrong: coercing. A missing `sameOrigin` defaulted to true blames the
    // application for somebody else's request; a missing `status` coerced to 0
    // invents a status category. `durationMs` is the one field that may legitimately
    // be absent — it was added after the first records were written — so it degrades
    // to 0 and the row survives, because losing a whole endpoint to a missing timing
    // would be the larger error.
    const rows = summariseEndpoints(
      from([
        request({ sameOrigin: undefined }),
        request({ status: undefined }),
        request({ method: '' }),
        request({ path: undefined }),
        request({ path: '/api/kept', durationMs: undefined }),
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ api: '/api/kept', calls: 1, maxDurationMs: 0 });
  });
});

test.describe('endpoint ordering and bounds @unit', () => {
  test('N11: failures come first, app origin before third-party WITHIN that group', () => {
    // wrong: ordering by call count alone. The failures are the part somebody has to
    // act on and they are rare, so they are precisely the rows a count-ordered table
    // buries. The fixture discriminates because the failing rows have the FEWEST
    // calls — under a count order they would come last, so this cannot pass by
    // accident.
    const rows = summariseEndpoints([
      {
        module: 'Tax',
        requests: [
          ...Array.from({ length: 40 }, () => request({ path: '/api/busy' })),
          request({ path: '/api/broken', status: 500 }),
          request({ path: '/api/third', status: 403, sameOrigin: false }),
          ...Array.from({ length: 10 }, () => request({ path: '/api/quiet' })),
        ],
      },
    ]);
    expect(rows.map((row) => row.api)).toEqual([
      '/api/broken', // failed, app origin
      '/api/third', // failed, third party
      '/api/busy', // healthy, 40 calls
      '/api/quiet', // healthy, 10 calls
    ]);
  });

  test('N12: among HEALTHY endpoints the order is call count, not origin', () => {
    // wrong: hoisting every app-origin row above every third-party one. A chatty
    // third-party call is often why a suite is slow, and it would be pushed below
    // every one-call app endpoint. This is the deliberate half of N11's rule and it
    // is the half most likely to be "fixed" by somebody who has not read it, so the
    // fixture makes the two orderings give different answers.
    const rows = summariseEndpoints(
      from([
        ...Array.from({ length: 20 }, () => request({ path: '/cdn/bundle.js', sameOrigin: false })),
        request({ path: '/api/once', sameOrigin: true }),
      ]),
    );
    expect(rows.map((row) => row.api)).toEqual(['/cdn/bundle.js', '/api/once']);
  });

  test('N13: run.json is BOUNDED, and says how much it is not showing', () => {
    // wrong: slicing and letting the array's length speak. "200 endpoints" and "the
    // first 200 of 413" are different facts and `rows.length` says the same thing
    // for both — the §AB/§AK shape, a number quoted without the assumption it was
    // taken under. `total` is what makes the cap honest.
    const many = Array.from({ length: MAX_ENDPOINTS_IN_RUN_JSON + 13 }, (_, index) =>
      request({ path: `/api/e${index}/x` }),
    );
    const all = summariseEndpoints(from(many));
    expect(all).toHaveLength(MAX_ENDPOINTS_IN_RUN_JSON + 13);

    const bounded = boundEndpoints(all);
    expect(bounded.total).toBe(MAX_ENDPOINTS_IN_RUN_JSON + 13);
    expect(bounded.shown).toBe(MAX_ENDPOINTS_IN_RUN_JSON);
    expect(bounded.rows).toHaveLength(MAX_ENDPOINTS_IN_RUN_JSON);

    // And a list UNDER the cap reports itself as complete, so a reader can tell the
    // two apart rather than always suspecting truncation.
    const small = boundEndpoints(all.slice(0, 3));
    expect(small).toMatchObject({ total: 3, shown: 3 });
  });

  test('N14: module names are bounded per row, with the true count kept', () => {
    // wrong: capping the list and letting it stand for the whole. The shell's own
    // bundle is called by every module, so this row is the common case — and a cell
    // reading eight names when there were twenty-nine is a quiet lie. `moduleCount`
    // survives the cap for the same reason `total` does above.
    const perTest: EndpointTestInput[] = Array.from({ length: 12 }, (_, index) => ({
      module: `Module ${String(index).padStart(2, '0')}`,
      requests: [request({ path: '/static/app.js' })],
    }));
    const all = summariseEndpoints(perTest);
    expect(all[0]!.moduleCount).toBe(12);
    // Unbounded in the row the CSV is built from...
    expect(all[0]!.modules).toHaveLength(12);
    // ...and bounded only on the way into run.json, where the count still says 12.
    const bounded = boundEndpoints(all);
    expect(bounded.rows[0]!.modules).toHaveLength(MAX_MODULES_PER_ENDPOINT);
    expect(bounded.rows[0]!.moduleCount).toBe(12);
  });
});

test.describe('the API calls CSV @unit', () => {
  test('N15: the CSV carries EVERY endpoint and every module name', () => {
    // wrong: building the CSV from `boundEndpoints`. The mail truncates precisely
    // because this file does not, so a truncated CSV would leave the answer nowhere
    // — and it would look complete, which is what makes it worth a test rather than
    // a comment.
    const perTest: EndpointTestInput[] = Array.from({ length: 12 }, (_, index) => ({
      module: `Module ${String(index).padStart(2, '0')}`,
      requests: [request({ path: '/static/app.js' })],
    }));
    const csv = apiCallsCsv(summariseEndpoints(perTest));
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toBe(API_CALLS_CSV_HEADER.join(','));
    expect(lines).toHaveLength(2);
    for (let index = 0; index < 12; index += 1) {
      expect(lines[1], `Module ${index} is missing from the CSV`).toContain(
        `Module ${String(index).padStart(2, '0')}`,
      );
    }
  });

  test('N16: no query string, no id and no header value can reach the CSV', () => {
    // wrong: writing `row.path` instead of the template. This is the assertion the
    // whole module exists for: the CSV is attached to an email, so a value that
    // survives into it has left the building. The fixture plants a secret in each of
    // the three places a URL can carry one.
    const csv = apiCallsCsv(
      summariseEndpoints(
        from([
          request({ path: '/api/tax?token=SECRET-QUERY-VALUE' }),
          request({ path: '/api/reset/SECRET9PATH9TOKEN' }),
          request({ path: '/api/tax/4821' }),
        ]),
      ),
    );
    expect(csv).not.toContain('SECRET-QUERY-VALUE');
    expect(csv).not.toContain('SECRET9PATH9TOKEN');
    expect(csv).not.toContain('4821');
    // §W — and it is not empty: the endpoints themselves ARE there, so this is a
    // scan that found something rather than one that matched nothing.
    expect(csv).toContain('/api/tax');
    expect(csv).toContain('/api/reset/:id');
    expect(csv).toContain('/api/tax/:id');
  });

  test('N17: a cell containing a comma or a quote is escaped', () => {
    // wrong: joining with commas and hoping. A module name with a comma in it
    // shifts every later column by one, and the file still parses — so the damage is
    // a table whose Modules column holds a duration, silently.
    const csv = apiCallsCsv(summariseEndpoints(from([request()], 'Tax, Duties and "Levies"')));
    expect(csv).toContain('"Tax, Duties and ""Levies"""');
  });

  test('N18: the status mix is rendered ascending, with counts', () => {
    // wrong: `Object.keys` order, which is insertion order for these and therefore
    // the order the requests happened to arrive in — so the same run renders
    // differently depending on timing, and two runs cannot be diffed.
    expect(formatStatusMix({ '304': 12, '200': 40 })).toBe('200×40, 304×12');
    // ABSENT is not zero here either: no statuses at all is a sentence, not an empty
    // string that reads as a cell nobody filled in.
    expect(formatStatusMix({})).toBe('(none)');
  });
});
