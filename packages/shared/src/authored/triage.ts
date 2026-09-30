import { actionCapability, columnVerbConflict, type AuthoredRow } from './final-test-cases';
import { extractRole } from './resolver';
import { extractTarget, unsupportedQualifier, unverifiableAssertion } from './resolve-authored';
import { assessAuthoredWriteRisk } from './write-risk';

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
  /**
   * The clause names an action the platform cannot perform — file upload.
   *
   * Nobody's mistake but ours. The sentence is correct, the screen is captured,
   * and the row would run the moment the capability exists. Kept apart from the
   * other three for the reason this union exists: each names a different person
   * who can act, and putting our gap in the QA's worklist wastes their time on a
   * row we could not run even after they rewrote it.
   */
  | 'unsupported-action'
  /**
   * The clause claims a STATE this platform cannot read — `empty`, `read-only`.
   *
   * Ours, like `unsupported-action`, and kept apart from it because the two need
   * different work: one is an action to build, the other a property to be able to
   * observe. A single "platform gap" bucket would hide which.
   */
  | 'unverifiable-assertion'
  /**
   * The COLUMN and the clause's verb disagree — `checks the "Active" box`.
   *
   * The only one of the three platform-ish reasons that is the QA's to fix, and
   * that is why it is separate: the sentence genuinely cannot be acted on as
   * written, and rewriting it makes the row run today.
   */
  | 'column-verb-conflict'
  /**
   * The clause names a POSITION or a REGION — an ordinal, a containing row or
   * panel, a second quoted name nothing consumed.
   *
   * Ours, and the biggest single bucket the 3a-6 audit found: 14 of 36 clauses
   * dropped a qualifier and ran anyway. Separate from `unverifiable-assertion`
   * because the work differs — a locator we cannot build versus a fact we cannot
   * read — and a QA reading either list should not have to sort them.
   */
  | 'qualifier-not-supported'
  /**
   * The row will run, and whether it is HELD depends on the CAPTURE.
   *
   * Measured before this existed: `triageSheet(rows, capturedModules)` is handed
   * module NAMES only — `triage-sheet.ts` reads `state.url` out of every capture and
   * never touches `state.nodes` — so triage cannot see a resolved ROLE, and rule B
   * (hold every state-toggling role) is not a question it can answer.
   *
   * It is not the same as `automatable`, because the run may report `held`, and it
   * is not an obstacle either. So it gets its own value rather than a promise
   * neither side can keep.
   *
   * **The size of this bucket is why the widened word list had to land first.**
   * Measured over 65 action clauses: 80% name no role at all, but only **18%** are
   * undecidable once the write WORDS are checked too. Shipping rule B's triage
   * label before rule D would have moved four fifths of the sheet into an
   * unqualified maybe, which is a ceiling that says nothing.
   */
  | 'write-risk-unknown'
  /** Nothing stands in the way. */
  | 'automatable';

/**
 * Who can act on each reason. READ by the renderer below, not carried for show.
 *
 * `OWNER_OF` is the cautionary case: a map populated on every row that nothing
 * ever consulted, so adding a member compiled clean and nobody noticed. This one
 * is printed, so a wrong entry is visible in the report.
 */
export const TRIAGE_OWNER = {
  'no-capture-for-module': 'capture',
  'outcome-not-element': 'platform',
  'too-vague-to-verify': 'qa',
  'unsupported-action': 'platform',
  'unverifiable-assertion': 'platform',
  // The QA's, deliberately: this one is a sentence they can rewrite into a row
  // that runs today, which none of the other platform-owned reasons are.
  'column-verb-conflict': 'qa',
  'qualifier-not-supported': 'platform',
  // The CAPTURE decides it, and pairing the module's capture is what resolves the
  // uncertainty — so it is the capture's, not a fault of anybody's.
  'write-risk-unknown': 'capture',
  automatable: 'none',
} as const satisfies Record<TriageReason, string>;

export interface TriagedRow {
  rowId: string;
  sheetRow: number;
  module: string;
  title: string;
  reason: TriageReason;
  /** The clause that decided it, verbatim, so the QA can see what we read. */
  evidence: string;
}

