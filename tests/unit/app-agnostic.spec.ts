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
