#!/usr/bin/env node
/**
 * Sheet triage, and the two ceilings.
 *
 *   pnpm triage "C:/path/to/Test case Sheet.xlsx"
 *   pnpm triage "…/sheet.xlsx" --out artifacts/triage
 *
 * Prints, and optionally writes, which rows can never be automated and why —
 * and the pair of ceilings, each carrying the capture coverage it assumed.
 *
 * **This exists so the delta can be re-measured in one command.** The claim on
 * record is that capture coverage is the binding constraint: today 29.8%, and
 * 48.5% once every module has been walked. Re-running this after the nine
 * missing modules are captured is the FALSIFIER for that claim. If the first
 * number moves towards the second, it holds. If it barely moves, the prediction
 * was wrong and the real wall is somewhere nobody has looked — which is worth
 * more than being right.
 *
 * The workbook is never read from a committed path and never written to. It
 * carries live credentials in its Test Data column, so it stays outside the
 * repo and this script only ever reads it.
 */
/* eslint-disable no-console -- triage summary for a human to check by eye
   (capture pairing, row counts) — not a machine-consumable log line. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  readSheetGrid,
  readFinalTestCases,
  triageSheet,
  renderTriage,
  findRepoRoot,
} from '@aitp/shared';

/**
 * Module (sheet column 1) -> the captured route that IS that screen.
 *
 * Explicit rather than inferred, and PRINTED on every run. A wrong pairing
 * manufactures a false ceiling in whichever direction it errs, so this is the
 * one thing here that a human should check by eye rather than trust.
 *
 * Add a line when a module is captured. Nothing else needs to change — the
 * capture set itself is read from `artifacts/inspect/`, so a pairing that names
 * a route nobody has captured is reported rather than silently believed.
 */
const MODULE_ROUTES: Record<string, string> = {
  Dashboard: 'dashboard',
  'File Explorer': 'files',
  Document: 'files',
  'Global search': 'search',
  User: 'admin/users',
  'User Role': 'admin/user-roles',
  'user role': 'admin/user-roles',
  'Bulk upload': 'upload-files',
  // Not yet captured — uncomment as each screen is walked:
  // 'Document Template Categories': '…',
  // 'User Group': '…',
  // Permissions: '…',
  // Workflow: '…',
  // 'Policy agent': '…',
  // Notification: '…',
  // Login: '…',
  // 'Audit Logs': '…',
};

/** Path segments, with the origin and any leading/trailing slashes gone. */
function segmentsOf(value: string): string[] {
  return value
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean);
}

/**
 * Does a captured path sit AT or BENEATH the route a module names?
 *
 * Segment-wise, never `startsWith`. A string prefix pairs `/upload` with
 * `upload-files` — silently, and in the flattering direction, because it
 * manufactures a capture nobody took. Comparing segments makes `upload` and
 * `upload-files` two different first segments, while `/admin/users/123` still
 * sits beneath `admin/users` where it belongs.
 */
function pathMatchesRoute(capturedPath: string, route: string): boolean {
  const want = segmentsOf(route);
  const got = segmentsOf(capturedPath);
  if (want.length === 0 || got.length < want.length) return false;
  return want.every((segment, index) => got[index] === segment);
}

/**
 * The PATHS actually captured, from the URL each capture recorded.
 *
 * Pairing used to compare the NAME a human typed at capture time — `page.label`
 * or `slugify(label)`. That name is free text: `inspect-app.ts` proposes
 * `<route>.<heading>` and slugifies it, so accepting the proposal on
 * `/dashboard` produces `dashboard-dashboard`, which paired with nothing. Two
 * of the nine sessions on disk were orphaned that way while their URLs said
 * exactly which screen they were.
 *
 * Both capture formats carry the address, so both pair the same way here:
 * `pages.json` entries have `url`, and `capture.json` states have `url`.
 *
 * A URL that cannot be parsed is COLLECTED, never dropped — a capture silently
 * missing from this set understates the coverage, which understates a ceiling
 * that gets quoted.
 */
