import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { TestOutcome, type Run, type TestResult } from '@aitp/shared';

/**
 * ENOUGH OF EACH RUN TO COMPARE THE NEXT ONE AGAINST IT.
 *
 * ## Why a store of its own
 *
 * "The previous run of this application on this machine" has no existing source.
 * `artifacts/reports/run.json` is only ever the CURRENT run — the next one
 * overwrites it — and `artifacts/runs/<id>/` is written ONLY when a run had failures
 * or flakes, by design, because its purpose is preserving evidence of rare
 * failures. So a comparison built on either would answer "what changed" with
 * "nothing, there is no previous run" after every green run, which is the most
 * misleading moment to say it: a suite that went green is exactly when somebody
 * wants to know what got fixed.
 *
 * This writes one small record per run, per application, holding the outcome of each
 * test and nothing else. No error text, no context, no attachment paths — a
 * comparison needs identity and verdict, and anything more is a second copy of
 * evidence that already lives in `run.json`.
 *
 * ## Bounded, because it is written on every run forever
 *
 * `KEEP` newest records survive; older ones are deleted as each new one is written.
 * An unbounded directory under `artifacts/` would grow by one file per run with
 * nothing ever reading past the newest, and the first person to notice would be
 * whoever ran out of inodes.
 */

/** How many records to keep per application. One is enough to compare; more is for a human looking. */
export const KEEP_RUN_RECORDS = 20;

export interface RunRecord {
  runId: string;
  application: string;
  environment: string;
  /** ISO. The ordering key — a directory listing's mtime is not a fact about the run. */
  finishedAt: string;
  status: string;
  /** One entry per distinct test: its stable id, its title, and how it ended. */
  outcomes: Array<{ id: string; title: string; outcome: TestOutcome }>;
}

export function runHistoryDir(root: string, application: string): string {
  return path.join(root, 'artifacts', application, 'notify', 'runs');
}

/**
 * A run's identity-and-verdict record, from the FINAL attempt of each test.
 *
 * `finalAttemptPerTest` is not reachable from here without a circular import, so the
 * collapse is done by the same rule it uses — highest `retry` wins — and that rule is
 * the one thing this and the summary must agree on. A retried test fires once per
 * attempt, so without the collapse a test that failed then passed would appear twice
 * and be both `fixed` and `still failing` in the next comparison.
 */
export function describeRunForHistory(
  run: Run,
  application: string,
  environment: string,
): RunRecord {
  const byId = new Map<string, TestResult>();
  for (const result of run.results) {
    const existing = byId.get(result.id);
    if (!existing || result.retry > existing.retry) byId.set(result.id, result);
  }
  return {
    runId: run.id,
    application,
    environment,
    finishedAt: run.finishedAt ?? run.createdAt,
    status: run.status,
    outcomes: [...byId.values()].map((result) => ({
      id: result.id,
      title: result.title,
      outcome: result.outcome,
    })),
  };
}

