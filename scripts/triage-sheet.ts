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
import { ambientEnvName, loadEnvironment } from '@aitp/execution-engine';

/**
 * Module (sheet column 1) -> the captured route that IS that screen.
 *
 * DATA, in `config/apps/<application>/module-routes.json`, beside `module-map.json`
 * and loaded the same way. It was a `Record` in this file with nine DMS module names
 * in it — so a script that is otherwise application-agnostic knew one application by
 * name, and a second application could not be triaged at all without editing code.
 *
 * Explicit rather than inferred, and PRINTED on every run: a wrong pairing
 * manufactures a false ceiling in whichever direction it errs, so this is the one
 * thing here a human should check by eye rather than trust.
 */
interface ModuleRoutes {
  routes: Record<string, string>;
  /** Why a pairing is what it is. Read by nothing; kept where the pairing is. */
  notes?: Record<string, string>;
  /** Captured and deliberately NOT paired, with the reason. Printed. */
  skipped?: Record<string, string>;
  /** Modules with no capture yet. Printed, so the gap is visible. */
  notCaptured?: string[];
}

function loadModuleRoutes(application: string): ModuleRoutes {
  const file = path.join(findRepoRoot(), 'config', 'apps', application, 'module-routes.json');
  if (!existsSync(file)) {
    throw new Error(
      `no module routes for application "${application}": ${path.relative(findRepoRoot(), file)} ` +
        'does not exist. Triage pairs each sheet module against a captured screen, and that ' +
        'pairing is per application — see docs/ADD-AN-APPLICATION.md.',
    );
  }
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as ModuleRoutes;
  if (!parsed.routes || Object.keys(parsed.routes).length === 0) {
    throw new Error(`${file}: no "routes" — refusing to report a ceiling against nothing.`);
  }
  return parsed;
}

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
function capturedPaths(
  root: string,
  application: string,
): { paths: Set<string>; unparseable: string[]; unlabelled: number } {
  // PER APPLICATION, and the legacy root is COUNTED rather than read.
  //
  // This used to read `artifacts/inspect/` — every session, whatever application it
  // came from. Measured 2026-09-30 with a second application declared: both sets
  // pooled into one, and a module was paired against a screen from a different
  // system. A ceiling computed from that is a claim about the pairing, not the sheet.
  //
  // Sessions written before captures carried an application stay where they are and
  // are counted. Silently folding them into this application's set would be exactly
  // the guess the label exists to remove; silently ignoring them would understate
  // the coverage, which understates a ceiling that gets quoted.
  const dir = path.join(root, 'artifacts', application, 'inspect');
  const paths = new Set<string>();
  const unparseable: string[] = [];
  const legacy = path.join(root, 'artifacts', 'inspect');
  const unlabelled = existsSync(legacy)
    ? readdirSync(legacy, { withFileTypes: true }).filter((e) => e.isDirectory()).length
    : 0;
  if (!existsSync(dir)) return { paths, unparseable, unlabelled };

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
  return { paths, unparseable, unlabelled };
}

