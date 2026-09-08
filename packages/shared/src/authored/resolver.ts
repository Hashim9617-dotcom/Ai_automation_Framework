import type { BoundedCapture } from '../generation/bounding';
import {
  checkGrounding,
  type AssertStep,
  type CandidateCase,
  type CaseStep,
  type CapturedState,
  type GroundingReason,
} from '../generation/grounding';
import { assessWriteRisk } from '../generation/proposal';
import type { AuthoredCase } from './sheet';

/**
 * Turning a QA's sentence into a step the platform can ground and run.
 *
 * Door B of `docs/phase-2-authored-cases.md`. This is the ONLY new component
 * on that path — everything downstream (grounding, the reason codes, write
 * risk, approval identity) is door A's machinery reused unchanged, which §1 of
 * that document verified rather than assumed.
 *
 * The rule this file exists to hold:
 *
 * > **A step that matches more than one element is REFUSED, naming the
 * > candidates.** Never the first match, never the best match.
 *
 * A single match is an absence claim — no OTHER node matches — and a multiple
 * match is that claim positively refuted. Picking would be worse than useless
 * in a specific way: it succeeds. The run goes green or red against an element
 * nobody chose, and the row keeps its ambiguity forever because nothing ever
 * asks about it.
 */

/** Why a row could not be turned into runnable steps. Machine-readable. */
export type RefusalReason =
  | 'unparseable-step'
  | 'ambiguous-target'
  | 'target-not-found'
  | 'entry-state-not-captured';

export interface StepRefusal {
  stepIndex: number;
  /** The QA's own sentence, verbatim — they must see what we could not read. */
  sentence: string;
  why: RefusalReason;
  /** Named for `ambiguous-target`, so the QA can say which one they meant. */
  candidates: Array<{ role: string; name: string }>;
  reason: string;
}

/**
 * Who has to act. Derived mechanically, never inferred from prose.
 *
 * Three, not two, and deliberately: forcing `capture-thin` into one of the
 * other two would destroy exactly the distinction §3 requires. This project
 * learned it once already — "the capture was thin" is three faults with
 * different fixes — so the same `GroundingReason` codes are reused rather than
 * a second vocabulary invented.
 */
export type Owner = 'none' | 'app-team' | 'qa' | 'capture';

export type RowOutcome = 'ok' | 'app-disagrees' | 'row-unclear' | 'capture-thin';

export interface ResolvedRow {
  /** The identity that survives the whole pipeline. Never absent. */
  rowId: string;
  sheetRow: number;
  title: string;
  outcome: RowOutcome;
  owner: Owner;
  /** Present when every step resolved; this is what execution would run. */
  steps: CaseStep[];
  refusals: StepRefusal[];
  /** Per-step grades from the shared grader. Empty when the row was refused. */
  grades: Array<{ stepIndex: number; grade: string; why: GroundingReason; reason: string }>;
  writeRisk: 'read-only' | 'creates-data';
  /** One line, ready to log or print in a report. Never empty. */
  summary: string;
}

const norm = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase();

/** Roles a click can plausibly land on. ARIA, not application vocabulary. */
export const CLICKABLE_ROLES = ['button', 'link', 'tab', 'menuitem', 'treeitem', 'option', 'checkbox'];

const STATE_WORDS: Record<string, { property: AssertStep['property']; expected: boolean }> = {
  selected: { property: 'selected', expected: true },
  'not selected': { property: 'selected', expected: false },
  unselected: { property: 'selected', expected: false },
  enabled: { property: 'enabled', expected: true },
  disabled: { property: 'enabled', expected: false },
  present: { property: 'present', expected: true },
  visible: { property: 'present', expected: true },
  absent: { property: 'present', expected: false },
  'not present': { property: 'present', expected: false },
  gone: { property: 'present', expected: false },
};

interface ParsedStep {
  kind: 'action' | 'assert';
  /** The element name the sentence points at. */
  target: string;
  property?: AssertStep['property'];
  expected?: boolean;
}

