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
 *   - pages.json  the raw DomSnapshot per page, for tooling
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
import { chromium, type Browser } from '@playwright/test';
import { authStatePath, captureDomSnapshot, loadEnvironment } from '@aitp/execution-engine';
import { findRepoRoot, rootLogger, slugify, type DomSnapshot } from '@aitp/shared';

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

function renderPage(snapshot: DomSnapshot, label: string): string {
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

  return [
    `### ${label}`,
    '',
    `- URL: \`${snapshot.url}\``,
    `- Title: ${snapshot.title}`,
    `- Interactive elements: ${snapshot.elements.length}`,
    `- With a \`data-testid\`: ${withTestId} (${coverage}%)`,
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
  const captured: Array<{ label: string; snapshot: DomSnapshot }> = [];

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
        const snapshot = await captureDomSnapshot(page, { maxElements: 400 });
        captured.push({ label, snapshot });
        process.stdout.write(
          `  captured "${label}" — ${snapshot.elements.length} elements at ${snapshot.url}\n\n`,
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
    ...captured.map((entry, index) => renderPage(entry.snapshot, `${index + 1}. ${entry.label}`)),
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