function main(): void {
  const workbook = process.argv[2];
  if (!workbook) throw new Error('usage: pnpm triage <workbook.xlsx> [--out <dir>]');
  const outIndex = process.argv.indexOf('--out');
  const outDir = outIndex > 0 ? process.argv[outIndex + 1] : undefined;

  const root = findRepoRoot();

  // `--app` IS REQUIRED, and a disagreement with the environment is REFUSED.
  //
  // `triage` is non-interactive: nobody is watching it resolve a target, and its
  // output — a ceiling that gets quoted — is about one application's sheet paired
  // against one application's captures. An ambient `TEST_ENV` deciding that silently
  // is SEC-2's shape: the thing that chooses where the work points must not come
  // from the layer that can redirect it without anyone looking.
  //
  // So the application is an argument. If an environment is ALSO set and names a
  // different application, both are printed and the run refuses — the two sources
  // disagree and there is no safe tie-break, which is the same reasoning as the
  // clause-kind column.
  const appIndex = process.argv.indexOf('--app');
  const application = appIndex > 0 ? process.argv[appIndex + 1] : undefined;
  if (!application) {
    throw new Error(
      'usage: pnpm triage <workbook.xlsx> --app <application> [--out <dir>]\n' +
        '  --app is required: triage pairs one application\x27s sheet against that ' +
        'application\x27s captures, and nothing else should decide which.',
    );
  }
  const ambient = ambientEnvName();
  if (ambient) {
    const ambientApplication = loadEnvironment(ambient).application;
    if (ambientApplication !== application) {
      throw new Error(
        `refusing to run: --app says "${application}" and TEST_ENV="${ambient}" is configured ` +
          `for application "${ambientApplication}". Two sources disagree about which ` +
          'application this is, and there is no safe tie-break.\n' +
          `  Pass --app ${ambientApplication}, or unset TEST_ENV.`,
      );
    }
  }

  const routes = loadModuleRoutes(application);
  const MODULE_ROUTES = routes.routes;
  const { paths, unparseable, unlabelled } = capturedPaths(root, application);

  // COUNTED AND SAID, never pooled. A pre-move session has no application on it,
  // so nothing here knows whether it belongs to this one.
  if (unlabelled > 0) {
    console.log(
      `WARNING: ${unlabelled} capture session(s) under artifacts/inspect/ carry no ` +
        'application and are NOT counted below. They were written before captures ' +
        'recorded which system they came from.\n' +
        '  Run `pnpm migrate:captures`, or capture again.',
    );
  }

  if (paths.size === 0)
    throw new Error(
      `no captures found under artifacts/${application}/inspect — refusing to report a ` +
        'ceiling. Run `pnpm inspect` against that application first' +
        (unlabelled > 0 ? `; ${unlabelled} unlabelled session(s) exist but cannot be used.` : '.'),
    );

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

  console.log(`\napplication: ${application}`);
  console.log('module -> capture pairing used (check this by eye):');
  for (const [module, route] of Object.entries(MODULE_ROUTES)) {
    const hit = matchFor(route);
    console.log(`  ${module.padEnd(30)} -> ${route.padEnd(18)} ${hit ?? '** NOT ON DISK **'}`);
  }

  // SKIPPED AND NOT-CAPTURED ARE PRINTED, because a module missing from the pairing
  // above is invisible otherwise — and the two are different answers. "Captured and
  // deliberately unpaired" is a decision somebody made with a reason; "no capture
  // yet" is work nobody has done. Collapsing them loses which.
  for (const [module, why] of Object.entries(routes.skipped ?? {})) {
    console.log(`  ${module.padEnd(30)} -> SKIPPED: ${why}`);
  }
  if ((routes.notCaptured ?? []).length > 0) {
    console.log(
      `  ${(routes.notCaptured ?? []).length} module(s) with no capture yet: ` +
        `${(routes.notCaptured ?? []).join(', ')}`,
    );
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

/**
 * A REFUSAL MUST READ AS A REFUSAL, NOT AS A CRASH.
 *
 * This was `main();` — a bare call to a SYNCHRONOUS function that throws, so Node
 * printed the message under fifteen frames of `Module._compile` and
 * `loadCJSModuleWithModuleLoad`. Measured 2026-10-01 by running what the quickstart
 * tells a QA to run, on a fresh clone (§AG): the first command in the chain refuses,
 * correctly, and a QA sees a stack trace and concludes the tool is broken rather than
 * that they have a step to do first.
 *
 * The message was always right. Everything around it said "bug".
 *
 * `try`/`catch` and not `main().catch(…)`, which was the first attempt here: `main`
 * returns `void`, so that form is a type error — invisible under tsx, which
 * transpiles without typechecking, and it would have gone on printing the stack it
 * was written to remove.
 */
try {
  main();
} catch (error) {
  process.stderr.write(`\n${(error as Error).message}\n\n`);
  process.exitCode = 1;
}
