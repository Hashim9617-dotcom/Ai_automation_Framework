import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { findRepoRoot, loadDeclaredModules, loadModuleMap } from '@aitp/shared';
import { environmentsDeclaring } from '@aitp/execution-engine';

/**
 * ECOM, ONBOARDED: 33 modules declared, none mapped, and that state is NAMEABLE.
 *
 * ## The state the map could not express
 *
 * `module-map.json` requires a `route` and a `provenBy` per entry, correctly — an
 * entry without them proves nothing. But Ecom's real state is *the sheet has been
 * read and the screens have not been walked*, and the map had no way to say it. The
 * tempting fix was an entry with `route: ''` filled in later, which is the
 * placeholder this repo refuses on principle: **a map that loads and proves nothing
 * reads as a map**, and every count over it would include entries that cannot
 * resolve while looking like progress.
 *
 * So the inventory is its own file, and the gap between the two files IS the answer
 * to "how far has this application got".
 *
 * ## Where the 33 came from
 *
 * The Module column of the 'Test Cases' tab of both Ecom workbooks, which agree
 * exactly: 987 non-blank cells each, 33 distinct values, same order. Verified against
 * an INDEPENDENT OOXML parser rather than only this repo's reader (§AK) — the repo's
 * `readSheetGrid` was compared against it cell by cell, 15,808 cells, zero
 * mismatches. That comparison is also what found the attribute-order bug that had
 * made both workbooks unreadable.
 *
 * Neither workbook is in this repo and neither may be.
 */

const ROOT = findRepoRoot();
const ECOM_DIR = path.join(ROOT, 'config', 'apps', 'ecom');

/** A temp directory holding exactly the files a test names. */
function fixtureDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'aitp-ecom-'));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), body, 'utf8');
  }
  return dir;
}

