import type { BoundedCapture } from '../generation/bounding';
import type { AuthoredRow } from './final-test-cases';
import type { RefusalReason } from './resolver';
import { resolveAuthoredRow } from './resolve-authored';

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
  /**
   * Nobody has captured this screen. Someone runs `pnpm inspect` on it.
   *
   * THE ONLY REASON TRIAGE STILL DECIDES BY ITSELF, and the only one it can: a row
   * whose module has no captured state cannot be resolved at all, so there is no
   * resolver verdict to project. Every other reason below is read OFF the
   * resolver's own refusal (B1).
   */
  | 'no-capture-for-module'
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
   * The sheet never LABELLED this clause — no Given/When/Then column.
   *
   * From the resolver's `clause-not-labelled`. Measured: 147 clauses on the real
   * sheet, the first refusal on only 6 rows, so it is widespread and rarely the
   * thing to fix first — a distinction that was invisible while three faults shared
   * one code.
   */
  | 'clause-not-labelled'
  /**
   * No action this platform can perform could be read out of an action clause.
   *
   * From the resolver's `no-readable-action`. OURS. Distinct from
   * `unsupported-action`, which NAMES the verb it cannot perform: that one goes on a
   * capability backlog, this one has nothing to put on it.
   */
  | 'no-readable-action'
  /**
   * The clause names no element.
   *
   * From the resolver's `no-readable-target`. Measured on the real sheet: of the 118
   * clauses that land here, ZERO carry a quoted name this platform failed to read,
   * and the sheet quotes a control in 5 clauses out of 1452.
   */
  | 'no-readable-target'
  /**
   * The element the clause names is not in the capture at the module's route.
   *
   * From the resolver's `target-not-found`, and NOT the same as
   * `no-capture-for-module`: that screen has never been walked, this one has and
   * does not contain the named control. Merged, the `pnpm inspect` worklist would
   * name screens that are already captured.
   */
  | 'no-capture-for-element'
  /** The name matches several elements. The QA says which (`ambiguous-target`). */
  | 'ambiguous-target'
  /**
   * NOTHING STANDS IN THE WAY — and this now means the run WILL execute the row.
   *
   * It used to be triage's own opinion, reached by text rules the resolver never
   * saw. Measured on the real workbook at the moment that changed: triage called 27
   * rows automatable beside the sentence *"these are the rows a run executes"*, and
   * the run executed **none** of them — 18 were held and 9 refused.
   *
   * So the word is now earned the only way it can be: the row is resolved against
   * the SAME capture and the SAME entry state the run uses, and it counts only if
   * every clause resolved and nothing holds it.
   */
  | 'automatable'
  /**
   * The row resolves completely and the WRITE GATE holds it.
   *
   * Its own value, travelling beside `automatable` as a pair, because the two
   * answer different questions and a single number cannot. `automatable` must equal
   * what the run executes — that is the agreement B1 exists to create — and a held
   * row is not executed. But it is not an obstacle either: nothing is wrong with
   * the row, and `ALLOW_WRITES` is a policy decision somebody can take.
   *
   * Folded into `automatable` it would overstate what a run does; folded into the
   * obstacles it would send a QA to fix a row that is already correct.
   */
  | 'automatable-but-held';

/**
 * Who can act on each reason. READ by the renderer below, not carried for show.
 *
 * `OWNER_OF` is the cautionary case: a map populated on every row that nothing
 * ever consulted, so adding a member compiled clean and nobody noticed. This one
 * is printed, so a wrong entry is visible in the report.
 */
export const TRIAGE_OWNER = {
  'no-capture-for-module': 'capture',
  'no-capture-for-element': 'capture',
  'unsupported-action': 'platform',
  'no-readable-action': 'platform',
  'unverifiable-assertion': 'platform',
  'qualifier-not-supported': 'platform',
  // The QA's, deliberately: these are sentences they can rewrite into a row that
  // runs today, which none of the platform-owned reasons are.
  'column-verb-conflict': 'qa',
  'clause-not-labelled': 'qa',
  'no-readable-target': 'qa',
  'ambiguous-target': 'qa',
  automatable: 'none',
  // Nobody's fault and nobody's work. The row is correct and complete; whether to
  // set `ALLOW_WRITES` is a decision, not a defect.
  'automatable-but-held': 'none',
} as const satisfies Record<TriageReason, string>;

