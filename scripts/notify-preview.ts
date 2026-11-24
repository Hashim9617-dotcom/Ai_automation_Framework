/**
 * SEE THE MAIL WITHOUT SENDING ONE.
 *
 *   pnpm notify:preview --app ecom --run artifacts/runs/run_9cd0f8b6690b45b1
 *   pnpm notify:preview --app ecom --run artifacts/reports --out /tmp/preview
 *
 * ## Why this exists
 *
 * The body is built for Outlook's Word rendering engine, which is a different
 * renderer from any browser — so the only way to know what a change looks like is to
 * look at it. Before this, looking meant configuring a real folder, running a real
 * suite and sending a real mail to real people, which is far too much machinery to
 * put behind "is the module table too wide?".
 *
 * ## It writes two files and NOTHING else
 *
 * `preview.html` and `preview.txt`, from an existing `run.json`. No ready file, no
 * zip, no drop folder, no recipients resolved, no history recorded. The point is that
 * running it cannot mail anybody — not "is unlikely to", cannot: `notifyRun` is never
 * called and the only thing written is the two files it names.
 *
 * ## It reads the run it is given, and REFUSES otherwise
 *
 * A directory with no `run.json` is refused by name rather than previewing an empty
 * run — a preview of nothing looks like a working mail about a suite that found
 * nothing, which is the most misleading artifact this could produce.
 *
 * `--app` is required and is NOT inferred from the run record: `run.target` carries
 * one, but a preview is often of somebody else's archived run and the application
 * decides which notify settings apply. Asking is cheaper than a wrong answer.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  loadNotifyConfig,
  notifyConfigOverride,
  notifyTrigger,
  renderReportEmailHtml,
  renderReportEmailText,
  subjectFor,
  verdictOf,
} from '@aitp/reporting-engine';
import { findRepoRoot, rootLogger, type Run } from '@aitp/shared';

const log = rootLogger.child('notify-preview');

const USAGE = [
  'usage: pnpm notify:preview --app <slug> --run <dir-with-run.json> [--out <dir>]',
  '',
  '  --app   the application slug, as `pnpm notify:setup` knows it. Not inferred from',
  '          the run: a preview is often of an archived run, and the application',
  '          decides which notify settings apply.',
  '  --run   a directory containing run.json — artifacts/reports, or any',
  '          artifacts/runs/<runId>/reports.',
  '  --out   where to write preview.html and preview.txt. Defaults to --run.',
].join('\n');

function valueOf(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) return undefined;
  return value;
}

function main(): void {
  const application = valueOf('--app');
  const runArg = valueOf('--run');
  if (!application || !runArg) {
    throw new Error(`${USAGE}\n\n  --app and --run are both required.`);
  }

  const runDir = path.resolve(runArg);
  if (!existsSync(runDir) || !statSync(runDir).isDirectory()) {
    throw new Error(`${USAGE}\n\n  --run is "${runDir}", which is not a directory.`);
  }

  /**
   * `run.json` HERE, or one level down in `reports/`.
   *
   * An archive is `artifacts/runs/<runId>/{reports,test-results}`, so the directory
   * somebody naturally passes is the archive root and the record is one level in.
   * Both are accepted and the one that was USED is printed, because a preview of the
   * wrong run is indistinguishable from a preview of the right one.
   */
  const candidates = [path.join(runDir, 'run.json'), path.join(runDir, 'reports', 'run.json')];
  const runFile = candidates.find((file) => existsSync(file));
  if (!runFile) {
    throw new Error(
      `${USAGE}\n\n  no run.json in "${runDir}" or its reports/ subdirectory. A preview of an ` +
        'empty run looks like a working mail about a suite that found nothing, so this ' +
        'refuses rather than rendering one.',
    );
  }

  let run: Run;
  try {
    run = JSON.parse(readFileSync(runFile, 'utf8')) as Run;
  } catch (error) {
    // A BROKEN record is not a missing one, and the two want different fixes.
    throw new Error(
      `${runFile} could not be read as JSON: ${(error as Error).message}. That is a broken run ` +
        'record, not a missing one.',
    );
  }
  if (!run.id || !run.results) {
    throw new Error(
      `${runFile} parsed but carries no id or results, so it is not a run record. Check the path.`,
    );
  }

  const root = findRepoRoot();
  /**
   * The application's notify settings, when it has any — and sensible stand-ins when
   * it does not.
   *
   * A preview must work on a machine where nothing is configured, because "what will
   * the mail look like" is a question somebody asks BEFORE setting notification up.
   * The stand-ins are obviously fake (`preview@example.invalid`) so a screenshot of a
   * preview cannot be mistaken for a record of something that was sent.
   */
  const config = loadNotifyConfig(notifyConfigOverride(process.env) ?? root);
  const app = config?.apps[application];
  const ranBy = app?.ranBy ?? 'preview@example.invalid';
  const includeScreenshots = app?.includeScreenshots ?? false;
  if (!app) {
    log.info('notify: no configuration for this application — previewing with stand-in values', {
      application,
      ranBy,
    });
  }

  const input = {
    run,
    application,
    environment: run.target?.environment ?? run.request?.environment ?? 'unknown',
    baseUrl: run.target?.baseUrl ?? '',
    ranBy,
    comparison: null,
    trigger: notifyTrigger(process.env),
    includeScreenshots,
  };

  const outDir = path.resolve(valueOf('--out') ?? runDir);
  mkdirSync(outDir, { recursive: true });
  const htmlPath = path.join(outDir, 'preview.html');
  const textPath = path.join(outDir, 'preview.txt');
  writeFileSync(htmlPath, renderReportEmailHtml(input), 'utf8');
  writeFileSync(textPath, renderReportEmailText(input), 'utf8');

  /**
   * ASSERTS ITS OWN EFFECT before reporting success.
   *
   * Both files are read back and required to be non-trivial. A preview command that
   * printed two paths and wrote nothing — or wrote an empty document — is this repo's
   * oldest failure mode, and the person running it would open a blank page and
   * conclude the body renderer is broken.
   */
  for (const file of [htmlPath, textPath]) {
    const written = readFileSync(file, 'utf8');
    if (written.length < 200) {
      throw new Error(
        `wrote ${file} but it reads back ${written.length} bytes, which cannot be a report — ` +
          'refusing to report success.',
      );
    }
  }

  const summary = run.summary;
  process.stdout.write(
    [
      '',
      `notify: preview written for "${application}" — NOTHING WAS SENT`,
      `  read from   : ${runFile}`,
      `  subject     : ${subjectFor({
        app: application,
        environment: input.environment,
        verdict: verdictOf(run),
        passed: summary?.passed ?? 0,
        total: summary?.total ?? 0,
        startedAt: run.startedAt ?? run.createdAt,
      })}`,
      `  html        : ${htmlPath}`,
      `  text        : ${textPath}`,
      `  screenshots : ${includeScreenshots ? 'included for this application' : 'not included'}`,
      '',
      '  Open the html in Outlook to see what a recipient sees — a browser is a',
      '  different renderer and will flatter it.',
      '',
    ].join('\n'),
  );
}

try {
  main();
} catch (error) {
  // A refusal reads as a refusal, not as a crash — the same entry-point shape the
  // other scripts here use.
  process.stderr.write(`\n${(error as Error).message}\n\n`);
  process.exit(1);
}
