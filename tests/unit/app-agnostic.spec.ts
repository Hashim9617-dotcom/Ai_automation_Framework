import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { findRepoRoot } from '@aitp/shared';

/**
 * The layering claim, made checkable.
 *
 * > `packages/` and `apps/` are app-agnostic. Everything that knows about one
 * > particular application lives in `tests/`, `config/env/` and `.env`.
 *
 * That is the claim "pointing this platform at a second application is a
 * config change" rests on, and until now it was an assertion. Rule 3 applies
 * to it like anything else: a claim with no falsifier is decoration, and the
 * cost of finding out it was false is a wall hit at application number two —
 * far more expensive than a test.
 *
 * **Comments are stripped before scanning, deliberately.** A comment naming
 * DmsSynergy is provenance — it records which real bug produced a rule, which
 * this repo values highly and `docs/dms-findings.md` exists to preserve. What
 * must not appear is app knowledge in *code*: a hostname, a credential, a
 * label, a selector, a keyword that only means something in one application.
 */

const ROOT = findRepoRoot();

/** The layers that must not know which application they are testing. */
const AGNOSTIC_DIRS = ['packages', 'apps'];

/**
 * Strings that only make sense for the application currently under test.
 *
 * Hostnames and credentials are the obvious ones. The rest are the vocabulary
 * that would quietly couple a package to one app's domain: a workspace tile, a
 * named row from the file tree, a search term from a fixture.
 */
const APP_SPECIFIC = [
  'dmsuiv3',
  'aitalkx',
  'DmsSynergy',
  'hr.admin',
  'Passw0rd',
  'WS-ALPHA',
  'ABCD',
  'pension',
];

/**
 * DOMAIN vocabulary: nouns belonging to one application rather than to a
 * testing platform.
 *
 * Distinct from `APP_SPECIFIC` above, and the distinction is what the audit was
 * missing. A hostname or a credential is obviously out of place. `employee`,
 * `invoice`, `patient` are not obviously anything — they read as ordinary code
 * until a second application arrives and inherits them.
 *
 * Added 2026-09-08, prompted by `dataFactory.employee()`: HR data with
 * `employeeId`, `jobTitle` and `hireDate` sitting in the engine, passed over by
 * the identifier audit twice because it contains no hostname, no credential and
 * no label from the app under test. It has since moved to
 * `tests/support/employee-data.ts`, with the application it describes.
 *
 * Short and concrete on purpose. It does not try to define "domain" in general;
 * it names the vocabularies this repo has actually touched, and grows when a
 * new one appears.
 *
 * **`workspace name` and `document title` were dropped from this list once, and
 * that was wrong.** They were removed because they made the guard fail — which
 * is the failure this repo names everywhere else, arriving from a new
 * direction: a guard weakened until it passes still runs, still reports green,
 * and no longer looks at anything. The correct response to a failing guard is
 * to find out whether it is RIGHT first.
 *
 * It was. The hit was real: `prompt.ts` illustrated untrusted capture content
 * with *"workspace names, document titles"* — one application's vocabulary, in
 * platform code, shipped to every other application. The prompt was made
 * generic and the entries came back.
 *
 * The bare word `workspace` is deliberately NOT here, and that distinction is
 * the real lesson: it occurs legitimately in `paths.ts` as `pnpm-workspace.yaml`,
 * which is pnpm's noun and not any application's. A term earns its place by
 * being specific enough to separate the two.
 */
