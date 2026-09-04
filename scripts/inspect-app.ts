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
  crossCheckTransition,
  diffAxTrees,
  findNameDivergences,
  loadEnvironment,
  pruneDirectories,
  signatureSimilarity,
  stateSignature,
  suggestActions,
  type NameDivergence,
} from '@aitp/execution-engine';
import {
  findRepoRoot,
  rootLogger,
  slugify,
  type AccessibilityNode,
  type AccessibilityTreeSnapshot,
  type DeclaredTransition,
  type DomSnapshot,
} from '@aitp/shared';

/**
 * Proposes a state label from the page's own route and heading, so the common
 * case is one keystroke (Enter) instead of typing a name. Only ever a
 * proposal: identity is the human's, because "same state" is a question about
 * the application's model that no fingerprint can answer.
 */
function proposeLabel(url: string, nodes: AccessibilityNode[]): string {
  const route =
    new URL(url).pathname.split('/').filter(Boolean).join('.').replace(/[^a-z0-9.-]/gi, '') ||
    'root';
  const heading = nodes.find((node) => node.role === 'heading' && node.name)?.name;
  return heading ? `${route}.${slugify(heading)}` : route;
}

const log = rootLogger.child('inspect');

/**
 * How many capture sessions to keep. No age limit — see the note at the
 * prune call for why provenance is retained differently from diagnostics.
 */
