import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { findRepoRoot } from '@aitp/shared';
import { collectableSpecFiles } from '../support/tracked-files';
import {
  DESCRIBE_DIAGNOSE_ONLY,
  DESCRIBE_WITHOUT_DIAGNOSE,
  DESCRIBE_WITH_SCHEDULED_TAG,
} from '../support/diagnose-tag-samples';

/**
 * A `@diagnose` SPEC NEVER RUNS IN A SCHEDULED RUN.
 *
 * ## What a diagnose spec is for, and why it must not travel
 *
 * `tests/apps/ecom/session-diagnose.spec.ts` exists to answer one question about an
 * application's behaviour and to keep being able to answer it. Its cases are
 * deliberately slow — one of them samples a URL for twenty seconds precisely so that
 * "it never recovered" is distinguishable from "nobody waited" — and several assert
 * almost nothing, because their output is a measurement rather than a verdict.
 *
 * In a smoke run that is two minutes of nothing. In a nightly it is two minutes of
 * nothing that nobody reads. And a measurement spec that starts being treated as a
 * pass/fail gate is worse than either: somebody will eventually "fix" it by making
 * it assert something, and the instrument stops being an instrument.
 *
 * ## The exclusion is a TAG, so it is checkable
 *
 * Both scheduled entry points select by tag — `pnpm test:smoke:live` greps `@smoke`,
 * and the nightly Jenkins pipeline defaults `GREP` to `@regression`. So a
 * `@diagnose` suite is excluded exactly when its describe title carries neither of
 * those, and that is a property of the source rather than of anybody's memory.
 *
 * `pnpm verify` cannot reach them at all for a different and stronger reason: it
 * runs only the fixture surfaces, where `tests/apps/**` is not collected. D4 asserts
 * that rather than assuming it, because "verify does not run live tests" is the kind
 * of sentence that stays in a comment after it stops being true.
 *
 * ## It is DERIVED, and it has a control
 *
 * The file list comes from `git ls-files`, so a new diagnose spec is covered the
 * moment it is committed — a hand-written list would be a denylist of the suites
 * somebody remembered (§AE). And D3 hands the same matcher a title that carries both
 * tags and requires it to object, because a matcher that found nothing would report
 * every file clean (§W).
 */

const ROOT = findRepoRoot();

/** Every `test.describe(...)` title in a source, with its line. */
export function describeTitles(source: string): Array<{ line: number; title: string }> {
  const found: Array<{ line: number; title: string }> = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const match = /test\.describe(?:\.\w+)*\(\s*['"`](.+?)['"`]/.exec(line);
    if (match?.[1]) found.push({ line: index + 1, title: match[1] });
  }
  return found;
}

/** The tags a scheduled run selects on. Both are read from the real entry points. */
const SCHEDULED_TAGS = ['@smoke', '@regression'] as const;

interface Offender {
  file: string;
  line: number;
  title: string;
  clashes: string[];
}

function offendersIn(file: string, source: string): Offender[] {
  return describeTitles(source)
    .filter((entry) => entry.title.includes('@diagnose'))
    .map((entry) => ({
      file,
      line: entry.line,
      title: entry.title,
      clashes: SCHEDULED_TAGS.filter((tag) => entry.title.includes(tag)),
    }))
    .filter((entry) => entry.clashes.length > 0);
}

test.describe('a @diagnose spec is excluded from every scheduled run @unit', () => {
  test('D1: no @diagnose suite also carries @smoke or @regression', () => {
    // wrong: a diagnose suite tagged @smoke as well, which both scheduled entry
    // points would then collect — two minutes of deliberate waiting in a smoke run,
    // and an instrument quietly promoted to a gate.
    const offenders = collectableSpecFiles()
      .flatMap((file) => offendersIn(file, readFileSync(path.join(ROOT, file), 'utf8')))
      .map((o) => `${o.file}:${o.line} — "${o.title}" also carries ${o.clashes.join(', ')}`);
    expect(offenders).toEqual([]);
  });

  test('D2: the scan actually found @diagnose suites, so D1 had a subject', () => {
    // wrong: D1 passing because the file list was empty or the matcher matched
    // nothing — "no offenders" and "nothing was examined" are the same output, and
    // only this test tells them apart (§T). It asserts a subject exists, not how
    // many, so adding or removing a diagnose suite does not make it a tripwire.
    const files = collectableSpecFiles();
    expect(files.length, 'the collectable spec list is empty').toBeGreaterThan(10);

    const diagnosed = files.filter((file) =>
      describeTitles(readFileSync(path.join(ROOT, file), 'utf8')).some((entry) =>
        entry.title.includes('@diagnose'),
      ),
    );
    expect(diagnosed.length, 'no @diagnose suite exists, so D1 examined nothing').toBeGreaterThan(
      0,
    );
  });

  test('D3: the matcher OBJECTS to a title carrying both, on synthetic source', () => {
    // wrong: a matcher that never matched would make D1 vacuous forever. So it is
    // handed the failing case directly — and the silent cases beside it, because a
    // detector that flags everything is as useless as one that flags nothing.
    //
    // The three samples live in `tests/support/`, not here. Written inline, the
    // offending one made THIS FILE an offender and D1 duly reported it — a check
    // reading its own source, which this repo has now hit three times. An
    // allowlist entry for this file would have fixed the symptom and blinded the
    // guard to a real offender added here later.
    expect(offendersIn('synthetic.spec.ts', DESCRIBE_WITH_SCHEDULED_TAG)).toHaveLength(1);
    expect(offendersIn('synthetic.spec.ts', DESCRIBE_WITH_SCHEDULED_TAG)[0]!.clashes).toEqual([
      '@smoke',
    ]);
    expect(offendersIn('synthetic.spec.ts', DESCRIBE_DIAGNOSE_ONLY)).toEqual([]);
    // And a suite with no @diagnose at all is none of this test's business.
    expect(offendersIn('synthetic.spec.ts', DESCRIBE_WITHOUT_DIAGNOSE)).toEqual([]);
  });

  test('D4: the scheduled entry points select by tag, and verify runs no live project', () => {
    // wrong: asserting the tag rule while the commands had stopped selecting by tag
    // — then D1 would be guarding a mechanism nobody uses, which is the shape of a
    // check that passes while the thing it protects is wide open. Read from the real
    // script and the real pipeline, never restated here.
    const scripts = (
      JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts['test:smoke:live'], 'the live smoke command no longer greps a tag').toContain(
      '--grep @smoke',
    );

    const jenkins = readFileSync(path.join(ROOT, 'infra', 'jenkins', 'Jenkinsfile'), 'utf8');
    expect(jenkins, 'the nightly no longer defaults its grep to @regression').toMatch(
      /defaultValue:\s*'@regression'/,
    );

    // And `verify` reaches only the fixture surfaces. A bare `playwright test` in it
    // would resolve a live environment and collect `tests/apps/**`, diagnose suites
    // among them — so the absence of one is the property, not the list of what is
    // present.
    expect(scripts.verify).not.toMatch(/(^|&&\s*)playwright test/);
    for (const part of scripts.verify!.split('&&').map((p) => p.trim())) {
      expect(part, `verify step "${part}" is not a fixture-surface step`).toMatch(
        /^pnpm (format:check|lint|typecheck|test:unit|test:demo|check:api-deps|test:api:internal|--filter @aitp\/api build)$/,
      );
    }
  });
});