/**
 * THE RESOLVER'S CODE IS THE SOURCE, AND THIS IS THE ONLY TRANSLATION (B1).
 *
 * Total over `RefusalReason`, so a new refusal code cannot be added without
 * deciding what triage calls it. That totality is the whole mechanism: the drift
 * this replaced was triage answering the same question a second way, and the only
 * way to keep two vocabularies honest is to make the compiler refuse an
 * untranslated one.
 *
 * `entry-state-not-captured` maps to `no-capture-for-module` because that is what it
 * is — the resolver could not find the state the row was handed. It is unreachable
 * from triage in practice, since a module with no entry state is answered before any
 * resolution is attempted, and it is mapped anyway rather than thrown on: a reason
 * that cannot be produced costs nothing, and a `throw` in a classifier costs a run.
 */
const TRIAGE_REASON_FOR = {
  'unparseable-step': 'no-readable-target',
  'clause-not-labelled': 'clause-not-labelled',
  'no-readable-action': 'no-readable-action',
  'no-readable-target': 'no-readable-target',
  'ambiguous-target': 'ambiguous-target',
  'target-not-found': 'no-capture-for-element',
  'entry-state-not-captured': 'no-capture-for-module',
  'action-not-supported': 'unsupported-action',
  'assertion-not-supported': 'unverifiable-assertion',
  'column-verb-conflict': 'column-verb-conflict',
  'qualifier-not-supported': 'qualifier-not-supported',
} as const satisfies Record<RefusalReason, TriageReason>;

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
   * What it becomes once every module has been walked — and it is NULL whenever
   * any module has not been (B1).
   *
   * ## Why making the first ceiling honest cost the second one
   *
   * It used to be a measurement rather than an estimate, and the thing that made it
   * one was that BOTH ceilings ran the same clause rules over the same clauses —
   * nothing was extrapolated from the captured modules to the others.
   *
   * `automatable` is now the resolver's verdict, which needs a captured state to
   * resolve against. For the rows this figure is about, that state does not exist.
   * So there are two options and only one of them is honest: keep the old text-only
   * rules for this number, and present two figures measured by different
   * instruments as a comparison; or say it cannot be measured until the screens are
   * walked.
   *
   * The first is the thing §14.4's whole argument forbids, and it is worse than it
   * sounds: the pair exists so the two numbers can be COMPARED, and a comparison
   * between a resolve-based figure and a text-based one is not a comparison of
   * capture coverage at all.
   *
   * So: `null`, with `withAllModulesCapturedWhy` saying so in words. Never 0 — a 0
   * would read as "the ceiling is nothing even with every screen captured", which
   * is a claim nobody has measured.
   */
  withAllModulesCaptured: number | null;
  /**
   * WHY the second ceiling is absent, when it is — never silence, never a 0.
   *
   * `null` here and a number there are the only two shapes, and a reader must be
   * able to tell "we did not measure this" from "we measured it and it is nothing".
   * Three states, three sentences, and this is the third one (`null` + "could not
   * be computed") rather than the second ("computed, and it is 0%").
   *
   * It is `null` when the pair is complete, so a renderer cannot print an
   * explanation for a number that exists.
   */
  withAllModulesCapturedWhy: string | null;
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
 * WORDS IN A CLAUSE THAT NOTHING CONSUMED — a MEASUREMENT, never a gate (P5).
 *
 * The resolver reads a quoted name, a role word, a property word and a verb. Every
 * other word in the clause is read by nothing, and a clause can therefore say
 * something the run silently ignores — *"verify the "Total" is 5"* resolves to the
 * element and drops the number, which is the fail-open shape this repo has corrected
 * five times.
 *
 * Some of those are already refused by name (values, counts, quantifiers, ordinals,
 * scope words, a second quoted name). This counts what is left OVER after all of
 * them, which is the honest residue rather than a restatement of the gates.
 *
 * ## Deliberately not a refusal
 *
 * Making it one would refuse most of a real sheet: English is full of words a parser
 * does not need. The number exists so the decision to build a consumption rule is
 * taken against a measurement — and so the cost of not having one is visible on every
 * report instead of being a paragraph in a design doc.
 */
const CONSUMED_BY_NOTHING_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'can',
  'for',
  'from',
  'has',
  'have',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'should',
  'that',
  'the',
  'then',
  'there',
  'they',
  'this',
  'to',
  'user',
  'users',
  'when',
  'will',
  'with',
  // Read by the resolver itself, so not leftovers.
  'click',
  'clicks',
  'verify',
  'verifies',
  'check',
  'checks',
  'enter',
  'enters',
  'select',
  'selects',
  'visible',
  'invisible',
  'enabled',
  'disabled',
  'checked',
  'present',
  'not',
  'button',
  'buttons',
  'link',
  'links',
  'heading',
  'headings',
  'field',
  'fields',
  'tab',
  'tabs',
  'checkbox',
  'option',
  'options',
  'text',
  'textbox',
  'table',
  'dialog',
  'menu',
]);