function capturedPaths(root: string): { paths: Set<string>; unparseable: string[] } {
  const dir = path.join(root, 'artifacts', 'inspect');
  const paths = new Set<string>();
  const unparseable: string[] = [];
  if (!existsSync(dir)) return { paths, unparseable };

  const add = (url: unknown, where: string): void => {
    if (typeof url !== 'string') return void unparseable.push(`${where}: no url`);
    try {
      paths.add(new URL(url).pathname);
    } catch {
      unparseable.push(`${where}: ${url}`);
    }
  };

  for (const session of readdirSync(dir)) {
    const pages = path.join(dir, session, 'pages.json');
    if (existsSync(pages)) {
      for (const page of JSON.parse(readFileSync(pages, 'utf8'))) add(page.url, session);
    }
    const capture = path.join(dir, session, 'capture.json');
    if (existsSync(capture)) {
      for (const state of JSON.parse(readFileSync(capture, 'utf8')).states ?? [])
        add(state.url, session);
    }
  }
  return { paths, unparseable };
}

function main(): void {
  const workbook = process.argv[2];
  if (!workbook) throw new Error('usage: pnpm triage <workbook.xlsx> [--out <dir>]');
  const outIndex = process.argv.indexOf('--out');
  const outDir = outIndex > 0 ? process.argv[outIndex + 1] : undefined;

  const root = findRepoRoot();
  const { paths, unparseable } = capturedPaths(root);
  if (paths.size === 0)
    throw new Error('no captures found under artifacts/inspect — refusing to report a ceiling');

  const matchFor = (route: string): string | undefined =>
    [...paths].sort().find((captured) => pathMatchesRoute(captured, route));

  const capturedModules = new Set(
    Object.entries(MODULE_ROUTES)
      .filter(([, route]) => matchFor(route) !== undefined)
      .map(([module]) => module),
  );

  console.log(`paths captured: ${[...paths].sort().join(', ')}`);
  if (unparseable.length > 0) {
    console.log(
      `  ** ${unparseable.length} capture(s) with no usable url: ${unparseable.join('; ')}`,
    );
  }

  console.log('\nmodule -> capture pairing used (check this by eye):');
  for (const [module, route] of Object.entries(MODULE_ROUTES)) {
    const hit = matchFor(route);
    console.log(`  ${module.padEnd(30)} -> ${route.padEnd(18)} ${hit ?? '** NOT ON DISK **'}`);
  }

  // Captured but unpaired: a screen someone walked that no module names. This
  // is the actionable direction — the capture exists, the pairing does not.
  const orphans = [...paths]
    .filter((captured) => !Object.values(MODULE_ROUTES).some((r) => pathMatchesRoute(captured, r)))
    .sort();
  console.log(
    orphans.length === 0
      ? '\ncaptured but unpaired: none'
      : `\ncaptured but unpaired (${orphans.length}): ${orphans.join(', ')}`,
  );

  const sheet = readFinalTestCases(readSheetGrid(readFileSync(workbook), 'Final Test cases'));
  if (sheet.rows.length === 0) throw new Error('read 0 rows — refusing to report a ceiling');

  const triage = triageSheet(sheet.rows, capturedModules);
  const { ceiling } = triage;

  console.log(`\nrows read: ${sheet.rows.length} (+${sheet.unreadable.length} unreadable)`);
  console.log(
    `ceiling with today's captures : ${(ceiling.withCurrentCaptures * 100).toFixed(1)}%  ` +
      `(${ceiling.modulesCaptured} of ${ceiling.modulesTotal} sheet module keys)`,
  );
  console.log(
    `ceiling once all are captured : ${(ceiling.withAllModulesCaptured * 100).toFixed(1)}%  ` +
      `(${ceiling.rowsBlockedByMissingCapture} rows blocked only by a missing capture)`,
  );
  console.log(`\n${JSON.stringify(triage.counts, null, 1)}`);

  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, 'sheet-triage.md');
    const markdown = renderTriage(triage);
    writeFileSync(file, markdown, 'utf8');
    // The script asserts its own effect before reporting success.
    const landed = readFileSync(file, 'utf8');
    if (!landed.includes("With today's captures")) {
      throw new Error(
        `the triage at ${file} does not carry both ceilings — refusing to report success`,
      );
    }
    console.log(`\nwritten and verified: ${file}`);
  }
}

main();