/**
 * TWO ceilings, and they travel together on purpose.
 *
 * A single ceiling is quoted alone and outlives its assumptions. "The platform
 * can only do 30% of our tests" is what "29.8%" becomes six months after the
 * captures are finished, because the qualifier lived in prose around the number
 * instead of being welded to it.
 *
 * So both are computed, neither is editorial, and each carries the capture
 * coverage it assumed. A reader who takes one has taken the other.
 */
export interface CeilingPair {
  /** Today's honest figure, with exactly the captures that exist right now. */
  withCurrentCaptures: number;
  /**
   * What it becomes once every module has been walked — the real PRODUCT
   * ceiling, and the one worth planning against.
   *
   * An upper bound on text grounds: it re-classifies the no-capture rows by
   * exactly the same clause rules as everything else, so it knows whether their
   * clauses NAME an element. It cannot know whether that element will turn out
   * to be in the capture, which is wall 2 and is not what this number claims.
   */
  withAllModulesCaptured: number;
  /** The assumptions, carried beside the numbers rather than beneath them. */
  /**
   * SHEET MODULE KEYS, not screens — the count is over the sheet's Module
   * column as written. Two keys can name one screen (`Document` and
   * `File Explorer` share a capture) and casing makes `User Role` and
   * `user role` two. Renamed in the rendered text rather than deduplicated:
   * merging them changes the number, and that is a separate decision.
   */
  modulesCaptured: number;
  modulesTotal: number;
  rowsBlockedByMissingCapture: number;
}

export interface TriageResult {
  rows: TriagedRow[];
  counts: Record<TriageReason, number>;
  ceiling: CeilingPair;
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
  const modules = new Set<string>();
  /**
   * How many rows would be automatable if every module had been captured.
   *
   * Computed for EVERY row, captured or not, by the identical clause rules —
   * which is what makes the second ceiling a measurement rather than an
   * estimate. Nothing is extrapolated from the captured modules to the others.
   */
  let automatableIfAllCaptured = 0;

  for (const row of rows) {
    const module = row.module || '(blank)';
    modules.add(module);
    // Given clauses declare the entry state; they are never an obstacle to
    // automating the row, so they are not evidence for or against it (§13.3).
    const clauses = row.clauses.filter((clause) => clause.source !== 'given');
    const title = row.scenarioName || row.objective || row.rowId;
    const base = { rowId: row.rowId, sheetRow: row.sheetRow, module, title };

    if (classifyByClauses(clauses).reason === 'automatable') automatableIfAllCaptured += 1;

    if (!capturedModules.has(module)) {
      missing.set(module, (missing.get(module) ?? 0) + 1);
      triaged.push({
        ...base,
        reason: 'no-capture-for-module',
        evidence: `no capture exists for "${module}" — run \`pnpm inspect\` on that screen`,
      });
      continue;
    }

    triaged.push({ ...base, ...classifyByClauses(clauses) });
  }

  const counts: Record<TriageReason, number> = {
    'no-capture-for-module': 0,
    'outcome-not-element': 0,
    'too-vague-to-verify': 0,
    'unsupported-action': 0,
    'unverifiable-assertion': 0,
    'column-verb-conflict': 0,
    'qualifier-not-supported': 0,
    'write-risk-unknown': 0,
    automatable: 0,
  };
  for (const row of triaged) counts[row.reason] += 1;

  const total = triaged.length;
  return {
    rows: triaged,
    counts,
    ceiling: {
      withCurrentCaptures: total === 0 ? 0 : counts.automatable / total,
      withAllModulesCaptured: total === 0 ? 0 : automatableIfAllCaptured / total,
      modulesCaptured: [...modules].filter((m) => capturedModules.has(m)).length,
      modulesTotal: modules.size,
      rowsBlockedByMissingCapture: counts['no-capture-for-module'],
    },
    missingCaptures: [...missing]
      .map(([module, rows]) => ({ module, rows }))
      .sort((a, b) => b.rows - a.rows),
  };
}

/**
 * Classifies one row's clauses, with no reference to whether a capture exists.
 *
 * Separated so BOTH ceilings run the same rules over the same clauses. If the
 * "if everything were captured" figure were computed by a second code path, the
 * two numbers could drift apart and the comparison between them would stop
 * meaning anything.
 */