const MAX_CAPTURES = 20;

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

  // One timestamped directory per capture session, never overwritten.
  //
  // This used to write straight into artifacts/inspect/, so every run
  // destroyed the previous one. That is how the original 24-page inventory —
  // the ground truth the entire 45-test suite was built from — was lost: it
  // was silently replaced by a single-page capture, and the app's data has
  // moved on since, so it cannot be reproduced.
  const inspectRoot = path.join(findRepoRoot(__dirname), 'artifacts', 'inspect');
  const outDir = path.join(inspectRoot, new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(outDir, { recursive: true });

  const headless = process.env.INSPECT_HEADLESS === 'true';
  let browser: Browser | undefined;
  const captured: Array<{
    label: string;
    snapshot: DomSnapshot;
    axTree: AccessibilityTreeSnapshot;
    signature: string;
  }> = [];
  const transitions: DeclaredTransition[] = [];

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
      const answer = await ask(
        captured.length === 0
          ? 'State name (or q to finish): '
          : 'Press Enter to capture the current state, or q to finish: ',
      );
      if (answer.toLowerCase() === 'q' || answer.toLowerCase() === 'quit') break;

      try {
        await waitForPageToRender(page);
        const snapshot = await captureDomSnapshot(page, { maxElements: 400 });
        // Captured together, from the same page state, so the two views are
        // directly comparable — a divergence report built from captures taken
        // at different moments would be reporting navigation, not naming.
        const axTree = await captureAccessibilityTree(page, { maxNodes: 1_000 });

        const previous = captured[captured.length - 1];
        const delta = previous ? diffAxTrees(previous.axTree.nodes, axTree.nodes) : undefined;

        // A state's identity is a human label. The tool proposes one from the
        // page's own heading and route, but never assigns it silently.
        const proposed = proposeLabel(snapshot.url, axTree.nodes);
        const label =
          captured.length === 0 && answer
            ? answer
            : (await ask(`  label? [${proposed}] `)) || proposed;

        // Signature check — raises a question, never makes a decision. Fires
        // when a label is reused for something structurally different, or a
        // new label looks like a state already captured. Both directions of a
        // misclassification land here as noise, never as a silent wrong fact.
        const signature = stateSignature(axTree.nodes);
        for (const other of captured) {
          const similarity = signatureSimilarity(signature, other.signature);
          if (other.label === label && similarity < 0.5) {
            process.stdout.write(
              `  ? "${label}" was captured before but looks structurally different now (${Math.round(similarity * 100)}% shared). Same state?\n`,
            );
          } else if (other.label !== label && similarity > 0.95) {
            process.stdout.write(
              `  ? this looks almost identical to "${other.label}" (${Math.round(similarity * 100)}% shared). Same state?\n`,
            );
          }
        }

        // Transition — declared by the human, cross-checked by the tool, both
        // in this same prompt cycle while the browser is still on the page.
        // Surfacing a suspect declaration in a report the next morning would
        // be surfacing it to someone who can no longer check it.
        if (previous && delta) {
          const suggestions = suggestActions(previous.axTree.nodes, delta);
          process.stdout.write(
            `  You went from "${previous.label}" to "${label}". What did you do?\n`,
          );
          suggestions.forEach((s, i) => process.stdout.write(`    ${i + 1}) ${s}\n`));
          process.stdout.write(`    ${suggestions.length + 1}) something else\n`);
          const pick = await ask('  > ');
          const index = Number.parseInt(pick, 10);
          const action =
            Number.isInteger(index) && index >= 1 && index <= suggestions.length
              ? suggestions[index - 1]!
              : await ask('  describe it: ');

          if (action) {
            const check = crossCheckTransition(action, previous.axTree.nodes, delta);
            transitions.push({
              from: slugify(previous.label),
              to: slugify(label),
              action,
              verdict: check.verdict,
            });
            if (check.verdict === 'consistent') {
              process.stdout.write(
                `  ok consistent: ${delta.added.length} added, ${delta.removed.length} removed, ${delta.stateChanged.length} changed state\n`,
              );
            } else {
              process.stdout.write('  SUSPECT — this declaration does not match what changed:\n');
              for (const reason of check.reasons) process.stdout.write(`    - ${reason}\n`);
              process.stdout.write(
                '  Recorded anyway, but marked suspect: it can raise a question, never ground an assertion.\n',
              );
            }
          }
        }

        captured.push({ label, snapshot, axTree, signature });

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
            // Captures are provenance now, so one labelled "dashboard" that is
            // actually the login screen is a durable artifact that misleads.
            (reuseSession && /\/login(\b|$)/.test(snapshot.url)
              ? `  WARNING: captured the login page, not "${label}" — the saved session has expired.\n` +
                '  Run `pnpm auth` (or the setup project) and capture again.\n'
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
  const jsonPath = path.join(outDir, 'capture.json');
  writeFileSync(reportPath, report, 'utf8');
  // State-keyed throughout, and deliberately offering NO flattened,
  // all-states node list: a grounding check cannot match against the wrong
  // state's nodes because it cannot reach them without naming a state first.
  // That is what makes checkGrounding()'s state cursor enforceable rather
  // than merely intended (docs/phase-2-generation.md, P2).
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        sessionId: path.basename(outDir),
        capturedAt: new Date().toISOString(),
        states: captured.map((entry) => ({
          id: slugify(entry.label),
          label: entry.label,
          url: entry.snapshot.url,
          signature: entry.signature,
          truncated: entry.axTree.truncated,
          nodes: entry.axTree.nodes,
          // Kept as its own key rather than merged into the AX nodes: these
          // are two views of the same page that disagree, and flattening them
          // would destroy exactly the signal this capture exists to preserve.
          // Grounding reads ONLY `nodes` — see P1.
          domSnapshot: entry.snapshot,
          nameDivergences: findNameDivergences(entry.snapshot, entry.axTree),
        })),
        transitions,
      },
      null,
      2,
    ),
    'utf8',
  );

  // Count-capped, but deliberately NOT aged out, unlike failure archives
  // (tests/support/global-setup.ts). Those are diagnostics: once a failure is
  // understood its trace is worthless, and 14-day expiry bounds the disk they
  // take. A capture is the opposite — it is provenance, it is what a locator
  // was written against, and an old one is MORE valuable than a new one for
  // answering "why does this say ABCD". Ageing these out would recreate
  // exactly the loss this retention exists to prevent. They are also tiny
  // (tens of KB per page against tens of MB per trace), so keeping a deep
  // history costs nothing worth counting.
  const { pruned, retained } = pruneDirectories(inspectRoot, { keep: MAX_CAPTURES });

  process.stdout.write(
    [
      '',
      `Report:    ${path.relative(process.cwd(), reportPath)}`,
      `Raw data:  ${path.relative(process.cwd(), jsonPath)}`,
      '',
      `Kept ${retained} capture(s) under artifacts/inspect/` +
        (pruned.length > 0 ? `; pruned ${pruned.length} beyond the newest ${MAX_CAPTURES}` : '') +
        '.',
      'Captures are gitignored and stay on this machine: they contain real',
      'workspace names, document titles and user names from a live system.',
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
