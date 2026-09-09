import type { AuthoredRow } from './final-test-cases';
import { extractTarget } from './resolve-authored';

/**
 * Sheet triage: which rows can NEVER be automated, and why.
 *
 * **This is a deliverable, not a diagnostic.** A QA sheet written for humans
 * legitimately contains things only a human can check — *"the ui should show a
 * colour change proper response and animations"* is not automatable by anyone
 * and never will be. So the report's value is not only the rows it runs. It is
 * also telling the QA, row by row and with a reason, what will never run.
 *
 * The realistic ceiling for automated execution of a real sheet is well under
 * 100%, and that number belongs somewhere it stays current — recomputed from
 * the sheet on every run — rather than in a summary someone wrote once.
 *
 * **Three reasons, three different actions for a human.** They are kept apart
 * for the same reason `failed` and `refused` are (§9.3): merged, the section is
 * useless to everyone, because no single person can act on the merged list.
 */
export type TriageReason =
  /** Nobody has captured this screen. Someone runs `pnpm inspect` on it. */
  | 'no-capture-for-module'
  /** Describes a page, URL or state outcome. Needs a page/state assertion. */
  | 'outcome-not-element'
  /** Too vague for anything to verify. The ROW needs rewriting — QA work. */
  | 'too-vague-to-verify'
  /** Nothing stands in the way. */
  | 'automatable';

export interface TriagedRow {
  rowId: string;
  sheetRow: number;
  module: string;
  title: string;
  reason: TriageReason;
  /** The clause that decided it, verbatim, so the QA can see what we read. */
  evidence: string;
}

export interface TriageResult {
  rows: TriagedRow[];
  counts: Record<TriageReason, number>;
  /** Rows with nothing structural in the way, as a share of all rows read. */
  ceiling: number;
  /** Modules with no capture, worst first — the `pnpm inspect` worklist. */
  missingCaptures: Array<{ module: string; rows: number }>;
}

/**
 * A clause that describes an OUTCOME rather than pointing at an element.
 *
 * Deliberately narrow. Every pattern here is a shape measured in the real
 * sheet, and a clause that merely fails to parse is NOT assumed to be one of
 * these — it falls to `too-vague-to-verify`, which asks a human to look.
 */
const OUTCOME_SHAPE = [
  /\b(?:user|users)\s+(?:is|are)?\s*(?:on|in|at|viewing)\b/i,
  /\b(?:navigat\w+|redirect\w*|land(?:s|ed|ing)?)\s+(?:to|on)\b/i,
  /\b(?:logged\s+in|logged\s+out|signed\s+in|signed\s+out)\b/i,
  /\b(?:page|screen|portal|dashboard|url)\b.*\b(?:appear|open|load|display|show)\w*\b/i,
  /\b(?:persist|remains?|retained|restored|saved)\b/i,
  /\b(?:api|backend|database|server)\b/i,
  // A STATE CHANGE is an outcome, not an element. Generic English verbs only —
  // naming the things they act on would put this application's vocabulary into
  // shared code, which the agnostic guard exists to stop.
  /\b(?:created|deleted|removed|moved|updated|added|changed|renamed|uploaded|downloaded|archived|reset)\b/i,
  /\bsuccessfully\b/i,
];

/** Prose with no verifiable claim in it at all. */
const VAGUE_SHAPE = [
  /\b(?:proper|properly|correct|correctly|clean|smooth|good|fine|nice)\b/i,
  /\b(?:everything|anything|all the (?:ui|things|data))\b/i,
  /\b(?:animation|allignment|alignment|look and feel|responsive)\w*\b/i,
];

const matches = (patterns: RegExp[], text: string): boolean =>
  patterns.some((pattern) => pattern.test(text));

/**
 * Classifies every row by what stands between it and automation.
 *
 * Order matters and is deliberate — each reason is checked against the action a
 * human would take, cheapest and most certain first:
 *
 * 1. **No capture** beats everything. It is a fact about US, not the row, and
 *    it is the one reason that is *definitely* fixable — someone captures the
 *    screen. Judging a row's clauses before we have ever looked at its screen
 *    would blame the author for our own missing evidence.
 * 2. **Outcome, not element.** Buildable: a page/state assertion path.
 * 3. **Too vague.** Only what survives both — the row itself needs rewriting.
 */