export function leftoverWords(clauseText: string): string[] {
  // The quoted name IS consumed, so it is removed before anything else — otherwise
  // every word inside a multi-word element name would count as a leftover.
  const withoutNames = clauseText.replace(/["'`][^"'`]*["'`]/g, ' ');
  return [
    ...new Set(
      withoutNames
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 1 && !CONSUMED_BY_NOTHING_STOP_WORDS.has(word)),
    ),
  ];
}

/** What triage needs in order to answer the run's question rather than its own. */
export interface TriageInputs {
  /**
   * The capture the run resolves against. THE SAME ONE, not an equivalent.
   *
   * A second capture would make `automatable` a claim about a different set of
   * screens than the run's, which is the drift this whole change removes.
   */
  capture: BoundedCapture;
  /**
   * Module -> the entry state its rows resolve against, for the modules the run
   * will actually run.
   *
   * Its `keys()` ARE the answer to "which modules are captured", so there is no
   * second set to disagree with it. A module the run has BLOCKED — unmapped, or
   * mapped with an unprovable anchor — must be absent, and then its rows come back
   * `no-capture-for-module`, which is what the run reports for them too.
   *
   * Built by `entryStateByModule`, the same function `runSheet` uses.
   */
  entryStateOf: ReadonlyMap<string, string>;
}

/**
 * Classifies every row by what stands between it and automation (B1).
 *
 * ## It no longer has an opinion of its own, and that is the point
 *
 * This used to decide `automatable` from its own clause rules — `extractTarget`,
 * shape patterns, a write-word check — none of which the resolver ever saw. The
 * imports were shared so the two could not drift on a VERB, and they drifted on
 * everything else instead: triage never asked whether the named element is in the
 * capture, and never applied the whole-row rule.
 *
 * Measured at the moment that was found: triage reported 27 automatable rows beside
 * the sentence *"these are the rows a run executes"*. The run executed **none** of
 * them — 18 held, 9 refused. The sentence was false in both directions.
 *
 * So for a row whose module is captured, every verdict here comes from
 * `resolveAuthoredRow` — the same call, the same capture, the same entry state.
 * Triage is a PROJECTION of the resolver, and the only thing it still decides for
 * itself is the one question the resolver cannot be asked: a row whose screen has
 * never been walked has no state to resolve against.
 *
 * That removes the drift CLASS rather than this instance of it. There is no second
 * implementation left to diverge.
 */
export function triageSheet(rows: AuthoredRow[], inputs: TriageInputs): TriageResult {
  const triaged: TriagedRow[] = [];
  const missing = new Map<string, number>();
  const modules = new Set<string>();

  for (const row of rows) {
    const module = row.module || '(blank)';
    modules.add(module);
    const title = row.scenarioName || row.objective || row.rowId;
    const base = { rowId: row.rowId, sheetRow: row.sheetRow, module, title };

    const entryState = inputs.entryStateOf.get(module);
    if (entryState === undefined) {
      missing.set(module, (missing.get(module) ?? 0) + 1);
      triaged.push({
        ...base,
        reason: 'no-capture-for-module',
        evidence: `no capture exists for "${module}" — run \`pnpm inspect\` on that screen`,
      });
      continue;
    }

    const resolved = resolveAuthoredRow(row, inputs.capture, entryState);

    /**
     * THE WHOLE-ROW RULE, taken from the resolver rather than restated.
     *
     * `resolveAuthoredRow` returns `steps: []` the moment any clause refuses — a
     * row is all or nothing, because half a row that goes green is a false pass.
     * Reading `refusals.length === 0 && steps.length > 0` is that same rule, and
     * reading it rather than re-deriving it is why the two cannot disagree.
     */
    if (resolved.refusals.length === 0 && resolved.steps.length > 0) {
      const held = resolved.writeRisk === 'creates-data';
      triaged.push({
        ...base,
        reason: held ? 'automatable-but-held' : 'automatable',
        evidence: held
          ? `resolves completely; the write gate holds it${
              resolved.writeRiskWhy ? ` — ${resolved.writeRiskWhy}` : ''
            }`
          : `all ${resolved.steps.length} step(s) resolved against "${entryState}"`,
      });
      continue;
    }

    /**
     * THE FIRST REFUSAL DECIDES, because that is the one the run reports.
     *
     * A row carrying several refusals is told about all of them in its `detail`;
     * the triage table is one line per row and has to pick. Picking the first keeps
     * triage's reason identical to the run's leading cause, which is the agreement
     * being built here — any other choice would make the two tables disagree about
     * the same row for no reader's benefit.
     */
    const first = resolved.refusals[0];
    triaged.push({
      ...base,
      reason: first ? TRIAGE_REASON_FOR[first.why] : 'no-readable-target',
      evidence: first ? first.reason : resolved.summary,
    });
  }

  const counts = Object.fromEntries(
    (Object.keys(TRIAGE_OWNER) as TriageReason[]).map((reason) => [reason, 0]),
  ) as Record<TriageReason, number>;
  for (const row of triaged) counts[row.reason] += 1;

  const total = triaged.length;
  const uncaptured = [...modules].filter((module) => !inputs.entryStateOf.has(module)).length;
  return {
    rows: triaged,
    counts,
    ceiling: {
      withCurrentCaptures: total === 0 ? 0 : counts.automatable / total,
      // NULL, never 0, whenever a module is missing — see the field's own note.
      withAllModulesCaptured: uncaptured > 0 ? null : total === 0 ? 0 : counts.automatable / total,
      withAllModulesCapturedWhy:
        uncaptured > 0
          ? `not measurable: ${counts['no-capture-for-module']} rows have no capture and this ` +
            'figure is now resolve-based'
          : null,
      modulesCaptured: [...modules].filter((module) => inputs.entryStateOf.has(module)).length,
      modulesTotal: modules.size,
      rowsBlockedByMissingCapture: counts['no-capture-for-module'],
    },
    missingCaptures: [...missing]
      .map(([module, rows]) => ({ module, rows }))
      .sort((a, b) => b.rows - a.rows),
  };
}

