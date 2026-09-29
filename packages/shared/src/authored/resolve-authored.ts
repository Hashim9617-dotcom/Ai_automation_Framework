import type { BoundedCapture } from '../generation/bounding';
import { checkGrounding, type AssertStep, type CaseStep } from '../generation/grounding';
import { assessWriteRisk } from '../generation/proposal';
import {
  actionCapability,
  columnVerbConflict,
  type AuthoredRow,
  type UnreadableSheetRow,
} from './final-test-cases';
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

  // A QUOTED string is the human explicitly delimiting a name. Trust it
  // whatever its shape — real applications do carry long composite names
  // ("Go to location PDF … Updated 27/08/2026, 11:52:32" is a real button on
  // this one), and second-guessing a name the QA typed in quotes would be the
  // same overreach as re-deriving their clause kind.
  const quoted = /["'`]([^"'`]{2,})["'`]/.exec(trimmed);
  if (quoted) return quoted[1]!.trim();

  const patterns = [
    /\b(?:click|clicks|press|presses|tap|taps|select|selects)\s+(?:on\s+)?(?:the\s+)?(.+?)(?:\s+(?:button|link|tab|icon|option))?$/i,
    /\b(?:verify|verifies|expect|expects|check|checks|assert|asserts)\s+(?:that\s+)?(?:the\s+)?(.+?)\s+(?:is|are|should)\b/i,
    /^(?:the\s+)?(.+?)\s+should\b/i,
    // The TERSE form a QA writes when the row is obvious to them: "Menu
    // visible", "Details shown". Classified as too-vague-to-verify until this
    // existed, which was wrong — it names an element perfectly well, and the
    // triage is what surfaced it.
    /^(?:the\s+)?(.+?)\s+(?:is\s+|are\s+)?(?:visible|shown|displayed|present|enabled|disabled|selected)\.?$/i,
  ];
  for (const pattern of patterns) {
    const target = pattern.exec(trimmed)?.[1]?.trim();
    // Sliced out of prose, so it must still LOOK like a name. Returning a
    // sentence here is worse than returning nothing: it counts as parsed,
    // shrinking wall 1 in the numbers, and then reaches the resolver as a
    // confident wrong target that fails somewhere it cannot be classified.
    if (target && target.length >= 2 && looksLikeAccessibleName(target)) return target;
  }
  return undefined;
}

/** Measured on 6 real DMS captures: 96.4% of targetable names are <= 6 words. */
const MAX_NAME_WORDS = 6;

/** Punctuation and connectives that belong to a sentence, not to a label. */
const SENTENCE_SHAPE =
  /[,;:]|\b(?:then|when|if|after|before|while|because|should|will|must|shall|can|would)\b/i;

/**
 * Does this look like an accessible NAME rather than a sentence?
 *
 * An accessible name is a label. `extractTarget`'s prose patterns will happily
 * slice a clause in half and hand back
 *
 *     "when checking with the user for all the selected options only the view options"
 *
 * which is not a target by any reading. Letting that through corrupts the
 * measurement as well as the run: it counts as PARSED, so wall 1 looks smaller
 * than it is, and the honest classification — an outcome, or something too
 * vague to verify — never happens.
 *
 * **The thresholds are measured, not chosen.** Across the six real DMS
 * captures, of 385 nodes carrying a role a test would target: median 1 word,
 * p90 4, p95 5, and 96.4% at or below six. The 3.6% above it are generated
 * composite names, and those arrive quoted when a QA means one.
 *
 * Exported so it has a falsifier of its own (rule 3).
 */
export function looksLikeAccessibleName(value: string): boolean {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > MAX_NAME_WORDS) return false;
  return !SENTENCE_SHAPE.test(value);
}

/**
 * State words, and the property each claims. ORDER MATTERS: negatives first.
 *
 * Measured 2026-09-29 over sixteen phrases — eight did not assert what they said.
 * Two faults, and the list below is written the way it is because of them:
 *
 * - **`checked` was absent entirely**, so `is checked` and `is not checked` BOTH
 *   fell through to `present=true`. A row and its exact negation were the same
 *   assertion, and both passed as soon as the box existed.
 * - **`not enabled` was absent while `enabled` was present**, so *"the Save
 *   button is not enabled"* matched `enabled` and asserted `enabled=TRUE`. Not a
 *   missing check — the opposite one, green whenever the button was enabled.
 *
 * So every property carries BOTH polarities, negative first, and the negative
 * pattern spells out the `not X` form rather than relying on a separate antonym
 * happening to exist. `disabled` is kept beside `not enabled` for that reason:
 * the antonym is a convenience, never the only way to express the negative.
 */
const PROPERTY_WORDS: Array<[RegExp, AssertStep['property'], boolean]> = [
  [/\bnot\s+checked\b|\bunchecked\b|\bunticked\b/i, 'checked', false],
  [/\bchecked\b|\bticked\b/i, 'checked', true],
  [/\bnot\s+selected\b|\bunselected\b/i, 'selected', false],
  [/\bselected\b/i, 'selected', true],
  [/\bnot\s+enabled\b|\bdisabled\b/i, 'enabled', false],
  [/\benabled\b/i, 'enabled', true],
  [/\b(?:not\s+(?:visible|present|shown|displayed)|absent|hidden|gone)\b/i, 'present', false],
  [/\b(?:visible|present|shown|appears?|displayed)\b/i, 'present', true],
];

/**
 * State words this platform recognises as STATES and cannot verify.
 *
 * Not the same list as the one above and not its complement: these are words a QA
 * genuinely writes, that name a real property of a real element, and that no
 * capture field and no Playwright call in this codebase can answer. Measured, from
 * the same pass: each of them produced `present=true`, so the row asserted that
 * the element EXISTS and passed — a check that cannot fail.
 *
 * They are REFUSED rather than approximated. The alternative — grading them
 * `assumed` forever — puts them in the capture's backlog, and the capture is not
 * where the gap is.
 */
const UNVERIFIABLE_STATE_WORDS =
  /\b(empty|expanded|collapsed|read-?only|editable|required|optional|focused|sorted|highlighted)\b/i;

/** `not`, in the forms a QA writes it. A negation nothing matched is a refusal. */
const NEGATION_WORDS = /\bnot\b|\bno longer\b|\bnever\b|n['’]t\b/i;

/**
 * What an assertion claims about its target, or `undefined` when nothing matched.
 *
 * It used to DEFAULT to `present=true`, which is right for *"verify 'Approved'"* —
 * a clause naming an element and no state — and catastrophic for one naming a
 * state the list does not hold. The caller now decides, because only the caller
 * can see whether the clause was making a state claim at all.
 */
function assertedProperty(
  text: string,
): { property: AssertStep['property']; expected: boolean } | undefined {
  for (const [pattern, property, expected] of PROPERTY_WORDS) {
    if (pattern.test(text)) return { property, expected };
  }
  return undefined;
}

/**
 * The state word this clause makes a claim about that nothing here can verify.
 *
 * Quoted names are excluded first: a checkbox called "Required" is not a QA saying
 * the field is required. Same rule `extractRole` learned by reading "select" out
 * of "Select department".
 */
export function unverifiableAssertion(text: string): string | undefined {
  const outsideNames = text.replace(/["'`][^"'`]*["'`]/g, ' ');
  const word = UNVERIFIABLE_STATE_WORDS.exec(outsideNames)?.[1];
  if (word) return word.toLowerCase();
  // A NEGATION that matched no property is a claim we have not understood. It is
  // the direction that matters: dropping a `not` turns an assertion into its
  // opposite, which passes exactly when the row should fail.
  return NEGATION_WORDS.test(outsideNames) ? 'not' : undefined;
}

