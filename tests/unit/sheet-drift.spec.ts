import { test, expect } from '@playwright/test';
import {
  DRIFT_CSV_HEADER,
  MIN_PREFIX,
  classifyColumns,
  countBuckets,
  describeCounts,
  driftCsv,
  headerTokens,
  type DriftRow,
} from '@aitp/shared';

/**
 * THE DRIFT CLASSIFIER: a sheet's expected columns against a page's real headers.
 *
 * ## What it replaces, and why one list was useless
 *
 * The first Ecom smoke run reported drift on 16 of 29 modules as one flat list. That
 * list mixes two jobs with two different owners:
 *
 * - `"Code"` where the page says `"CATEGORY CODE"` — the sheet is right and worded
 *   differently. Tidy the sheet, or do nothing.
 * - `"GST"` where the page says `"VAT %"` — the sheet names something that is not
 *   there. Somebody has to decide whether the requirement moved.
 *
 * Merged, the list is unactionable for both, which is the same reason `failed` and
 * `refused` are separate statuses in this repo.
 *
 * ## The danger is in the flattering direction
 *
 * A classifier like this can be made to produce a small `real` count by loosening
 * its rules, and a smaller number looks like progress. So the tests below are
 * weighted towards the cases that must NOT be absorbed: `GST`→`VAT %` and UOM's
 * `Symbol` are each asserted as `real` by name, and `Qty`→`QUANTITY` is asserted as
 * `real` because recognising it would need a dictionary, and a dictionary is a list
 * somebody wrote (§AE).
 *
 * ## Every fixture is discriminating
 *
 * A `found` list that shares no tokens with anything would make every expected
 * column `real` and every test here would pass over a classifier that always says
 * `real`. So each fixture carries headers that the rules COULD pair — the module's
 * real neighbours — and the assertions say which pairing happened and by which rule.
 */

const where = { module: 'Tax', caseId: 'TAX-001' };

/** One expected column against one page, as the spec will call it. */
function one(expected: string, found: readonly string[]): DriftRow {
  const rows = classifyColumns([expected], found, where);
  expect(rows, `"${expected}" produced ${rows.length} rows`).toHaveLength(1);
  return rows[0]!;
}

