#!/usr/bin/env node
/**
 * Review self-healing proposals (docs/phase-2-healing.md).
 *
 *   pnpm heal:review                       # reviews artifacts/reports/run.json
 *   pnpm heal:review --run <path>
 *
 * Shows each pending proposal with its full evidence, prints the EXACT diff
 * it would apply, and asks for explicit y/n confirmation — one proposal at a
 * time, no bulk approval. Refuses outright to touch any file with
 * uncommitted changes. This is deliberately the least automated part of the
 * whole design: it applies a source edit only after a human has looked at
 * the evidence and the diff and said yes to that specific one.
 */
/* eslint-disable no-console -- interactive review output for a human (diffs,
   indented evidence blocks) — rootLogger's timestamped/JSON-meta format
   (packages/shared/src/logger.ts) is for machine-consumable logs, not this. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import * as prettier from 'prettier';
import * as ts from 'typescript';
import { findRepoRoot, rootLogger, type HealingProposal, type LocatorCandidate, type Run } from '@aitp/shared';

const log = rootLogger.child('heal-review');
const repoRoot = findRepoRoot(__dirname);

function git(args: string[], cwd = repoRoot): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function findRunJson(): string {
  const flagIndex = process.argv.indexOf('--run');
  if (flagIndex !== -1 && process.argv[flagIndex + 1]) {
    return path.resolve(process.argv[flagIndex + 1]!);
  }
  return path.join(repoRoot, 'artifacts', 'reports', 'run.json');
}

/** Every page object file under tests/ — git's glob pathspec doesn't reliably
 * match nested `**` segments, so match on basename and filter in JS instead. */
function candidatePageObjectFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '--', '*.page.ts'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  return out ? out.split('\n').filter((f) => f.startsWith('tests/')) : [];
}

/**
 * Finds the file that defines `key` via `locator(key, ...)`, and the exact
 * character offset just before the closing `]` of that spec's candidates
 * array — not a regex/string search, a real AST parse, so a key string that
 * happens to also appear in a comment or a different call can't fool it.
 */
function locateInsertionPoint(
  key: string,
): { file: string; insertAt: number; source: string } | { error: string } {
  const files = candidatePageObjectFiles();
  const hits: { file: string; insertAt: number; source: string }[] = [];

  for (const relFile of files) {
    const absFile = path.join(repoRoot, relFile);
    const source = readFileSync(absFile, 'utf8');
    if (!source.includes(JSON.stringify(key)) && !source.includes(`'${key}'`)) continue;

    const sourceFile = ts.createSourceFile(absFile, source, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'locator' &&
        node.arguments.length >= 3
      ) {
        const [keyArg, , candidatesArg] = node.arguments;
        if (
          keyArg &&
          ts.isStringLiteralLike(keyArg) &&
          keyArg.text === key &&
          candidatesArg &&
          ts.isArrayLiteralExpression(candidatesArg)
        ) {
          hits.push({ file: absFile, insertAt: candidatesArg.end - 1, source });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  if (hits.length === 0) return { error: `no locator('${key}', ...) call found in any tests/**/pages/**/*.page.ts file` };
  if (hits.length > 1) {
    return {
      error: `key "${key}" defined in ${hits.length} files (${hits.map((h) => path.relative(repoRoot, h.file)).join(', ')}) — refusing to guess`,
    };
  }
  return hits[0]!;
}

function serializeCandidate(candidate: LocatorCandidate): string {
  const parts = [`strategy: ${JSON.stringify(candidate.strategy)}`, `value: ${JSON.stringify(candidate.value)}`];
  if (candidate.options) {
    const optsBody = Object.entries(candidate.options)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : String(v)}`)
      .join(', ');
    parts.push(`options: { ${optsBody} }`);
  }
  parts.push(`confidence: ${candidate.confidence ?? 0.6}`);
  const today = new Date().toISOString().slice(0, 10);
  return `    { ${parts.join(', ')} }, // healed ${today}, pending human-verified re-check\n  `;
}

function buildDiffPreview(source: string, insertAt: number, insertion: string): string {
  const before = source.slice(0, insertAt);
  const beforeLines = before.split('\n');
  const contextStart = Math.max(0, beforeLines.length - 4);
  const context = beforeLines.slice(contextStart).join('\n');
  const after = source.slice(insertAt).split('\n').slice(0, 2).join('\n');
  const addedLines = insertion
    .split('\n')
    .filter(Boolean)
    .map((l) => `+ ${l}`)
    .join('\n');
  return [context, addedLines, after].filter(Boolean).join('\n');
}

function hasUncommittedChanges(absFile: string): boolean {
  const relFile = path.relative(repoRoot, absFile);
  const status = git(['status', '--porcelain', '--', relFile]);
  return status.length > 0;
}

function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, (answer) => resolve(answer.trim().toLowerCase())));
}