const DOMAIN_VOCABULARY = [
  'employee',
  'Employee',
  'payroll',
  'Payroll',
  'invoice',
  'Invoice',
  'patient',
  'Patient',
  'workspace name',
  'document title',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.turbo') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/**
 * Removes line and block comments.
 *
 * Imperfect by nature — a `//` inside a string literal is stripped too — and
 * that imprecision is in the SAFE direction here: it can only remove text from
 * the scan, never invent a hit, so a false pass is impossible while a false
 * failure would be visible immediately.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

test.describe('packages/ and apps/ are app-agnostic @unit', () => {
  const files = AGNOSTIC_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)));

  test('the scan actually reads files, and can see a planted hit', () => {
    // Asserts its own effect (CLAUDE.md). A scan reporting "clean" while
    // reading zero files, or with a detector that never matches, is the exact
    // failure this convention was written for.
    expect(files.length).toBeGreaterThan(40);

    const control = stripComments('const host = "dmsuiv3.example.com"; // DmsSynergy\n');
    expect(APP_SPECIFIC.filter((term) => control.includes(term))).toEqual(['dmsuiv3']);
    // And the comment really was stripped, so the exemption below is real.
    expect(control).not.toContain('DmsSynergy');
  });

  test('no app-specific string appears in the CODE of packages/ or apps/', () => {
    const hits: string[] = [];

    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const term of APP_SPECIFIC) {
        if (code.includes(term)) {
          hits.push(`${path.relative(ROOT, file)}: ${term}`);
        }
      }
    }

    expect(hits).toEqual([]);
  });

  test('no concrete page object lives outside tests/', () => {
    // Page objects are inherently app-specific — they are business vocabulary.
    // The base classes belong in the engine; the concrete ones never do.
    const offenders = files.filter((file) =>
      /extends\s+(BasePage|AppPage|BaseComponent)\b/.test(
        stripComments(readFileSync(file, 'utf8')),
      ),
    );

    expect(offenders.map((file) => path.relative(ROOT, file))).toEqual([]);
  });

  test('no environment default hardcodes a target application', () => {
    // `config/env/app.json` is the seam: it must be fully parameterised, so
    // pointing at another app is an .env edit and nothing more.
    const appEnv = readFileSync(path.join(ROOT, 'config/env/app.json'), 'utf8');
    const parsed = JSON.parse(appEnv) as { baseUrl: string; apiBaseUrl: string };

    expect(parsed.baseUrl).toBe('${BASE_URL}');
    expect(parsed.apiBaseUrl.startsWith('${API_BASE_URL')).toBe(true);
    for (const term of APP_SPECIFIC) expect(appEnv).not.toContain(term);
  });
});

/**
 * The keyword audit finds app IDENTIFIERS. This finds app NOUNS.
 *
 * `dataFactory.employee()` passed the identifier audit twice: it contains no
 * hostname, no credential, no label from the app under test. It was still
 * HR-domain vocabulary sitting in `packages/`, and the only reason it was ever
 * noticed is that a human read the file.
 *
 * A guard that only catches what looks obviously foreign is a guard that
 * catches the easy half. Domain nouns are the hard half precisely because they
 * read as ordinary code.
 */