test.describe('the Ecom application is declared, and its gaps are nameable @unit', () => {
  test('E1: config/apps/ecom declares exactly the 33 modules read from the sheet', () => {
    // wrong: 32 or 34 would mean the Module column was read with a different reader,
    // a different sheet or a different notion of "distinct" — and the count is pinned
    // because it is the DENOMINATOR of everything said about Ecom's coverage later.
    // A list that silently lost one would make every ratio flattering.
    const declared = loadDeclaredModules(path.join(ECOM_DIR, 'modules.json'));
    expect(declared.modules).toHaveLength(33);
    // Both ends and one in the middle, so a reordering or a truncation is visible.
    // Spot values rather than the whole list: pinning all 33 here would make this
    // test a second copy of the file (§AE) and a sheet correction would have to be
    // made twice.
    expect(declared.modules[0]).toBe('Departments');
    expect(declared.modules).toContain('Goods Receipt (GRN)');
    expect(declared.modules.at(-1)).toBe('RBAC');
    // DISTINCT, which is the property the file claims to hold.
    expect(new Set(declared.modules).size).toBe(declared.modules.length);
  });

  test('E2: NO module is mapped yet, and asking for the map says so by name', () => {
    // wrong: an empty-but-present module-map.json, which `loadModuleMap` would reject
    // with "has no modules in it" — the message for a file somebody emptied, not for
    // an application nobody has walked. Worse, an ENOENT used to surface raw:
    // "could not be read as JSON: ENOENT, open '…/module-map.json'" sends the reader
    // hunting for a file they are supposed to be about to create.
    expect(
      existsSync(path.join(ECOM_DIR, 'module-map.json')),
      'module-map.json exists, so this test no longer describes Ecom',
    ).toBe(false);

    let message = '';
    try {
      loadModuleMap(path.join(ECOM_DIR, 'module-map.json'));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('33 module(s) are declared');
    expect(message).toContain('none of them is mapped');
    // The WHOLE command, which is the thing a reader acts on (§AG).
    expect(message).toContain('pnpm inspect --app ecom');
    expect(message).toContain('a map that loaded with nothing in it');
  });

  test('E3: without an inventory beside it, a missing map is the ORDINARY error', () => {
    // wrong: E2 alone is satisfied by a `loadModuleMap` that prints the onboarding
    // sentence for every unreadable file — including a corrupt one, a permissions
    // failure, or a typo'd path — which would tell a reader to run `inspect` when the
    // problem is something else entirely. This is the silent half the assertion in E2
    // is written against (§W): modules.json is what distinguishes the two states, so
    // with no modules.json the message must NOT claim to know which state this is.
    const dir = fixtureDir({});
    let message = '';
    try {
      loadModuleMap(path.join(dir, 'module-map.json'));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('could not be read as JSON');
    expect(message).not.toContain('are declared');
    expect(message).not.toContain('pnpm inspect');
  });

  test('E4: an inventory that declares nothing is REFUSED, not read as an empty app', () => {
    // wrong: an empty array validates perfectly and then makes every later count
    // zero — after which "this application has no modules" and "nobody has read the
    // sheet yet" are the same answer, and the first one looks like a fact (§T).
    const dir = fixtureDir({ 'modules.json': JSON.stringify({ modules: [] }) });
    expect(() => loadDeclaredModules(path.join(dir, 'modules.json'))).toThrow(
      /declares no modules/,
    );
  });

  test('E5: a malformed inventory is refused by shape, naming the index', () => {
    // wrong: each of these would otherwise reach a caller as a plausible list — a
    // missing `modules` key as `undefined`, a blank entry as a module whose name is
    // '' that matches no sheet row and is refused later as an unmapped module with no
    // name. Refusing at the loader is what keeps the later refusal meaningful.
    const noKey = fixtureDir({ 'modules.json': JSON.stringify({ names: ['a'] }) });
    expect(() => loadDeclaredModules(path.join(noKey, 'modules.json'))).toThrow(
      /"modules" must be an array/,
    );

    const blank = fixtureDir({ 'modules.json': JSON.stringify({ modules: ['Tax', '  '] }) });
    expect(() => loadDeclaredModules(path.join(blank, 'modules.json'))).toThrow(/modules\[1\]/);

    const repeated = fixtureDir({
      'modules.json': JSON.stringify({ modules: ['Tax', 'Currency', 'Tax'] }),
    });
    expect(() => loadDeclaredModules(path.join(repeated, 'modules.json'))).toThrow(/"Tax"/);
  });

  test('E6: exactly one environment declares "ecom", so no command has to choose', () => {
    // wrong: zero environments and `pnpm auth --app ecom` refuses with "no environment
    // declares application ecom"; two and it refuses with a list, because nothing can
    // say which live system was meant. Either way the commands handed over at the end
    // of this batch do not run, and ONE is what makes them runnable without TEST_ENV.
    expect(
      environmentsDeclaring({ configDir: path.join(ROOT, 'config', 'env'), application: 'ecom' }),
    ).toEqual(['ecom']);
  });

  test('E7: config/env/ecom.json carries no URL and no credential of its own', () => {
    // wrong: a literal baseUrl here, or a username in plain text, and the file is
    // either a committed credential or a target that `${...}` cannot redirect — and a
    // pinned literal is specifically exempt from the BASE_URL override, so writing one
    // would also silently change which value wins. Every secret-shaped field must be
    // a placeholder naming an ECOM_* variable and nothing else.
    const raw = readFileSync(path.join(ROOT, 'config', 'env', 'ecom.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      application: string;
      baseUrl: string;
      users: Record<string, { username: string; password: string }>;
      features: Record<string, boolean>;
    };
    expect(parsed.application).toBe('ecom');
    expect(parsed.baseUrl).toBe('${ECOM_BASE_URL}');
    expect(parsed.users.admin?.username).toBe('${ECOM_USER}');
    expect(parsed.users.admin?.password).toBe('${ECOM_PASSWORD}');
    // Read-only by decision: `pnpm heal --app ecom` refuses by name while this is
    // false, so the first thing anybody could run cannot write a model's proposal.
    expect(parsed.features.selfHealing).toBe(false);
    expect(parsed.features.aiRootCause).toBe(false);
    // Nothing in the file may name a variable outside the ECOM_ family — a stray
    // ${APP_PASSWORD} would hand this environment the FIRST application's credential.
    const placeholders = [...raw.matchAll(/\$\{([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]!);
    expect(placeholders.length, 'no placeholders found — the scan had no subject').toBeGreaterThan(
      0,
    );
    expect([...new Set(placeholders)].filter((name) => !name.startsWith('ECOM_'))).toEqual([]);
  });

  test('E8: every declared application has a config directory, and vice versa', () => {
    // wrong: a `config/env/*.json` naming an application with no `config/apps/<slug>/`
    // fails much later as a missing module map, and a `config/apps/<slug>/` no
    // environment names is a directory nothing can ever reach — both silent today.
    // DERIVED from the two directories rather than listed, so adding a third
    // application cannot pass by being forgotten here (§AE).
    const envDir = path.join(ROOT, 'config', 'env');
    const declared = new Set(
      readdirSync(envDir)
        .filter((file) => file.endsWith('.json'))
        .map(
          (file) =>
            (JSON.parse(readFileSync(path.join(envDir, file), 'utf8')) as { application: string })
              .application,
        ),
    );
    const directories = new Set(
      readdirSync(path.join(ROOT, 'config', 'apps'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    );
    expect(declared.size, 'no applications declared — the check had no subject').toBeGreaterThan(0);
    expect([...declared].sort()).toEqual([...directories].sort());
  });
});