/**
 * What each reason MEANS and what to DO, both total over the union.
 *
 * Total for the §AE reason: the rendered table is derived from these, so a reason
 * added without a meaning or a remedy does not compile rather than printing a row
 * with a blank cell — or, as happened before, not printing the row at all.
 */
const REASON_MEANING = {
  'no-capture-for-module': 'no capture for this module',
  'no-capture-for-element': 'the named element is not in the capture of that screen',
  'unsupported-action': 'names an action this platform cannot perform',
  'no-readable-action': 'no action could be read out of the clause',
  'unverifiable-assertion': 'claims a state this platform cannot read',
  'qualifier-not-supported': 'names a position or a region',
  'column-verb-conflict': 'the column and the clause’s own verb disagree',
  'clause-not-labelled': 'no Given/When/Then column for this clause',
  'no-readable-target': 'the clause names no element',
  'ambiguous-target': 'the name matches several elements',
  automatable: 'nothing in the way',
  'automatable-but-held': 'resolves completely; the write gate holds it',
} as const satisfies Record<TriageReason, string>;

const REASON_REMEDY = {
  'no-capture-for-module': 'run `pnpm inspect` on that screen',
  'no-capture-for-element': 'walk that screen again — the control was not recorded',
  'unsupported-action': 'ours: the action is on the capability backlog',
  'no-readable-action': 'ours: the grammar has only a click',
  'unverifiable-assertion': 'ours: the property cannot be observed yet',
  'qualifier-not-supported': 'ours: the locator cannot express it',
  'column-verb-conflict': 'rewrite the clause to match its column — runs today',
  'clause-not-labelled': 'put the clause in a Given, When or Then column',
  'no-readable-target': 'name the control in quotes — `clicks the "Save" button`',
  'ambiguous-target': 'say which one is meant',
  automatable: 'these are the rows a run executes',
  'automatable-but-held': 'decide whether to set `ALLOW_WRITES`; nothing is wrong with the row',
} as const satisfies Record<TriageReason, string>;

/**
 * The per-reason section of the report: a heading and the paragraph a reader acts on.
 *
 * TOTAL over every reason that gets a section — which is every reason EXCEPT the two
 * `automatable` ones, whose rows the report lists in its own passed and held
 * sections. `Omit` states that exclusion in the type, so dropping a reason from here
 * is a compile error and not an omission nobody sees.
 */