test.describe('sheet drift is classified into three buckets @unit', () => {
  test('C1: an identical header after normalisation is a MATCH, glyphs and case included', () => {
    // wrong: comparing raw strings, which fails on this application's headers —
    // they are upper-cased and several carry a U+EB0B private-use icon glyph that
    // looks like a space and is not one. Built from char codes, never typed as an
    // escape, because an escape for an invisible character is invisible in the
    // result (CLAUDE.md).
    const glyph = String.fromCodePoint(0xeb0b);
    const row = one('Category Code', [`${glyph} CATEGORY CODE`, 'Status']);
    expect(row.bucket).toBe('match');
    expect(row.rule).toBe('exact');
    expect(row.found).toBe(`${glyph} CATEGORY CODE`);
    // And the separator is normalised too, so a snake_cased sheet column matches.
    expect(one('tax_rate', ['Tax Rate']).bucket).toBe('match');
  });

  test('C2: the three PHRASING examples from the report, by containment and by prefix', () => {
    // wrong: calling these `real`, which is the undifferentiated list this exists to
    // replace — 16 modules of drift that mostly needed nobody to do anything. Each
    // fixture includes a header that does NOT pair, so a classifier returning
    // `phrasing` for everything would fail C4 rather than pass this.
    const code = one('Code', ['CATEGORY CODE', 'Status']);
    expect([code.bucket, code.rule]).toEqual(['phrasing', 'token-containment']);
    expect(code.found).toBe('CATEGORY CODE');

    const contact = one('Contact', ['CONTACT PERSON', 'Address']);
    expect([contact.bucket, contact.rule]).toEqual(['phrasing', 'token-containment']);
    expect(contact.found).toBe('CONTACT PERSON');

    const min = one('Min', ['MINIMUM', 'Maximum']);
    expect([min.bucket, min.rule]).toEqual(['phrasing', 'prefix-abbreviation']);
    expect(min.found).toBe('MINIMUM');
  });

  test('C3: Tax GST against a VAT page is REAL — the named case that must not be absorbed', () => {
    // wrong: any rule loose enough to pair `GST` with `VAT %`. It is the case the
    // whole classifier is judged on: the sheet names a tax that is not on the page,
    // and somebody has to decide whether the requirement moved. A fuzzy matcher that
    // made this `phrasing` would shrink the number everybody looks at and hide the
    // one row that needed a conversation.
    const row = one('GST', ['VAT %', 'Tax Rate', 'Effective From', 'Status']);
    expect(row.bucket).toBe('real');
    expect(row.rule).toBe('none');
    expect(row.found, 'a real drift must have no counterpart').toBeNull();
    expect(row.candidates).toBe(0);
  });

  test('C4: UOM Symbol is REAL — the second named case, against a page that nearly pairs', () => {
    // wrong: a fixture whose headers share nothing with anything, which would make
    // this pass over a classifier that always answers `real`. `Symbol` sits beside
    // `Code`, `Name` and `Description` — headers the rules pair happily with OTHER
    // expected columns, which is what makes `real` here a verdict rather than a
    // default.
    const page = ['Code', 'Name', 'Description', 'Status'];
    const symbol = one('Symbol', page);
    expect(symbol.bucket).toBe('real');
    expect(symbol.found).toBeNull();

    // The discriminating half, in the same fixture: the same page DOES pair these.
    expect(one('Code', page).bucket).toBe('match');
    expect(one('Desc', page).bucket).toBe('phrasing');
  });

  test('C5: an abbreviation that drops interior letters is REAL, deliberately', () => {
    // wrong: a rule that paired `Qty` with `QUANTITY`. There is no way to recognise
    // it except a dictionary of known abbreviations, and a hand-written dictionary
    // is a denylist of the ones somebody thought of — it would pair `Qty` and miss
    // `Amt`, then pair `Amt` and miss the next one, and the rule's behaviour would
    // be whatever its author last remembered. Prefix-only is a rule with no list in
    // it.
    expect(one('Qty', ['QUANTITY', 'Unit']).bucket).toBe('real');
    // And the prefix rule's own boundary: two characters is not enough to stand for
    // a word, so `Mi` does not become `MINIMUM`.
    expect(MIN_PREFIX).toBe(3);
    expect(one('Mi', ['MINIMUM']).bucket).toBe('real');
    expect(one('Min', ['MINIMUM']).bucket).toBe('phrasing');
  });

  test('C6: containment is ONE-DIRECTIONAL, so a generic page column invents nothing', () => {
    // wrong: checking containment both ways. The sheet saying `Supplier Name` and
    // the page saying `Name` reads identically to the rule as `Code` vs
    // `CATEGORY CODE` — but it may be a different column entirely, and a classifier
    // that guesses is worse than one that reports a drift somebody then dismisses in
    // two seconds. The expected side must be the CONTAINED side.
    expect(one('Code', ['CATEGORY CODE']).bucket).toBe('phrasing');
    expect(one('Supplier Name', ['Name']).bucket).toBe('real');
  });

  test('C7: an ambiguous pairing is chosen deterministically and SAYS how many there were', () => {
    // wrong: returning the first match in page order, which makes the row depend on
    // column layout — the same sheet and the same page would produce different CSVs
    // after a UI reorder, and two runs would not be comparable. And a row that
    // showed one counterpart without saying there were four would read as certain.
    const page = ['CATEGORY CODE', 'POSTAL CODE', 'ITEM CODE', 'Name'];
    const row = one('Code', page);
    expect(row.candidates).toBe(3);
    // Same shared-token count for all three, so the tie-break decides: shortest,
    // then alphabetical. Asserted as a VALUE rather than "one of them", because a
    // non-deterministic classifier would pass an `oneOf` assertion.
    expect(row.found).toBe('ITEM CODE');
    expect(classifyColumns(['Code'], [...page].reverse(), where)[0]!.found).toBe('ITEM CODE');
  });

  test('C8: a blank expected column is SKIPPED, not counted as drift', () => {
    // wrong: classifying it as `real`, which inflates the one number that must stay
    // trustworthy — the sheet has empty cells and stray separators, and a run that
    // reported them as missing columns would put the `real` count up by a dozen with
    // nothing behind it.
    const rows = classifyColumns(['', '   ', '-', 'Code'], ['CATEGORY CODE'], where);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expected).toBe('Code');
    expect(headerTokens('-')).toEqual([]);
  });

  test('C9: with NO headers found, every column is real rather than a crash or a match', () => {
    // wrong: treating an empty page as "nothing to compare" and returning no rows.
    // A page that rendered no headers at all is a finding — every expected column IS
    // missing — and silence would report the module as clean. The §T shape: the
    // absence of a subject must not read as the absence of a problem.
    const rows = classifyColumns(['Code', 'Name'], [], where);
    expect(rows.map((r) => r.bucket)).toEqual(['real', 'real']);
  });

  test('C10: the counts and the one-line description are what an annotation carries', () => {
    // wrong: an annotation carrying the column NAMES per module, which is how a
    // run.json grows to megabytes and how a sheet's contents end up in an email.
    // Counts in the annotation, names in the CSV a QA opens deliberately.
    const rows = classifyColumns(
      ['Code', 'GST', 'Category Code', 'Symbol'],
      ['CATEGORY CODE', 'VAT %'],
      where,
    );
    expect(countBuckets(rows)).toEqual({ match: 1, phrasing: 1, real: 2 });
    expect(describeCounts(countBuckets(rows))).toBe('match 1, phrasing 1, real 2');
  });
});