export interface ResolvedAuthoredRow extends ResolvedRow {
  scenarioId: string;
  testCaseId: string;
  /**
   * The sheet's Module cell, carried verbatim.
   *
   * REQUIRED, and the requirement is the point: it is what the map is keyed on,
   * what the report groups by and what the app team's CSV names, so a row that
   * reached execution without one is a row nobody can route. It was previously
   * read from the sheet, used to build the map lookup, and then dropped — see
   * `RowResultFields.module`.
   */
  module: string;
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
  /**
   * The Given clauses, verbatim — named for the column they come from.
   *
   * NOT the sheet's "Preconditions" column, which is read into
   * `AuthoredRow.preconditions` and is a different thing; one identifier for
   * both hid which one a reader was looking at. Door A's `TestCase` schema has
   * a third `preconditions`, unrelated to either.
   *
   * Carried as CONTEXT, never resolved as elements. The column already says
   * these declare where the row starts, and the pipeline models that as
   * `entryState`. 455 of 470 of them could not be resolved as elements, which
   * was a category error rather than a parser gap (§13.3).
   */
  givenClauses: string[];
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
    // Carried, not re-derived. `entryState` is the module's ROUTE and cannot be
    // read back into a module name, so this is the only place the sheet's own
    // word for the screen survives resolution.
    module: authored.module,
    sheetRow: authored.sheetRow,
    title: authored.scenarioName || authored.objective || authored.rowId,
    clauseKinds: authored.clauses.map((clause) => clause.kind),
    targets: [] as ResolvedAuthoredRow['targets'],
    givenClauses: [] as string[],
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
  /** Given clauses: what the QA said the row starts from. Context, never a step. */
  const givenClauses: string[] = [];

