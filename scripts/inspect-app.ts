#!/usr/bin/env node
/**
 * Interactive application inspector.
 *
 *   pnpm inspect https://qa.your-app.com/login
 *
 * Opens a real browser and hands it to you. Log in however your app requires —
 * password, SSO, OTP, whatever — navigate to a page you want automated, then
 * name it here and press Enter to capture it. Repeat for as many pages as you
 * like.
 *
 * Output lands in artifacts/inspect/:
 *   - report.md   readable inventory, ready to paste into a chat
 *   - pages.json  the raw DomSnapshot AND the real accessibility tree per page
 *
 * Both captures are kept, deliberately, because they disagree and the
 * disagreement is the point. `DomSnapshot.name` is a heuristic
 * (aria-labelledby -> <label> -> innerText); the accessibility tree is the
 * browser's own computed name, which is what `getByRole({ name })` actually
 * matches against. Findings 5, 6, 10 and 11 (docs/dms-findings.md) were every
 * one of them a case where those two strings differed and we trusted the
 * wrong one — a tree row reading "ABCD" whose real name is
 * "Collapse ABCD More options", a button reading "Create User" whose real name
 * carries an invisible icon glyph. report.md surfaces those divergences
 * explicitly, because they are the locators that will silently never match.
 *
 * Why interactive rather than scripted: a real enterprise app has SSO, MFA,
 * consent screens and landing redirects. Automating the login *before* you know
 * the DOM is backwards — so a human drives, and the tool records.
 *
 * Nothing leaves your machine. Field values are filtered by the same rules the
 * test engine uses, so passwords and tokens are never captured.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { chromium, type Browser, type Page } from '@playwright/test';
import {
  authStatePath,
  captureAccessibilityTree,
  captureDomSnapshot,
  findNameDivergences,
  loadEnvironment,
  type NameDivergence,
} from '@aitp/execution-engine';
import {
  findRepoRoot,
  rootLogger,
  slugify,
  type AccessibilityTreeSnapshot,
  type DomSnapshot,
} from '@aitp/shared';

const log = rootLogger.child('inspect');

/**
 * One readline interface for the whole session. Creating a fresh one per
 * question drops input that is already buffered, which hangs the loop.
 */
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

/**
 * Lines are queued as they arrive rather than read on demand. `rl.question()`
 * alone drops anything typed (or piped) before the prompt was printed, which
 * makes the tool lose input and impossible to script in a test.
 */
const pending: string[] = [];
let waiting: ((line: string) => void) | undefined;
let inputClosed = false;

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (waiting) {
    const resolve = waiting;
    waiting = undefined;
    resolve(trimmed);
  } else {
    pending.push(trimmed);
  }
});

/** Ctrl+D, or a piped stdin that ran out, means "finish" — not a crash. */
rl.on('close', () => {
  inputClosed = true;
  if (waiting) {
    const resolve = waiting;
    waiting = undefined;
    resolve('q');
  }
});

function ask(question: string): Promise<string> {
  process.stdout.write(question);
  const queued = pending.shift();
  if (queued !== undefined) {
    process.stdout.write(`${queued}\n`);
    return Promise.resolve(queued);
  }
  if (inputClosed) return Promise.resolve('q');
  return new Promise((resolve) => {
    waiting = resolve;
  });
}

/**
 * Waits for a single-page app to actually render something before capturing.
 *
 * Without this, capturing immediately after `domcontentloaded` on a SPA
 * records an empty shell — 0 interactive elements, 1 accessibility node — and
 * writes that to the report as though it were the page. A human driving the
 * tool never sees this, because typing a label takes seconds; piped input
 * hits it every time, which is exactly the "impossible to script in a test"
 * failure this file's input queue was already written to avoid.
 *
 * Bounded and non-fatal: if the page genuinely has no interactive elements,
 * we capture it anyway and the caller warns. Better an honest empty capture
 * than a hang.
 */
async function waitForPageToRender(page: Page): Promise<void> {
  try {
    await page.waitForFunction(
      () =>
        document.querySelectorAll(
          'a[href], button, input, select, textarea, [role], [data-testid]',
        ).length > 0,
      undefined,
      { timeout: 10_000 },
    );
  } catch {
    // Timed out: capture whatever is there rather than refusing.
  }

  // The shell rendering is not the same as the content arriving. This app
  // paints its chrome immediately and then fetches the workspace tree, so a
  // capture taken on the first check above sees 21 buttons and no treeitems
  // at all. Bounded and swallowed: an app that polls or holds a socket open
  // never reaches networkidle, and waiting the full timeout on every capture
  // is a worse failure than capturing slightly early.
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
}