/**
 * The PROVISIONAL grammar.
 *
 * Deliberately small, and deliberately refusing rather than guessing. **It will
 * be wrong** — it is a placeholder for whatever the real sheet contains — which
 * is why it is isolated in one function and why its failure mode matters more
 * than its coverage: an unrecognised sentence is refused with the sentence
 * quoted, so widening it later is safe and never silently changes a verdict.
 */
export function parseStep(sentence: string): ParsedStep | undefined {
  const text = sentence.trim();

  const action = /^(?:click|press|tap)\s+(?:on\s+)?(.+)$/i.exec(text);
  if (action) {
    const target = stripQuotes(action[1]!);
    return target ? { kind: 'action', target } : undefined;
  }

  const assertion = /^(?:verify|expect|check|assert)\s+(?:that\s+)?(.+)$/i.exec(text);
  if (assertion) {
    const rest = stripQuotes(assertion[1]!);
    const match = /^(.*?)\s+(?:is|are|should\s+be)\s+(.+?)\.?$/i.exec(rest);
    if (!match) return undefined;
    const target = stripQuotes(match[1]!);
    const state = STATE_WORDS[norm(match[2]!)];
    if (!target || !state) return undefined;
    return { kind: 'assert', target, property: state.property, expected: state.expected };
  }

  return undefined;
}

function stripQuotes(value: string): string {
  return value.trim().replace(/^["'`](.*)["'`]$/s, '$1').trim();
}

/** Every node in the entry state whose accessible name matches the target. */
export function findCandidates(state: CapturedState, target: string, roles?: string[]) {
  return state.nodes.filter(
    (node) => norm(node.name) === norm(target) && (!roles || roles.includes(node.role)),
  );
}

/**
 * Resolves one authored row against a bounded capture.
 *
 * Resolution and grading are separate on purpose. Resolution answers *"can we
 * understand this row"* — a question about the ROW, owned by the QA. Grading
 * answers *"does the app agree"* — a question about the APPLICATION, owned by
 * its team. Merging them would produce a report useless to both, which is the
 * failure §3 exists to prevent.
 */
export function resolveRow(
  authored: AuthoredCase,
  capture: BoundedCapture,
  entryState: string,
): ResolvedRow {
  const base = {
    rowId: authored.rowId,
    sheetRow: authored.sheetRow,
    title: authored.title,
    writeRisk: assessWriteRisk({
      title: authored.title,
      entryState,
      steps: authored.steps.map((description) => ({ kind: 'action' as const, description })),
    }),
  };

  const state = capture.states.find((candidate) => candidate.id === entryState);
  if (!state) {
    const available = capture.states.map((s) => s.id);
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
          reason:
            `the entry state "${entryState}" is not in this capture; ` +
            `available: ${available.map((id) => `"${id}"`).join(', ') || '(none)'}`,
        },
      ],
      summary: `row ${authored.rowId}: refused — entry state "${entryState}" is not in the capture`,
    };
  }

  const steps: CaseStep[] = [];
  const refusals: StepRefusal[] = [];

  for (const [stepIndex, sentence] of authored.steps.entries()) {
    const parsed = parseStep(sentence);

    if (!parsed) {
      refusals.push({
        stepIndex,
        sentence,
        why: 'unparseable-step',
        candidates: [],
        reason: `no action or assertion could be read out of "${sentence}"`,
      });
      continue;
    }

    const roles = parsed.kind === 'action' ? CLICKABLE_ROLES : undefined;
    const candidates = findCandidates(state, parsed.target, roles);

    // THE RULE. More than one match means the row is under-specified, and the
    // person who can fix that is the person who wrote it.
    if (candidates.length > 1) {
      refusals.push({
        stepIndex,
        sentence,
        why: 'ambiguous-target',
        candidates: candidates.map((node) => ({ role: node.role, name: node.name })),
        reason:
          `"${parsed.target}" matches ${candidates.length} elements in "${state.id}" ` +
          `(${candidates.map((c) => `${c.role} "${c.name}"`).join(', ')}) — ` +
          'say which one is meant',
      });
      continue;
    }

    if (parsed.kind === 'action') {
      // Zero matches is asymmetric between the two kinds, and deliberately so.
      // An ASSERTION against zero matches in a complete view is EVIDENCE —
      // `contradicted`, an app finding, which the grader already produces. An
      // ACTION against zero matches cannot be graded at all: there is nothing
      // to click, so it is a resolution failure and not a statement about the
      // application.
      if (candidates.length === 0) {
        refusals.push({
          stepIndex,
          sentence,
          why: 'target-not-found',
          candidates: [],
          reason: `nothing clickable named "${parsed.target}" in "${state.id}" — an action cannot be performed on nothing`,
        });
        continue;
      }
      steps.push({ kind: 'action', description: sentence });
      continue;
    }

    steps.push({
      kind: 'assert',
      // The role comes from the CAPTURE when the target resolved, and from the
      // sentence never — a role guessed out of prose would be an invented fact.
      role: candidates[0]?.role ?? 'generic',
      name: parsed.target,
      property: parsed.property!,
      expected: parsed.expected!,
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
      summary:
        `row ${authored.rowId}: refused — ${refusals.length} step(s) could not be resolved: ` +
        refusals.map((r) => r.why).join(', '),
    };
  }

  const candidate: CandidateCase = { entryState, steps };
  const graded = checkGrounding(capture, candidate);
  const assertionGrades = graded.steps.filter(
    (grade) => candidate.steps[grade.stepIndex]?.kind === 'assert',
  );

  const grades = graded.steps.map((grade) => ({
    stepIndex: grade.stepIndex,
    grade: grade.grade,
    why: grade.why,
    reason: grade.reason,
  }));

  // Owner is derived from the grades, in a fixed precedence: a contradiction is
  // a finding about the application and outranks a silence, because the app
  // team can act on it today while a thin capture only blocks checking.
  if (assertionGrades.some((grade) => grade.grade === 'contradicted')) {
    const first = assertionGrades.find((grade) => grade.grade === 'contradicted')!;
    return {
      ...base,
      outcome: 'app-disagrees',
      owner: 'app-team',
      steps,
      grades,
      refusals: [],
      summary: `row ${authored.rowId}: the app disagrees with this row — ${first.reason}`,
    };
  }

  if (assertionGrades.some((grade) => grade.grade === 'assumed')) {
    const first = assertionGrades.find((grade) => grade.grade === 'assumed')!;
    return {
      ...base,
      outcome: 'capture-thin',
      owner: 'capture',
      steps,
      grades,
      refusals: [],
      summary: `row ${authored.rowId}: the capture cannot answer this row — ${first.why}: ${first.reason}`,
    };
  }

  return {
    ...base,
    outcome: 'ok',
    owner: 'none',
    steps,
    grades,
    refusals: [],
    summary: `row ${authored.rowId}: resolved, ${steps.length} step(s), grounded against "${entryState}"`,
  };
}