const REASON_DETAIL = {
  'no-capture-for-module': {
    heading: 'Nobody has captured this screen',
    action:
      'No resolver can do anything with these until someone walks the screen. `pnpm inspect` on that route is the whole fix, and the capture worklist above is ordered by how many rows each screen would recover.',
  },
  'no-capture-for-element': {
    heading: 'The screen is captured and the control is not in it',
    action:
      'NOT the same as having no capture, and the difference decides who acts: the screen has been walked, and the control the clause names was not recorded on it. Either the control appears only after an interaction nobody captured, or the clause names something that is not on that screen. Walking it again is the first thing to try.',
  },
  'unsupported-action': {
    heading: 'An action the platform cannot perform yet',
    action:
      'The sentence is correct and the screen is captured. These name an action with no implementation — a file upload carries no file, a typed value has nowhere to go — so the run REFUSES them rather than clicking a button and reporting a pass. Nothing for the QA to change.',
  },
  'no-readable-action': {
    heading: 'No action could be read out of the clause',
    action:
      'Ours, and distinct from the row above: there, we recognised the verb and cannot perform it, so it goes on a capability backlog. Here nothing recognisable was found at all, and there is nothing to put on one. The grammar has a click and these clauses do not name one.',
  },
  'unverifiable-assertion': {
    heading: 'A state the platform cannot read yet',
    action:
      'The sentence is correct and names a real property of a real element — `empty`, `read-only`, `expanded` — and this platform can only read present, enabled, selected and checked. They are REFUSED rather than turned into "the element exists", which would pass as soon as the element is there. Nothing for the QA to change.',
  },
  'qualifier-not-supported': {
    heading: 'A position or a region the platform cannot address',
    action:
      'The sentence is precise and this platform is not: it addresses an element by role and name, so an ordinal ("the second Edit"), a containing region ("in the row for Jane") or a second quoted name has nowhere to go. Measured against a real browser before these were refused: a clause scoped to one row clicked a DIFFERENT row and reported a pass. Nothing for the QA to change.',
  },
  'column-verb-conflict': {
    heading: 'The column and the sentence disagree',
    action:
      'The Given/When/Then column says one thing and the sentence’s own verb says another — a click in a Then, an assertion verb in a When, or a `checks`/`ticks` clause that names no state to check. The column is never overruled, so these are refused rather than guessed. **These run today once the sentence is rewritten to match its column**, which makes them the fastest rows on this list to recover.',
  },
  'clause-not-labelled': {
    heading: 'The sheet never said what this clause is',
    action:
      'No Given, When or Then column for this clause — usually the second half of an "&"-joined cell where only the first half got a column. The sentence may be perfectly good; nothing has said whether it is something to DO or something to CHECK, and guessing wrong makes a test that passes having verified nothing. **Adding the column is the whole fix.**',
  },
  'no-readable-target': {
    heading: 'The clause names no element',
    action:
      'Nothing in these sentences says what to act on. Measured on this sheet: of the clauses that land here, NONE carries a quoted name the platform failed to read — a quoted name is trusted exactly as written, whatever its shape. **Naming the control in quotes — `clicks the "Save" button` — is the fix, and no parser change reaches these rows.**',
  },
  'ambiguous-target': {
    heading: 'The name matches several elements',
    action:
      'The name in the clause matches more than one control on the captured screen, and picking one would be worse than refusing: the run would go green or red against an element nobody chose, and the row would keep its ambiguity forever because nothing would ever ask. **Say which one is meant** — the refusal names the candidates it found.',
  },
} as const satisfies Record<
  Exclude<TriageReason, 'automatable' | 'automatable-but-held'>,
  { heading: string; action: string }
>;