function renderDivergences(divergences: NameDivergence[]): string {
  if (divergences.length === 0) {
    return '_No name divergences: every element’s visible label matches its computed accessible name on this page._';
  }

  const fatal = divergences.filter((d) => !d.exactTrueStillResolves);
  const rows = divergences
    .map(
      (d) =>
        `| ${d.role} | "${d.domName}" | "${d.axName}" | ${
          d.exactTrueStillResolves
            ? 'yes — auto-fallback covers it'
            : '**NO — will never match**'
        } |`,
    )
    .join('\n');

  return [
    `#### ⚠ Name divergences (${divergences.length}${fatal.length > 0 ? `, ${fatal.length} fatal` : ''})`,
    '',
    'The visible label and the real computed accessible name differ. The right',
    'column is whether `getByRole(..., { name, exact: true })` on the visible',
    'label still resolves, via SmartLocator’s automatic text-content fallback',
    '(Finding 10).',
    '',
    '- **yes** — an icon glyph drawn by CSS, absent from text content. The',
    '  fallback matches and the locator works. Informational only.',
    '- **NO** — the extra words are real nested elements, so they are part of',
    '  this element’s text content too and the anchored fallback cannot match',
    '  either. This is the Finding 11 shape: an `exact: true` candidate here is',
    '  dead however it is spelled. Use a regex anchored on both ends, or target',
    '  the inner element directly.',
    '',
    'Note the column says *through SmartLocator* — i.e. from a page object, the',
    'way every locator in this repo is written. A raw `page.getByRole(...)` in a',
    'spec has no fallback and fails on **every** row in this table. Verified',
    'live on the workspace tree: raw `exact: true` matches 0 elements, the same',
    'candidate through SmartLocator resolves 1.',
    '',
    '| role | visible label | real accessible name | resolves via SmartLocator? |',
    '| --- | --- | --- | --- |',
    rows,
  ].join('\n');
}

function renderPage(
  snapshot: DomSnapshot,
  axTree: AccessibilityTreeSnapshot,
  label: string,
): string {
  const byRole = new Map<string, DomSnapshot['elements']>();
  for (const element of snapshot.elements) {
    byRole.set(element.role, [...(byRole.get(element.role) ?? []), element]);
  }

  const sections = [...byRole.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([role, elements]) => {
      const rows = elements
        .map((element) =>
          `| ${[
            element.name ? `"${element.name}"` : '—',
            element.testId ? `\`${element.testId}\`` : '—',
            element.placeholder ? `"${element.placeholder}"` : '—',
            element.enabled ? '' : 'disabled',
          ].join(' | ')} |`,
        )
        .join('\n');
      return `#### ${role} (${elements.length})\n\n| name | data-testid | placeholder | state |\n| --- | --- | --- | --- |\n${rows}`;
    })
    .join('\n\n');

  const withTestId = snapshot.elements.filter((element) => element.testId).length;
  const coverage = snapshot.elements.length
    ? Math.round((withTestId / snapshot.elements.length) * 100)
    : 0;

  const divergences = findNameDivergences(snapshot, axTree);

  return [
    `### ${label}`,
    '',
    `- URL: \`${snapshot.url}\``,
    `- Title: ${snapshot.title}`,
    `- Interactive elements: ${snapshot.elements.length}`,
    `- With a \`data-testid\`: ${withTestId} (${coverage}%)`,
    `- Accessibility nodes: ${axTree.nodes.length}${axTree.truncated ? ' (truncated)' : ''}`,
    `- Name divergences: ${divergences.length}`,
    '',
    renderDivergences(divergences),
    '',
    sections,
  ].join('\n');
}

const BANNER = [
  '',
  '─────────────────────────────────────────────────────────────',
  ' A browser window is open. Do this:',
  '',
  '   1. Log in and navigate to a page you want to automate.',
  '   2. Come back here, type a short name for it and press Enter',
  '      (e.g. "login", "employee list", "create employee form").',
  '   3. Repeat for every page you care about.',
  '   4. Type  q  and press Enter when you are done.',
  '',
  ' Passwords and token values are filtered out of the capture.',
  '─────────────────────────────────────────────────────────────',
  '',
].join('\n');