async function reviewOne(
  proposal: HealingProposal,
  index: number,
  total: number,
  rl: readline.Interface,
): Promise<HealingProposal> {
  console.log(`\n[${index + 1}/${total}] ${proposal.key}  confidence ${proposal.confidence}`);
  console.log(`  Description: ${proposal.description}`);
  console.log(`  Existing candidates: ${proposal.existingCandidates.length}`);
  console.log(`  Rationale: ${proposal.rationale}`);
  console.log(`  Suggested candidate: ${JSON.stringify(proposal.candidate)}`);
  console.log(
    `  Verification (against captured accessibility snapshot, NOT a live browser check):` +
      `\n    matches: ${proposal.verification.matchCount}  role: ${proposal.verification.role}  ` +
      `name: ${JSON.stringify(proposal.verification.accessibleName)}  visible: ${proposal.verification.visible}  enabled: ${proposal.verification.enabled}`,
  );
  console.log(
    `  Check it yourself before approving — paste into a browser console on the failing page:\n` +
      `    document.querySelector('[role="${proposal.candidate.value}"]') // or use the app's own devtools role/name inspector`,
  );

  const located = locateInsertionPoint(proposal.key);
  if ('error' in located) {
    console.log(`  Cannot locate source file to edit: ${located.error}`);
    const answer = await ask(rl, `  [r]eject  [s]kip  [q]uit  > `);
    if (answer === 'q') throw new QuitSignal();
    if (answer === 'r') return { ...proposal, status: 'rejected' };
    return proposal;
  }

  const relFile = path.relative(repoRoot, located.file);
  if (hasUncommittedChanges(located.file)) {
    console.log(
      `  REFUSING: ${relFile} has uncommitted changes — commit or stash them before reviewing proposals against this file.\n` +
        `    e.g. git stash push -- ${relFile}   (then git stash pop once you're done reviewing)`,
    );
    const answer = await ask(rl, `  [s]kip  [q]uit  > `);
    if (answer === 'q') throw new QuitSignal();
    return proposal;
  }

  const insertion = serializeCandidate(proposal.candidate);
  console.log(`\n  Diff — ${relFile}:`);
  console.log(buildDiffPreview(located.source, located.insertAt, insertion));

  const answer = await ask(rl, `\n  [a]pprove  [r]eject  [s]kip  [q]uit  > `);
  if (answer === 'q') throw new QuitSignal();
  if (answer !== 'a') {
    return answer === 'r' ? { ...proposal, status: 'rejected' } : proposal;
  }

  const newSource = located.source.slice(0, located.insertAt) + insertion + located.source.slice(located.insertAt);
  writeFileSync(located.file, newSource, 'utf8');

  const typeError = typecheckProject();
  if (typeError) {
    console.log(`  Typecheck FAILED after applying this edit — rolling back.\n  ${typeError.slice(0, 1000)}`);
    writeFileSync(located.file, located.source, 'utf8');
    return { ...proposal, status: 'approved', appliedError: typeError };
  }

  // Cosmetic, after correctness: the insertion is spliced in at a byte
  // offset, so its indentation won't match the surrounding file's until
  // this runs. Never skips the typecheck above — formatting doesn't change
  // semantics, so there's nothing for a second typecheck to catch here.
  try {
    const formatted = await prettier.format(readFileSync(located.file, 'utf8'), {
      ...(await prettier.resolveConfig(located.file)),
      filepath: located.file,
    });
    writeFileSync(located.file, formatted, 'utf8');
  } catch (error) {
    log.warn('Formatting the edited file failed — leaving it unformatted, not rolling back', {
      file: relFile,
      error: (error as Error).message,
    });
  }

  console.log(`  Applied to ${relFile}, typecheck passed, formatted.`);
  return { ...proposal, status: 'approved', reviewedAt: new Date().toISOString() };
}

/**
 * In-process, not `execFileSync('npx', ['tsc', ...])` — `npx` is a `.cmd`
 * shim on Windows, and `execFileSync` doesn't resolve those without
 * `shell: true`, which trades one platform problem for cross-platform
 * argument-quoting ones. TypeScript is already a project dependency; using
 * its compiler API directly avoids spawning a process at all, on any OS.
 * Returns a formatted diagnostic string, or null if the project is clean.
 */
function typecheckProject(): string | null {
  const configPath = ts.findConfigFile(repoRoot, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) return 'tsconfig.json not found';
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath));
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length === 0) return null;
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => repoRoot,
    getNewLine: () => '\n',
  });
}

class QuitSignal extends Error {}

async function main(): Promise<void> {
  const runJsonPath = findRunJson();
  if (!existsSync(runJsonPath)) {
    log.error(`No run.json found at ${runJsonPath}. Run the suite first.`);
    process.exitCode = 1;
    return;
  }

  const run = JSON.parse(readFileSync(runJsonPath, 'utf8')) as Run;
  const proposals = run.healingProposals ?? [];
  const pending = proposals.filter((p) => p.status === 'pending');

  if (pending.length === 0) {
    log.info('No pending healing proposals.', { total: proposals.length });
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const reviewed: HealingProposal[] = [];
  try {
    for (const [index, proposal] of pending.entries()) {
      reviewed.push(await reviewOne(proposal, index, pending.length, rl));
    }
  } catch (error) {
    if (!(error instanceof QuitSignal)) throw error;
    console.log('\nQuitting — unreviewed proposals stay pending.');
  } finally {
    rl.close();
  }

  const byId = new Map(reviewed.map((p) => [p.id, p]));
  run.healingProposals = proposals.map((p) => byId.get(p.id) ?? p);
  writeFileSync(runJsonPath, JSON.stringify(run, null, 2), 'utf8');

  const approved = reviewed.filter((p) => p.status === 'approved' && !p.appliedError).length;
  const failed = reviewed.filter((p) => p.appliedError).length;
  const rejected = reviewed.filter((p) => p.status === 'rejected').length;
  // Skipped (dirty file, unresolvable key, or "s" at the prompt) and
  // never-reached (quit early) both come back with status still 'pending' —
  // count those directly rather than by "was it iterated", which "skip"
  // satisfies without actually resolving anything.
  const stillPending = run.healingProposals.filter((p) => p.status === 'pending').length;
  log.info('Review complete', { approved, failed, rejected, stillPending });
}

main().catch((error: Error) => {
  log.error('Review failed', { error: error.message });
  process.exitCode = 1;
});