function classifyByClauses(clauses: AuthoredRow['clauses']): {
  reason: TriageReason;
  evidence: string;
} {
  // AN ACTION WE CANNOT PERFORM STOPS THE ROW BEFORE ANYTHING ELSE IS ASKED.
  //
  // Same predicate the resolver refuses on (`actionCapability`), imported
  // rather than restated: two verb lists drift, and a drifted list reads exactly
  // like a correct one. The point of this branch is that triage and the run give
  // the SAME answer — a ceiling that counts a row the run then refuses is the
  // thing the comment below was written to prevent, and it had this hole in it.
  //
  // FIRST, ahead of the vague/outcome tests, and the precedence is deliberate:
  // those two are somebody else's work, and telling a QA to rewrite a row we
  // could not run even after they rewrote it spends their time on our gap. The
  // cost of the choice, stated: a row that is BOTH unsupported and vague appears
  // here now and in the QA's list later, once the capability lands.
  const unsupported = clauses.find(
    // A NAMED verb, not merely "not performable". The unnamed case is a clause
    // nothing could read an action out of, and that belongs to the QA's
    // `too-vague-to-verify` rather than to our capability backlog — the same
    // split the resolver makes when it chooses between the two refusal reasons.
    (clause) => clause.kind === 'action' && actionCapability(clause.text).verb !== undefined,
  );
  if (unsupported) {
    return { reason: 'unsupported-action', evidence: unsupported.text };
  }

  // THE SAME TWO REFUSALS THE RESOLVER ADDED, ASKED WITH THE SAME PREDICATES.
  //
  // `columnVerbConflict` and `unverifiableAssertion` are imported, not restated,
  // for the reason the branch above exists: a second copy of either rule drifts,
  // and a drifted rule makes the ceiling promise rows the run refuses. That hole
  // was closed once for upload (e3a8f76) and two new refusal reasons would have
  // reopened it.
  //
  // Ahead of the vague/outcome tests, same precedence and same reasoning: a row
  // we could not run even after the QA rewrote it does not belong in their list.
  // The conflict case is the exception that proves the ordering is about cost
  // rather than blame — it is owned by the QA and still sits here, because a
  // sentence contradicting its own column is a more specific finding than "too
  // vague", and the specific one is the one they can act on.
  const conflicting = clauses.find((clause) => columnVerbConflict(clause) !== undefined);
  if (conflicting) {
    return { reason: 'column-verb-conflict', evidence: conflicting.text };
  }

  // SAME ORDER AS THE RESOLVER, and the order is a diagnosis rather than a
  // preference: `has value "HR"` carries two quoted names AND a value comparison,
  // and the comparison is what the QA needs to hear. Asking the claim first for an
  // assertion, and the qualifier first for an action, is exactly what
  // `resolveAuthoredRow` does — so the two cannot report different reasons for the
  // same clause.
  const unverifiable = clauses.find(
    (clause) => clause.kind === 'assert' && unverifiableAssertion(clause.text) !== undefined,
  );
  if (unverifiable) {
    return { reason: 'unverifiable-assertion', evidence: unverifiable.text };
  }

  const qualified = clauses.find((clause) => unsupportedQualifier(clause.text) !== undefined);
  if (qualified) {
    return { reason: 'qualifier-not-supported', evidence: qualified.text };
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
    // NOTHING STANDS IN THE WAY OF RUNNING IT — but will it be HELD?
    //
    // Rule B holds every state-toggling ROLE, and the role comes from the capture,
    // which triage is not given. So there are two honest answers here, not one:
    // `automatable` when the clause's own text settles the write question, and
    // `write-risk-unknown` when only the capture can.
    //
    // A clause settles it by naming a role (`the "Admin" checkbox`) or by carrying
    // a write word (`clicks "Approve"`). Measured: that covers 82% of action
    // clauses, which is what makes the remaining label a qualifier rather than a
    // shrug over the whole sheet.
    const undecided = clauses.find(
      (clause) =>
        clause.kind === 'action' &&
        clause.source !== 'given' &&
        extractRole(clause.text) === undefined &&
        assessAuthoredWriteRisk({ actionClauses: [clause.text], targets: [] }).risk === 'read-only',
    );
    if (undecided) {
      return { reason: 'write-risk-unknown', evidence: undecided.text };
    }
    return { reason: 'automatable', evidence: checkable.text };
  }

  // An unverifiable Then is what stops the row, whatever its When could do,
  // so the assertions are what get classified.
  const blocking = asserts.length > 0 ? asserts : clauses;

  const vague = blocking.find((clause) => matches(VAGUE_SHAPE, clause.text));
  if (vague) return { reason: 'too-vague-to-verify', evidence: vague.text };

  const outcome = blocking.find((clause) => matches(OUTCOME_SHAPE, clause.text));
  if (outcome) return { reason: 'outcome-not-element', evidence: outcome.text };

  return {
    reason: 'too-vague-to-verify',
    evidence: blocking[0]?.text ?? clauses[0]?.text ?? '(no clauses)',
  };
}