/** The triage as a report section. Each reason names one audience, never merged. */
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
    // NULL IS PRINTED AS A SENTENCE, NEVER AS A NUMBER AND NEVER AS SILENCE.
    //
    // A `0.0%` here would read as "the ceiling is nothing even with every screen
    // captured", which nobody has measured; omitting the row would quietly turn the
    // pair into the single quotable figure the pair exists to prevent.
    ceiling.withAllModulesCaptured === null
      ? `| **Once every module is captured** | **not measurable** | ` +
        `${ceiling.withAllModulesCapturedWhy} |`
      : `| **Once every module is captured** | **${(ceiling.withAllModulesCaptured * 100).toFixed(1)}%** | ` +
        `all ${ceiling.modulesTotal} sheet module keys, resolved against the capture |`,
    '',
    `${counts.automatable} of ${triage.rows.length} rows resolve completely and would be run. ` +
      `${counts['automatable-but-held']} more resolve completely and are held by the write gate. ` +
      `${ceiling.rowsBlockedByMissingCapture} are blocked only because nobody has captured their ` +
      'screen yet.',
    '',
    '> **The first number is not the ceiling of this approach — it is the ceiling of',
    '> today’s capture coverage.** Quoting it without its qualifier misstates the',
    '> result, which is why the qualifier is in the same row of the same table.',
    '',
    ...(ceiling.withAllModulesCaptured === null
      ? [
          '> **The second number used to be a measurement and is now withheld.** It was',
          '> one because both ceilings ran the same clause rules; `automatable` is now the',
          "> resolver's own verdict, and the rows this figure is about have no captured",
          '> state to resolve against. Keeping the old rules for it would present two',
          '> figures taken with different instruments as a comparison of capture',
          '> coverage, which is not what it would be measuring.',
          '',
        ]
      : []),
    '> This is not a failure. A sheet written for humans legitimately contains',
    '> things only a human can check. Knowing which, and why, is the point.',
    '',
    '| Rows | Why | What a human does |',
    '| ---: | --- | --- |',
    /**
     * EVERY REASON, FROM THE OWNER MAP — never a hand-written subset.
     *
     * Four reasons were listed here and nine existed, so five buckets were counted
     * in `counts`, printed in no table, and read by nobody. That is §AE exactly: a
     * hand-written list beside a derived set, where a missing entry silently drops
     * a row from the only page a QA reads.
     *
     * Driving it off `TRIAGE_OWNER` makes the list derived, so a new reason appears
     * here the moment it is given an owner — and it cannot be added without one.
     */
    ...(Object.keys(TRIAGE_OWNER) as TriageReason[])
      .filter((reason) => counts[reason] > 0)
      .sort((a, b) => counts[b] - counts[a])
      .map(
        (reason) =>
          `| ${counts[reason]} (${pct(counts[reason])}) | ${REASON_MEANING[reason]} | ` +
          `${REASON_REMEDY[reason]} |`,
      ),
    '',
  ];

  /**
   * P5 — the consumption residue, MEASURED and labelled as a measurement.
   *
   * No threshold, no verdict and nothing refuses on it. It is here so the question
   * "should a clause have to be fully consumed?" is decided against a number from
   * this sheet rather than against an intuition, and so the cost of not having that
   * rule is on every report instead of in a design doc.
   */
  // From `evidence` — the clause the triage actually read, verbatim. A `TriagedRow`
  // carries that and not the whole row, which is the honest scope: the measurement is
  // over the text a decision was made from.
  const leftoverPerRow = triage.rows.map((row) => ({
    rowId: row.rowId,
    words: leftoverWords(row.evidence),
  }));
  const rowsWithLeftovers = leftoverPerRow.filter((row) => row.words.length > 0);
  const frequency = new Map<string, number>();
  for (const row of rowsWithLeftovers) {
    for (const word of row.words) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  }
  const commonest = [...frequency]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8);

  lines.push(
    '### Leftover words — a measurement, not a gate',
    '',
    `${rowsWithLeftovers.length} of ${triage.rows.length} row(s) contain words the resolver ` +
      'reads nothing from. It uses a quoted name, a role word, a property word and a verb; ' +
      'everything else is ignored, so a clause can say something a run silently drops.',
    '',
    '> **Nothing refuses on this number.** Values, counts, quantifiers, ordinals, scope words ' +
      'and a second quoted name are already refused by name — this is what is left after all ' +
      'of them, and it is reported so the decision to build a consumption rule is taken ' +
      'against a measurement.',
    '',
    ...(commonest.length > 0
      ? [
          '| Leftover word | Rows |',
          '| --- | ---: |',
          ...commonest.map(([word, count]) => `| \`${word}\` | ${count} |`),
          '',
        ]
      : []),
  );

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

  /**
   * EVERY REASON WITH ROWS GETS A SECTION, derived from the union (§AE).
   *
   * These were seven hand-written `sample(...)` calls beside a nine-member union,
   * so two reasons were counted and never listed. The loop cannot miss one, and
   * `REASON_DETAIL` is total, so a new reason without a paragraph does not compile.
   *
   * `automatable` and `automatable-but-held` are deliberately absent: the report
   * lists the rows a run executed in its own passed/held sections, and repeating
   * them here would be the same rows under two headings.
   */
  for (const reason of Object.keys(REASON_DETAIL) as Array<keyof typeof REASON_DETAIL>) {
    sample(reason, REASON_DETAIL[reason].heading, REASON_DETAIL[reason].action);
  }
  return lines.join('\n');
}