export interface ResolveSheetResult {
  rows: ResolvedRow[];
  byOutcome: Record<RowOutcome, number>;
}

/**
 * Resolves every authored row.
 *
 * **No row silently vanishes** (doc §4). The row ids going out are compared
 * with the ids coming in as a SET, not as a count — a count alone cannot see
 * one row replacing another — and a mismatch throws rather than returning a
 * plausible-looking shorter list.
 */
export function resolveSheet(
  authored: AuthoredCase[],
  capture: BoundedCapture,
  entryState: string,
): ResolveSheetResult {
  const rows = authored.map((row) => resolveRow(row, capture, entryState));

  const wanted = [...authored.map((row) => row.rowId)].sort();
  const got = [...rows.map((row) => row.rowId)].sort();
  if (wanted.length !== got.length || wanted.some((id, i) => id !== got[i])) {
    throw new Error(
      `resolveSheet lost or altered rows: in [${wanted.join(', ')}], out [${got.join(', ')}]. ` +
        'Every row must leave with the id it arrived with — that id is what the whole pipeline is traced by.',
    );
  }

  const byOutcome: Record<RowOutcome, number> = {
    ok: 0,
    'app-disagrees': 0,
    'row-unclear': 0,
    'capture-thin': 0,
  };
  for (const row of rows) byOutcome[row.outcome] += 1;

  return { rows, byOutcome };
}
