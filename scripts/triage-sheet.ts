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

/** Capture labels actually on disk. Derived, so it cannot go stale. */
function capturedRoutes(root: string): Set<string> {
  const dir = path.join(root, 'artifacts', 'inspect');
  const labels = new Set<string>();
  if (!existsSync(dir)) return labels;
  for (const session of readdirSync(dir)) {
    const pages = path.join(dir, session, 'pages.json');
    if (existsSync(pages)) {
      for (const page of JSON.parse(readFileSync(pages, 'utf8'))) labels.add(page.label);
    }
    const capture = path.join(dir, session, 'capture.json');
    if (existsSync(capture)) {
      for (const state of JSON.parse(readFileSync(capture, 'utf8')).states ?? []) {
        labels.add(state.id);
      }
    }
  }
  return labels;
}

function main(): void {
  const workbook = process.argv[2];
  if (!workbook) throw new Error('usage: pnpm triage <workbook.xlsx> [--out <dir>]');
  const outIndex = process.argv.indexOf('--out');
  const outDir = outIndex > 0 ? process.argv[outIndex + 1] : undefined;

  const root = findRepoRoot();
  const routes = capturedRoutes(root);
  if (routes.size === 0) throw new Error('no captures found under artifacts/inspect — refusing to report a ceiling');

  const capturedModules = new Set(
    Object.entries(MODULE_ROUTES)
      .filter(([, route]) => routes.has(route))
      .map(([module]) => module),
  );

  console.log(`captures on disk: ${[...routes].sort().join(', ')}`);
  console.log('\nmodule -> capture pairing used (check this by eye):');
  for (const [module, route] of Object.entries(MODULE_ROUTES)) {
    console.log(`  ${module.padEnd(30)} -> ${route}${routes.has(route) ? '' : '   ** NOT ON DISK **'}`);
  }

  const sheet = readFinalTestCases(readSheetGrid(readFileSync(workbook), 'Final Test cases'));
  if (sheet.rows.length === 0) throw new Error('read 0 rows — refusing to report a ceiling');

  const triage = triageSheet(sheet.rows, capturedModules);
  const { ceiling } = triage;

  console.log(`\nrows read: ${sheet.rows.length} (+${sheet.unreadable.length} unreadable)`);
  console.log(
    `ceiling with today's captures : ${(ceiling.withCurrentCaptures * 100).toFixed(1)}%  ` +
      `(${ceiling.modulesCaptured} of ${ceiling.modulesTotal} modules)`,
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
      throw new Error(`the triage at ${file} does not carry both ceilings — refusing to report success`);
    }
    console.log(`\nwritten and verified: ${file}`);
  }
}

main();
