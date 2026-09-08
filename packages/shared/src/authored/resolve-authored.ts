import type { BoundedCapture } from '../generation/bounding';
import { checkGrounding, type AssertStep, type CaseStep } from '../generation/grounding';
import { assessWriteRisk } from '../generation/proposal';
import type { AuthoredRow, UnreadableSheetRow } from './final-test-cases';
import {
  CLICKABLE_ROLES,
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

    const candidates = findCandidates(
      state,
      target,
      clause.kind === 'action' ? CLICKABLE_ROLES : undefined,
    );

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
      steps.push({ kind: 'action', description: clause.text });
      continue;
    }

    const { property, expected } = assertedProperty(clause.text);
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