/** Writes the record atomically, then prunes to `KEEP_RUN_RECORDS`. */
export function recordRun(dir: string, record: RunRecord): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${record.runId}.json`);
  const contents = `${JSON.stringify(record, null, 2)}\n`;
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, contents, 'utf8');
  renameSync(temporary, file);

  // Pruned by the record's OWN finishedAt, never by mtime: a file copied or restored
  // has a new mtime and an unchanged run, and pruning the wrong one is silent.
  const records = readRunRecords(dir);
  for (const stale of records.slice(KEEP_RUN_RECORDS)) {
    try {
      unlinkSync(path.join(dir, `${stale.runId}.json`));
    } catch {
      // A record that cannot be deleted is not worth failing a run over; the next
      // run tries again. Growth is bounded by intent, not by this call succeeding.
    }
  }
  return file;
}

/** Every readable record, NEWEST FIRST. An unreadable one is skipped, not fatal. */
export function readRunRecords(dir: string): RunRecord[] {
  if (!existsSync(dir)) return [];
  const records: RunRecord[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, entry), 'utf8')) as RunRecord;
      // A record with no id or no outcomes array cannot be compared against, and a
      // half-written one would otherwise become the "previous run" and report every
      // test as new.
      if (typeof parsed.runId !== 'string' || !Array.isArray(parsed.outcomes)) continue;
      records.push(parsed);
    } catch {
      continue;
    }
  }
  return records.sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : -1));
}

/**
 * The newest record that FINISHED BEFORE this run, or `null`.
 *
 * ## Two things it must do, and the first draft only did one
 *
 * Excluding the current run by id matters because the record is written BEFORE the
 * body is rendered: without it, every run would be compared against itself and
 * report "no change", forever — a result that looks entirely plausible.
 *
 * But "the newest record that is not me" is NOT "the previous run", and the first
 * draft returned exactly that. Asked about an older run it handed back a LATER one,
 * so a comparison would report a fix as a regression and a regression as a fix,
 * with both lists confidently populated. It happened to be right only because the
 * caller is always the newest run — a correctness that depends on a caller's habit
 * is the kind this repo keeps finding broken later.
 *
 * So the current run's own `finishedAt` is required, and the answer is bounded by
 * it. Ties go to neither: a record with the SAME timestamp is not before this one.
 */
export function previousRunRecord(
  dir: string,
  current: Pick<RunRecord, 'runId' | 'finishedAt'>,
): RunRecord | null {
  return (
    readRunRecords(dir).find(
      (record) => record.runId !== current.runId && record.finishedAt < current.finishedAt,
    ) ?? null
  );
}

export interface ComparedTest {
  id: string;
  title: string;
}

export interface RunComparison {
  previousRunId: string;
  previousFinishedAt: string;
  /** Failing now, passing before. The list somebody has to act on. */
  newFailures: ComparedTest[];
  /** Passing now, failing before. The list worth saying out loud. */
  fixed: ComparedTest[];
  /** Failing in both. Known, and not news — which is why it is its own list. */
  stillFailing: ComparedTest[];
  /** In this run and not the previous one: neither new nor fixed, just new to the suite. */
  added: ComparedTest[];
  /** In the previous run and not this one: deleted, renamed, or filtered out. */
  removed: ComparedTest[];
}

/** Did this outcome count as a failure? Flaky did NOT — it ended up passing. */
const isFailure = (outcome: TestOutcome): boolean =>
  outcome === TestOutcome.Failed || outcome === TestOutcome.TimedOut;

/**
 * What changed between two runs.
 *
 * ## `added` and `removed` are separate from `newFailures` and `fixed`
 *
 * A test present in one run and absent from the other cannot be compared, and
 * folding it into either list makes a confident wrong claim: a newly written failing
 * test reported as a "new failure" tells a reader something REGRESSED, and a deleted
 * failing test reported as "fixed" tells them it was repaired. Both are the shape
 * this repo keeps refusing — a mechanism answering a question it cannot know.
 *
 * ## Matched on the test ID, not the title
 *
 * A renamed test is `removed` plus `added`, which is honest: nothing here can tell a
 * rename from a deletion-and-creation, and guessing by title similarity would report
 * a rename as a fix whenever the old one was failing.
 */
export function compareRuns(previous: RunRecord, current: RunRecord): RunComparison {
  const before = new Map(previous.outcomes.map((entry) => [entry.id, entry]));
  const after = new Map(current.outcomes.map((entry) => [entry.id, entry]));

  const newFailures: ComparedTest[] = [];
  const fixed: ComparedTest[] = [];
  const stillFailing: ComparedTest[] = [];
  const added: ComparedTest[] = [];
  const removed: ComparedTest[] = [];

  for (const [id, now] of after) {
    const then = before.get(id);
    const entry: ComparedTest = { id, title: now.title };
    if (!then) {
      added.push(entry);
      continue;
    }
    const failsNow = isFailure(now.outcome);
    const failedThen = isFailure(then.outcome);
    if (failsNow && !failedThen) newFailures.push(entry);
    else if (!failsNow && failedThen) fixed.push(entry);
    else if (failsNow && failedThen) stillFailing.push(entry);
  }
  for (const [id, then] of before) {
    if (!after.has(id)) removed.push({ id, title: then.title });
  }

  const byTitle = (a: ComparedTest, b: ComparedTest): number => a.title.localeCompare(b.title);
  return {
    previousRunId: previous.runId,
    previousFinishedAt: previous.finishedAt,
    newFailures: newFailures.sort(byTitle),
    fixed: fixed.sort(byTitle),
    stillFailing: stillFailing.sort(byTitle),
    added: added.sort(byTitle),
    removed: removed.sort(byTitle),
  };
}