test.describe('the drift CSV is reviewable and carries no row data @unit', () => {
  test('V1: real rows come FIRST, because the file is read top-down', () => {
    // wrong: page order or sheet order, which buries the rows that need a decision
    // under the ones that need nothing — on a 29-module run the `real` rows would be
    // scattered through several hundred lines. A bucket is a ranking, and the
    // ranking has to be visible in the artifact rather than only in the counts.
    const rows = classifyColumns(
      ['Category Code', 'Code', 'GST'],
      ['CATEGORY CODE', 'VAT %'],
      where,
    );
    const lines = driftCsv(rows).split('\r\n');
    expect(lines[0]).toBe(DRIFT_CSV_HEADER);
    expect(lines[1]).toContain('"real"');
    expect(lines[2]).toContain('"phrasing"');
    expect(lines[3]).toContain('"match"');
  });

  test('V2: a header containing a comma or a quote survives the round trip', () => {
    // wrong: joining with commas and hoping. A real column header can contain
    // either — `"Qty, net"` and `Size ("L")` are both ordinary — and an unquoted
    // CSV would shift every later column on that row, so the Bucket a QA reads
    // would belong to a different field. Quoted and doubled per RFC 4180.
    const rows = classifyColumns(['Qty, net'], ['QTY, NET'], where);
    const line = driftCsv(rows).split('\r\n')[1]!;
    expect(line).toContain('"Qty, net"');
    expect(driftCsv(classifyColumns(['Size ("L")'], ['SIZE ("L")'], where))).toContain(
      '"Size (""L"")"',
    );
    // Five commas outside the quoted cells: six columns, however many are inside.
    expect(line.split('","')).toHaveLength(6);
  });

  test('V3: it carries header names ONLY — no value from any row', () => {
    // wrong: adding a sample cell to "help the QA identify the column". The CSV is
    // attached to a report that leaves this machine, and this application's dev
    // environment is shared: a single cell is a record somebody owns. The columns
    // are fixed and asserted here so adding a seventh is a deliberate act rather
    // than a convenience nobody reviewed.
    expect(DRIFT_CSV_HEADER.split(',')).toEqual([
      'Module',
      'Case ID',
      'Expected (sheet)',
      'Found (app header)',
      'Bucket',
      'Rule',
    ]);
  });

  test('V4: an empty row list is a header-only file, not an empty one', () => {
    // wrong: returning `''`, which a reader cannot tell from a write that failed —
    // "no drift" and "nothing ran" would be the same zero bytes. A header line says
    // the classifier ran and found nothing to report.
    expect(driftCsv([])).toBe(DRIFT_CSV_HEADER);
  });
});