/** The triage as a report section. Three reasons, three audiences, never merged. */
export function renderTriage(triage: TriageResult): string {
  const { counts, ceiling } = triage;
  const pct = (n: number) => `${((n / triage.rows.length) * 100).toFixed(1)}%`;

  const lines = [
    '## What this sheet can and cannot automate',
    '',
    // TWO NUMBERS, ALWAYS TOGETHER, each carrying the coverage it assumed.
    //
    // The first is today's figure and the second is the product's. Quoted
    // alone, the first becomes "the platform can only do 30% of our tests"
    // long after the captures are finished — and an alarming number gets
    // repeated where a flattering one would have invited scrutiny.
    '| Ceiling | Value | Measured with |',
    '| --- | ---: | --- |',
    `| **With today's captures** | **${(ceiling.withCurrentCaptures * 100).toFixed(1)}%** | ` +
      `${ceiling.modulesCaptured} of ${ceiling.modulesTotal} sheet module keys captured |`,
    `| **Once every module is captured** | **${(ceiling.withAllModulesCaptured * 100).toFixed(1)}%** | ` +
      `all ${ceiling.modulesTotal} sheet module keys, same clause rules |`,
    '',
    `${counts.automatable} of ${triage.rows.length} rows have nothing structural standing in the ` +
      `way today. ${ceiling.rowsBlockedByMissingCapture} more are blocked only because nobody has ` +
      'captured their screen yet.',
    '',
    '> **The first number is not the ceiling of this approach — it is the ceiling of',
    '> today’s capture coverage.** The second is what to plan against. Quoting',
    '> either without the other misstates the result in one direction or the other.',
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
    lines.push(
      `### ${heading} (${rows.length})`,
      '',
      `_Owner: ${TRIAGE_OWNER[reason]}._ ${action}`,
      '',
    );
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
    'unsupported-action',
    'An action the platform cannot perform yet',
    'The sentence is correct and the screen is captured. These name a file upload, and an action step carries no file — so the run REFUSES them rather than clicking a button and reporting a pass. Nothing for the QA to change.',
  );
  sample(
    'unverifiable-assertion',
    'A state the platform cannot read yet',
    'The sentence is correct and names a real property of a real element — `empty`, `read-only`, `expanded` — and this platform can only read present, enabled, selected and checked. They are REFUSED rather than turned into "the element exists", which would pass as soon as the element is there. Nothing for the QA to change.',
  );
  sample(
    'write-risk-unknown',
    'Runnable — and it may be HELD, depending on the capture',
    'Nothing stands in the way of running these. Whether the platform HOLDS them is decided by the kind of control the clause lands on: a checkbox, radio, switch or option is a write when clicked, whatever it is called, and this list is computed from the sheet without a capture so it cannot know. **These are not blocked.** They are counted apart from `automatable` because the run may report them `held`, and a ceiling that promised otherwise would be promising something neither side can keep.',
  );
  sample(
    'qualifier-not-supported',
    'A position or a region the platform cannot address',
    'The sentence is precise and this platform is not: it addresses an element by role and name, so an ordinal ("the second Edit"), a containing region ("in the row for Jane") or a second quoted name has nowhere to go. Measured against a real browser before these were refused: a clause scoped to one row clicked a DIFFERENT row and reported a pass. Nothing for the QA to change.',
  );
  sample(
    'column-verb-conflict',
    'The column and the sentence disagree',
    'The Given/When/Then column says one thing and the sentence’s own verb says another — a click in a Then, an assertion verb in a When, or a `checks`/`ticks` clause that names no state to check. The column is never overruled, so these are refused rather than guessed. **These run today once the sentence is rewritten to match its column**, which makes them the fastest rows on this list to recover.',
  );
  sample(
    'too-vague-to-verify',
    'Too vague to verify',
    'Nothing here states a checkable claim, so no tool can confirm or deny it. **The row itself needs rewriting**, and only its author can do that.',
  );

  return lines.join('\n');
}