export function triageSheet(
  rows: AuthoredRow[],
  capturedModules: ReadonlySet<string>,
): TriageResult {
  const triaged: TriagedRow[] = [];
  const missing = new Map<string, number>();

  for (const row of rows) {
    const module = row.module || '(blank)';
    // Given clauses declare the entry state; they are never an obstacle to
    // automating the row, so they are not evidence for or against it (§13.3).
    const clauses = row.clauses.filter((clause) => clause.source !== 'given');
    const title = row.scenarioName || row.objective || row.rowId;
    const base = { rowId: row.rowId, sheetRow: row.sheetRow, module, title };

    if (!capturedModules.has(module)) {
      missing.set(module, (missing.get(module) ?? 0) + 1);
      triaged.push({
        ...base,
        reason: 'no-capture-for-module',
        evidence: `no capture exists for "${module}" — run \`pnpm inspect\` on that screen`,
      });
      continue;
    }

    // AUTOMATABLE NEEDS A VERIFIABLE ASSERTION, not just a clickable step.
    //
    // "any clause resolves" is too lenient and flatters the ceiling: a row
    // whose When resolves but whose Then is prose can be PERFORMED and cannot
    // be VERIFIED. Running it proves nothing, and the platform already refuses
    // exactly that at execution (`no-observable-check`). Counting it as
    // automatable here would promise a row the run then refuses.
    const asserts = clauses.filter((clause) => clause.kind === 'assert');

    // MEANING IS DECIDED BEFORE RESOLVABILITY, and the order is the whole
    // point. `extractTarget` will happily slice "record" out of *"the record
    // should be created successfully"* and "ui" out of *"the ui should show a
    // colour change"*. Both look like names and neither is one — asking "does
    // it resolve?" first therefore classifies an outcome as automatable, which
    // is (b) wearing a target's clothes (§13.4).
    //
    // A row is automatable only on the strength of an assertion that is BOTH
    // resolvable AND a claim about an element — one genuinely checkable Then.
    const checkable = asserts.find(
      (clause) =>
        extractTarget(clause.text) !== undefined &&
        !matches(OUTCOME_SHAPE, clause.text) &&
        !matches(VAGUE_SHAPE, clause.text),
    );
    const actionable = clauses.find((clause) => extractTarget(clause.text) !== undefined);

    if (checkable && actionable) {
      triaged.push({ ...base, reason: 'automatable', evidence: checkable.text });
      continue;
    }

    // An unverifiable Then is what stops the row, whatever its When could do,
    // so the assertions are what get classified.
    const blocking = asserts.length > 0 ? asserts : clauses;

    const vague = blocking.find((clause) => matches(VAGUE_SHAPE, clause.text));
    if (vague) {
      triaged.push({ ...base, reason: 'too-vague-to-verify', evidence: vague.text });
      continue;
    }

    const outcome = blocking.find((clause) => matches(OUTCOME_SHAPE, clause.text));
    if (outcome) {
      triaged.push({ ...base, reason: 'outcome-not-element', evidence: outcome.text });
      continue;
    }

    triaged.push({
      ...base,
      reason: 'too-vague-to-verify',
      evidence: blocking[0]?.text ?? clauses[0]?.text ?? '(no clauses)',
    });
  }

  const counts: Record<TriageReason, number> = {
    'no-capture-for-module': 0,
    'outcome-not-element': 0,
    'too-vague-to-verify': 0,
    automatable: 0,
  };
  for (const row of triaged) counts[row.reason] += 1;

  return {
    rows: triaged,
    counts,
    ceiling: triaged.length === 0 ? 0 : counts.automatable / triaged.length,
    missingCaptures: [...missing]
      .map(([module, rows]) => ({ module, rows }))
      .sort((a, b) => b.rows - a.rows),
  };
}

/** The triage as a report section. Three reasons, three audiences, never merged. */
export function renderTriage(triage: TriageResult): string {
  const { counts, ceiling } = triage;
  const pct = (n: number) => `${((n / triage.rows.length) * 100).toFixed(1)}%`;

  const lines = [
    '## What this sheet can and cannot automate',
    '',
    `**Realistic ceiling: ${(ceiling * 100).toFixed(1)}%** — ${counts.automatable} of ` +
      `${triage.rows.length} rows have nothing structural standing in the way.`,
    '',
    '> This is not a failure. A sheet written for humans legitimately contains',
    '> things only a human can check. Knowing which, and why, is the point.',
    '',
    '| Rows | Why | What a human does |',
    '| ---: | --- | --- |',
    `| ${counts.automatable} (${pct(counts.automatable)}) | nothing in the way | these are the rows a run executes |`,
    `| ${counts['no-capture-for-module']} (${pct(counts['no-capture-for-module'])}) | no capture for this module | run \`pnpm inspect\` on that screen |`,
    `| ${counts['outcome-not-element']} (${pct(counts['outcome-not-element'])}) | describes an outcome, not an element | needs a page/state assertion — buildable, not built |`,
    `| ${counts['too-vague-to-verify']} (${pct(counts['too-vague-to-verify'])}) | too vague for anything to verify | the row needs rewriting — QA work |`,
    '',
  ];

  if (triage.missingCaptures.length > 0) {
    lines.push(
      '### Capture worklist',
      '',
      'No resolver can do anything with these until someone captures the screen.',
      '',
      ...triage.missingCaptures.map((m) => `- **${m.module}** — ${m.rows} row(s)`),
      '',
    );
  }

  const sample = (reason: TriageReason, heading: string, action: string): void => {
    const rows = triage.rows.filter((r) => r.reason === reason);
    if (rows.length === 0) return;
    lines.push(`### ${heading} (${rows.length})`, '', action, '');
    for (const row of rows.slice(0, 15)) {
      lines.push(`- **${row.rowId}** _(sheet row ${row.sheetRow})_ — ${row.title}`);
      lines.push(`  > ${row.evidence.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
    if (rows.length > 15) lines.push(`- …and ${rows.length - 15} more`);
    lines.push('');
  };

  sample(
    'outcome-not-element',
    'Describes an outcome, not an element',
    'These name a page, a URL or a state rather than a control. They are automatable once page-level and state-level assertions exist — the work is ours, not the QA’s.',
  );
  sample(
    'too-vague-to-verify',
    'Too vague to verify',
    'Nothing here states a checkable claim, so no tool can confirm or deny it. **The row itself needs rewriting**, and only its author can do that.',
  );

  return lines.join('\n');
}