test.describe('packages/ and apps/ carry no DOMAIN vocabulary @unit', () => {
  const files = AGNOSTIC_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)));

  test('the domain scan can see a planted noun', () => {
    // Asserts its own effect, and the control uses the exact symbol that got
    // past the identifier audit twice.
    const planted = stripComments('export function employee() { return 1; }');
    expect(DOMAIN_VOCABULARY.filter((term) => planted.includes(term))).toEqual(['employee']);
    expect(files.length).toBeGreaterThan(40);
  });

  test('no domain noun appears in the CODE of packages/ or apps/', () => {
    const hits: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const term of DOMAIN_VOCABULARY) {
        if (code.includes(term)) hits.push(`${path.relative(ROOT, file)}: ${term}`);
      }
    }
    expect(hits).toEqual([]);
  });

  /**
   * The application slugs, DERIVED — never a list kept here.
   *
   * Two sources, unioned, because each is blind where the other sees:
   * a directory under `config/apps/` exists before any environment points at
   * it, and an environment declares an `application` before that directory is
   * created. Adding a source can only widen the set.
   *
   * This is the third list-shaped guard in one session (E3's statuses, E2's
   * buckets, and `APP_SPECIFIC` above). It is the worst of the three, because
   * the platform's largest architectural claim rests on it: `APP_SPECIFIC`
   * holds "DmsSynergy" and "dmsuiv3" but not "DMS", so `'SOC DMS'` sat in
   * `packages/` unseen.
   */
  const applicationSlugs = (): string[] => {
    const fromDirs = readdirSync(path.join(ROOT, 'config', 'apps'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const envDir = path.join(ROOT, 'config', 'env');
    const fromEnv = readdirSync(envDir)
      .filter((file) => file.endsWith('.json'))
      .map(
        (file) =>
          (JSON.parse(readFileSync(path.join(envDir, file), 'utf8')) as { application?: string })
            .application,
      )
      .filter((slug): slug is string => typeof slug === 'string' && slug.length > 0);
    return [...new Set([...fromDirs, ...fromEnv])].sort();
  };

  /**
   * The one place a slug is allowed to remain in `packages/`, named exactly.
   *
   * An honest written-down exception beats both a red gate and a guard nobody
   * runs — but it is ONE entry, and it carries what it would take to delete it.
   * A second entry is a sign the rule is being negotiated rather than met.
   */
  const KNOWN_VIOLATIONS = [
    {
      file: 'packages/shared/src/authored/final-test-cases.ts',
      slug: 'dms',
      context: "the column list carries 'SOC DMS', a header from one customer's workbook",
      since: '2026-09-18',
      why:
        'the expected column names are a property of a SHEET, not of the platform: the ' +
        "position mapping was measured from ONE workbook and every QA team's sheet differs",
      fix: 'move the column list to per-sheet config, the same move the module map made, then delete this entry',
    },
  ];

  test('an application slug does not appear in the CODE of packages/ or apps/', () => {
    // wrong: a slug reaches shared code and the claim "pointing at a second
    // application is a config change" is false while the suite stays green —
    // which is what happened to 'SOC DMS' under the keyword list above.
    //
    // LIMIT, stated because a guard's silence is read as coverage: this scans
    // CODE. Comments are stripped, so a slug in prose is deliberately invisible
    // to it. And it can only see slugs that config already declares.
    const slugs = applicationSlugs();
    // Asserts its own effect twice: the set is real, and the matcher matches.
    expect(slugs.length).toBeGreaterThan(0);
    const matches = (code: string, slug: string): boolean =>
      new RegExp(`\\b${slug}\\b`, 'i').test(code);
    expect(matches(stripComments("const sheet = 'SOC DMS'; // dms\n"), 'dms')).toBe(true);
    expect(matches(stripComments('// only in a comment: dms\n'), 'dms')).toBe(false);

    const excused = new Set(KNOWN_VIOLATIONS.map((entry) => `${entry.file}: ${entry.slug}`));
    const hits: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'));
      const relative = path.relative(ROOT, file).split(path.sep).join('/');
      for (const slug of slugs) {
        if (matches(code, slug) && !excused.has(`${relative}: ${slug}`)) {
          hits.push(`${relative}: ${slug}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  test('every named exception is still real, and still needed', () => {
    // wrong: an exception outlives the violation it excuses, and the list
    // becomes a place where new ones can hide behind an old name — the
    // allow-list failure this repo already fixed once for invisible characters.
    for (const entry of KNOWN_VIOLATIONS) {
      const code = stripComments(readFileSync(path.join(ROOT, entry.file), 'utf8'));
      expect(
        new RegExp(`\\b${entry.slug}\\b`, 'i').test(code),
        `${entry.file} no longer contains "${entry.slug}" in code — delete this exception`,
      ).toBe(true);
      expect(entry.why.length).toBeGreaterThan(20);
      expect(entry.fix.length).toBeGreaterThan(20);
    }
  });

  test('the vocabulary it names is still absent where it was removed from', () => {
    // Discriminating: the symbol this rule was written for really did live
    // here, so a scan that found nothing anywhere would not prove much.
    const factory = readFileSync(
      path.join(ROOT, 'packages/execution-engine/src/data/factory.ts'),
      'utf8',
    );
    expect(stripComments(factory)).not.toContain('employee');
    // And what stayed behind is genuinely generic, so the move was a move
    // rather than a deletion of something useful.
    expect(factory).toContain('unique');
    expect(factory).toContain('password');
  });
});