async function main(): Promise<void> {
  // No argument: fall back to the configured application, so switching targets
  // is a .env edit rather than a command you have to remember.
  const env = loadEnvironment();
  const url = process.argv[2] ?? env.baseUrl;
  if (!url) {
    log.error('No URL. Pass one (`pnpm inspect <url>`) or set BASE_URL in .env.');
    process.exitCode = 1;
    return;
  }

  const outDir = path.join(findRepoRoot(__dirname), 'artifacts', 'inspect');
  mkdirSync(outDir, { recursive: true });

  const headless = process.env.INSPECT_HEADLESS === 'true';
  let browser: Browser | undefined;
  const captured: Array<{
    label: string;
    snapshot: DomSnapshot;
    axTree: AccessibilityTreeSnapshot;
  }> = [];

  try {
    browser = await chromium.launch({ headless });
    // Reuse a session saved by `pnpm auth` so you do not log in again every time.
    const savedSession = authStatePath(env.name);
    const reuseSession = existsSync(savedSession);

    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      // Full window when a human is driving; default viewport when headless.
      ...(headless ? {} : { viewport: null }),
      ...(reuseSession ? { storageState: savedSession } : {}),
    });
    if (reuseSession) log.info('Reusing the session saved by `pnpm auth`.');
    const page = await context.newPage();

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch (error) {
      log.error(`Could not open ${url}`, { error: (error as Error).message });
      process.exitCode = 1;
      return;
    }

    process.stdout.write(BANNER);

    for (;;) {
      const label = await ask('Page name (or q to finish): ');
      if (label.toLowerCase() === 'q' || label.toLowerCase() === 'quit') break;
      if (!label) continue;

      try {
        await waitForPageToRender(page);
        const snapshot = await captureDomSnapshot(page, { maxElements: 400 });
        // Captured together, from the same page state, so the two views are
        // directly comparable — a divergence report built from captures taken
        // at different moments would be reporting navigation, not naming.
        const axTree = await captureAccessibilityTree(page, { maxNodes: 500 });
        captured.push({ label, snapshot, axTree });

        const divergences = findNameDivergences(snapshot, axTree).length;
        process.stdout.write(
          `  captured "${label}" — ${snapshot.elements.length} elements, ` +
            `${axTree.nodes.length} accessibility nodes at ${snapshot.url}\n` +
            (divergences > 0
              ? `  ${divergences} name divergence(s) — visible label != real accessible name; see report.md\n`
              : '') +
            // An empty capture is worse than no capture: it looks like data,
            // and anything grounded in it would be grounded in nothing.
            (snapshot.elements.length === 0
              ? '  WARNING: no interactive elements found — the page probably had not finished rendering.\n' +
                '  Re-capture this one; do not use it as a source of truth.\n'
              : '') +
            '\n',
        );
      } catch (error) {
        process.stdout.write(`  could not capture: ${(error as Error).message}\n\n`);
      }
    }
  } finally {
    // Always: an open browser or an open readline keeps the process alive forever.
    rl.close();
    await browser?.close();
  }

  if (captured.length === 0) {
    log.warn('Nothing captured — no report written.');
    return;
  }

  const header = [
    '# Application inventory',
    '',
    `Captured ${captured.length} page(s) on ${new Date().toISOString().slice(0, 10)}.`,
    '',
    'This is what the automation engine can see. Elements without a `data-testid`',
    'have to be reached by role, label or placeholder — workable, but more fragile.',
  ].join('\n');

  const report = [
    header,
    ...captured.map((entry, index) =>
      renderPage(entry.snapshot, entry.axTree, `${index + 1}. ${entry.label}`),
    ),
  ].join('\n\n');

  const reportPath = path.join(outDir, 'report.md');
  const jsonPath = path.join(outDir, 'pages.json');
  writeFileSync(reportPath, report, 'utf8');
  writeFileSync(
    jsonPath,
    JSON.stringify(
      captured.map((entry) => ({
        label: entry.label,
        slug: slugify(entry.label),
        ...entry.snapshot,
        // Kept as its own key rather than merged into the DomSnapshot's
        // `elements`: these are two different views of the same page that
        // disagree, and flattening them would destroy exactly the signal
        // this capture exists to preserve. Grounding checks (step 3) read
        // ONLY this one — see docs/phase-2-generation.md, P1.
        accessibilityTree: entry.axTree,
        nameDivergences: findNameDivergences(entry.snapshot, entry.axTree),
      })),
      null,
      2,
    ),
    'utf8',
  );

  process.stdout.write(
    [
      '',
      `Report:    ${path.relative(process.cwd(), reportPath)}`,
      `Raw data:  ${path.relative(process.cwd(), jsonPath)}`,
      '',
      'Open report.md and paste it into the chat — that is enough to write real',
      'page objects with accurate locators and fallback chains.',
      '',
    ].join('\n'),
  );
}

main().catch((error: Error) => {
  log.error('Inspector failed', { error: error.message });
  process.exitCode = 1;
});
