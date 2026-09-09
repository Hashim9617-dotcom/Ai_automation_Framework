import type { BoundedCapture } from '../generation/bounding';
import { checkGrounding, type AssertStep, type CaseStep } from '../generation/grounding';
import { assessWriteRisk } from '../generation/proposal';
import type { AuthoredRow, UnreadableSheetRow } from './final-test-cases';
import {
  CANDIDATE_ROLES,
  CLICKABLE_ROLES,
  collapseTextDuplicates,
  extractRole,
  findCandidates,
  type Owner,
  type ResolvedRow,
  type StepRefusal,
} from './resolver';

/**
 * Resolving a row of the REAL sheet, where the column already says what each
 * clause is.
 *
 * The rule this file exists to hold (`docs/phase-2-authored-cases.md` §2b):
 *
 * > **The column's clause kind is AUTHORITATIVE. Never re-derive it.**
 *
 * The QA wrote `Given`, `When`, `And`, `Then` as headers — a human stating what
 * kind of clause this is, formed before and independently of anything the
 * platform observes. If the resolver classified the text again, the model could
 * disagree with the column, and **any rule for settling that disagreement makes
 * the model the authority over the person who wrote the sheet.** There is no
 * safe tie-break, so the election is not held.
 *
 * That narrows the model-facing job to one thing: **map a clause to an element
 * in the capture.** It does not decide what the clause IS.
 */

/**
 * Pulls the element a clause points at, and NOTHING else.
 *
 * Deliberately cannot express a kind, which is what makes "the column wins"
 * structural rather than a rule someone has to remember: a function with no way
 * to return a kind has no way to disagree about one.
 */