  for (const [stepIndex, clause] of authored.clauses.entries()) {
    // A GIVEN CLAUSE IS THE ENTRY STATE, NOT AN ACTION.
    //
    // "user on policy agent", "User is in the global search search bar" — these
    // declare WHERE the test starts. The pipeline already models that and takes
    // `entryState` as a separate parameter, yet every Given clause was also
    // being pushed through element resolution, where 455 of 470 (97%) failed.
    //
    // That was never a parser gap. There is no element in "user on policy
    // agent" to find, and a better extractor would have found it no faster.
    // Refusing them was technically correct and practically useless: it filled
    // the QA's report with 455 refusals about clauses that were never our
    // business to resolve.
    if (clause.source === 'given') {
      givenClauses.push(clause.text);
      continue;
    }

    // THE COLUMN AND THE VERB DISAGREE, so nothing is run and nothing is
    // reclassified.
    //
    // FIRST, ahead of every other test, and the position is the diagnosis: a
    // clause whose column contradicts its own text cannot be usefully described
    // as "an action we cannot perform" or "a target we could not find". Both of
    // those would be true statements about a sentence whose real problem is that
    // two sources disagree about what it is.
    //
    // The kind the column declared is still recorded on `clauseKinds` — `base`
    // reads it from the clause, not from anything decided here — so a reader can
    // see that the refusal did not quietly reinterpret the row.
    const conflict = columnVerbConflict(clause);
    if (conflict) {
      refusals.push({
        stepIndex,
        sentence: clause.text,
        why: 'column-verb-conflict',
        candidates: [],
        reason: `${authored.rowId}, ${clause.source} clause "${clause.text}": ${conflict}`,
      });
      continue;
    }

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

    // AN ACTION THE PLATFORM CANNOT PERFORM IS REFUSED HERE, and the position
    // is the finding. Inside the action branch below it never fired: a clause
    // like "User uploads the document" yields no target, so `extractTarget`
    // refused it first as `unparseable-step` — technically a refusal, and the
    // wrong reason. It blames the QA's sentence for a gap in the platform, and
    // sends them to rewrite a sentence that is already correct.
    //
    // Here the clause is a classified action and nothing has reasoned about a
    // target yet. Resolve time, so a row refused for this never reaches
    // `executeAuthoredRows` as runnable and no browser action can begin.
    if (clause.kind === 'action') {
      const capability = actionCapability(clause.text);
      if (!capability.performable) {
        refusals.push({
          stepIndex,
          sentence: clause.text,
          // TWO REASONS, because the QA's next move differs. A named verb is our
          // gap — wait for the feature. Nothing recognisable is a sentence we
          // could not read an action out of, which they can rewrite today. Both
          // refuse; merging them would send half of each group to the wrong
          // place, which is why `failed` and `refused` are separate too.
          why: capability.verb ? 'action-not-supported' : 'unparseable-step',
          candidates: [],
          reason: capability.verb
            ? `${authored.rowId}: "${capability.verb}" is not an action this platform can ` +
              'perform — the only action it has is a click, so the step would click something ' +
              'and report a pass having done nothing else'
            : `${authored.rowId}, ${clause.source} clause "${clause.text}": no action this ` +
              'platform can perform could be read out of it — it has only a click, and this ' +
              'clause does not name one',
        });
        continue;
      }
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

    // A STATE CLAIM NOTHING CAN READ IS REFUSED, NOT TURNED INTO `present`.
    //
    // The default below is for a clause that names an element and no state —
    // `verify "Approved"` means "it is there". A clause that DOES name a state
    // must not borrow that default: "the Notes field is empty" became
    // `present=true` and passed as soon as the field existed, a check that cannot
    // fail on a row that reads as covered.
    const claim = assertedProperty(clause.text);
    if (!claim) {
      const unverifiable = unverifiableAssertion(clause.text);
      if (unverifiable) {
        refusals.push({
          stepIndex,
          sentence: clause.text,
          why: 'assertion-not-supported',
          candidates: [],
          reason:
            `${authored.rowId}: "${unverifiable}" is a state this platform cannot read off ` +
            `${candidates[0] ? `${candidates[0].role} "${target}"` : `"${target}"`} — it can ` +
            'check present, enabled, selected and checked, and refusing is better than ' +
            'asserting the element merely exists',
        });
        continue;
      }
    }

    const { property, expected } = claim ?? { property: 'present' as const, expected: true };
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
      givenClauses,
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
      givenClauses,
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
    givenClauses,
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