export function extractTarget(text: string): string | undefined {
  const trimmed = text.trim().replace(/[.;]+$/, '');
  if (!trimmed) return undefined;

  const quoted = /["'`]([^"'`]{2,})["'`]/.exec(trimmed);
  if (quoted) return quoted[1]!.trim();

  const patterns = [
    /\b(?:click|clicks|press|presses|tap|taps|select|selects)\s+(?:on\s+)?(?:the\s+)?(.+?)(?:\s+(?:button|link|tab|icon|option))?$/i,
    /\b(?:verify|verifies|expect|expects|check|checks|assert|asserts)\s+(?:that\s+)?(?:the\s+)?(.+?)\s+(?:is|are|should)\b/i,
    /^(?:the\s+)?(.+?)\s+should\b/i,
  ];
  for (const pattern of patterns) {
    const target = pattern.exec(trimmed)?.[1]?.trim();
    if (target && target.length >= 2) return target;
  }
  return undefined;
}

const PROPERTY_WORDS: Array<[RegExp, AssertStep['property'], boolean]> = [
  [/\bnot\s+selected\b|\bunselected\b/i, 'selected', false],
  [/\bselected\b/i, 'selected', true],
  [/\bdisabled\b/i, 'enabled', false],
  [/\benabled\b/i, 'enabled', true],
  [/\b(?:not\s+(?:visible|present|shown)|absent|hidden|gone)\b/i, 'present', false],
  [/\b(?:visible|present|shown|appears?|displayed)\b/i, 'present', true],
];

/** What an assertion claims about its target. Presence unless it says otherwise. */
function assertedProperty(text: string): { property: AssertStep['property']; expected: boolean } {
  for (const [pattern, property, expected] of PROPERTY_WORDS) {
    if (pattern.test(text)) return { property, expected };
  }
  return { property: 'present', expected: true };
}

export interface ResolvedAuthoredRow extends ResolvedRow {
  scenarioId: string;
  testCaseId: string;
  /** The kinds actually used, in order — taken from the columns, never derived. */
  clauseKinds: string[];
  /**
   * The element the RESOLVER chose for each step, carried to the executor.
   *
   * Re-deriving it from the prose at execution time would be the clause-kind
   * mistake one layer down: two components interpreting the same sentence can
   * disagree, silently — and worse here, because the resolver refused ambiguity
   * against the capture and a fresh interpretation would not (§10.0).
   */
  targets: Array<{ stepIndex: number; role: string; name: string }>;
}

export function resolveAuthoredRow(
  authored: AuthoredRow,
  capture: BoundedCapture,
  entryState: string,
): ResolvedAuthoredRow {
  const base = {
    rowId: authored.rowId,
    scenarioId: authored.scenarioId,
    testCaseId: authored.testCaseId,
    sheetRow: authored.sheetRow,
    title: authored.scenarioName || authored.objective || authored.rowId,
    clauseKinds: authored.clauses.map((clause) => clause.kind),
    targets: [] as ResolvedAuthoredRow['targets'],
    writeRisk: assessWriteRisk({
      title: authored.scenarioName,
      entryState,
      steps: authored.clauses.map((clause) => ({
        kind: 'action' as const,
        description: clause.text,
      })),
    }),
  };

  const state = capture.states.find((candidate) => candidate.id === entryState);
  if (!state) {
    return {
      ...base,
      outcome: 'row-unclear',
      owner: 'qa',
      steps: [],
      grades: [],
      refusals: [
        {
          stepIndex: -1,
          sentence: entryState,
          why: 'entry-state-not-captured',
          candidates: [],
          reason: `the entry state "${entryState}" is not in this capture; available: ${capture.states
            .map((s) => `"${s.id}"`)
            .join(', ')}`,
        },
      ],
      summary: `${authored.rowId}: refused — entry state "${entryState}" is not in the capture`,
    };
  }

  const steps: CaseStep[] = [];
  const targets: ResolvedAuthoredRow['targets'] = [];
  const refusals: StepRefusal[] = [];

  for (const [stepIndex, clause] of authored.clauses.entries()) {
    // `unclassified` is one of the 37 "&"-joined halves the sheet genuinely
    // does not label. Refused with the row and the clause, never guessed —
    // mistaking an assertion for a click means the test goes green having
    // verified nothing, and neither direction fails loudly.
    if (clause.kind === 'unclassified') {
      refusals.push({
        stepIndex,
        sentence: clause.text,
        why: 'unparseable-step',
        candidates: [],
        reason: `${authored.rowId}, ${clause.source} clause "${clause.text}": ${
          clause.why ?? 'could not be classified'
        }`,
      });
      continue;
    }

    const target = extractTarget(clause.text);
    if (!target) {
      refusals.push({
        stepIndex,
        sentence: clause.text,
        why: 'unparseable-step',
        candidates: [],
        reason: `${authored.rowId}, ${clause.source} clause "${clause.text}": no element could be read out of it`,
      });
      continue;
    }

    // THREE STEPS, IN THIS ORDER. Counting first was the bug: a flattened
    // accessibility tree lists every visible label twice — the control and the
    // text on its face — so counting first called almost everything ambiguous
    // and refused it. A rule that refuses everything is satisfied by knowing
    // nothing about the page, exactly like one that accepts everything.
    //
    // 1. USE THE ROLE THE QA WROTE. "click the Sign in button" names a role.
    //    Reading it is not inference — the human wrote it.
    const writtenRole = extractRole(clause.text);
    const roles = writtenRole
      ? [writtenRole]
      : clause.kind === 'action'
        ? CLICKABLE_ROLES
        : CANDIDATE_ROLES;

    // 2. COLLAPSE a control and its own text into the one control it is.
    const matches = findCandidates(state, target, roles);
    const candidates = collapseTextDuplicates(matches);

    // 3. ONLY THEN COUNT. More than one survivor is real ambiguity, and
    //    refusing is still correct there — see below.

    if (candidates.length > 1) {
      refusals.push({
        stepIndex,
        sentence: clause.text,
        why: 'ambiguous-target',
        candidates: candidates.map((node) => ({ role: node.role, name: node.name })),
        reason:
          `${authored.rowId}: "${target}" matches ${candidates.length} elements in "${state.id}" ` +
          `(${candidates.map((c) => `${c.role} "${c.name}"`).join(', ')}) — say which one is meant`,
      });
      continue;
    }

    if (clause.kind === 'action') {
      if (candidates.length === 0) {
        refusals.push({
          stepIndex,
          sentence: clause.text,
          why: 'target-not-found',
          candidates: [],
          reason: `${authored.rowId}: nothing clickable named "${target}" in "${state.id}"`,
        });
        continue;
      }
      targets.push({ stepIndex: steps.length, role: candidates[0]!.role, name: target });
      steps.push({ kind: 'action', description: clause.text });
      continue;
    }

    const { property, expected } = assertedProperty(clause.text);
    if (candidates[0]) {
      targets.push({ stepIndex: steps.length, role: candidates[0].role, name: target });
    }
    steps.push({
      kind: 'assert',
      role: candidates[0]?.role ?? 'generic',
      name: target,
      property,
      expected,
    });
  }

  if (refusals.length > 0) {
    return {
      ...base,
      outcome: 'row-unclear',
      owner: 'qa',
      steps: [],
      grades: [],
      refusals,
      summary: `${authored.rowId}: refused — ${refusals.length} clause(s) could not be resolved`,
    };
  }

  const graded = checkGrounding(capture, { entryState, steps });
  const grades = graded.steps.map((grade) => ({
    stepIndex: grade.stepIndex,
    grade: grade.grade,
    why: grade.why,
    reason: grade.reason,
  }));
  const assertions = graded.steps.filter((g) => steps[g.stepIndex]?.kind === 'assert');

  const contradicted = assertions.find((g) => g.grade === 'contradicted');
  if (contradicted) {
    return {
      ...base,
      outcome: 'app-disagrees',
      owner: 'app-team',
      steps,
      targets,
      grades,
      refusals: [],
      summary: `${authored.rowId}: the app disagrees with this row — ${contradicted.reason}`,
    };
  }

  const assumed = assertions.find((g) => g.grade === 'assumed');
  if (assumed) {
    return {
      ...base,
      outcome: 'capture-thin',
      owner: 'capture',
      steps,
      targets,
      grades,
      refusals: [],
      summary: `${authored.rowId}: the capture cannot answer this row — ${assumed.why}`,
    };
  }

  return {
    ...base,
    outcome: 'ok',
    owner: 'none',
    steps,
    // `targets` was omitted here while both other resolving returns carried it,
    // so `base`'s empty array won and a CLEANLY RESOLVED row reached the
    // executor with no target for any step. The executor is contracted to
    // return `no-observable-check` without one, so every perfect row would have
    // come back REFUSED, owner `qa` — the platform telling the author their row
    // was unreadable to cover a fault of its own.
    //
    // Neither side's tests could see it: the resolver's assert outcomes and
    // refusals, the executor's were handed targets directly by their fixtures.
    // It lived in the SEAM, which is the one place a fixture written by the
    // author of both sides cannot reach.
    targets,
    grades,
    refusals: [],
    summary: `${authored.rowId}: resolved, ${steps.length} step(s) against "${entryState}"`,
  };
}

/**
 * A row the reader could not identify, rendered as something a QA can act on.
 *
 * §2d: a row carrying real clauses but no identity is a test case someone
 * started and never finished. Handing back its content with an instruction
 * recovers real coverage; a skip count is a number nobody acts on. That is the
 * difference between a tool that tolerates bad input and one that improves the
 * sheet it reads.
 */
export function describeUnreadableRow(row: UnreadableSheetRow): {
  sheetRow: number;
  owner: Owner;
  actionable: boolean;
  message: string;
} {
  if (row.why === 'content-without-identity') {
    const clauses = row.orphanedContent ?? [];
    return {
      sheetRow: row.sheetRow,
      owner: 'qa',
      actionable: true,
      message:
        `Row ${row.sheetRow}: a test case is being lost — it has ${clauses.length} clause(s) ` +
        'but no Scenario ID / Test Case ID, so nothing can be traced to it.\n' +
        clauses.map((line) => `    ${line}`).join('\n') +
        '\n  To recover it: give the row a Scenario ID and a Test Case ID.',
    };
  }
  return {
    sheetRow: row.sheetRow,
    owner: 'qa',
    actionable: false,
    message: `Row ${row.sheetRow}: ${row.reason}`,
  };
}
