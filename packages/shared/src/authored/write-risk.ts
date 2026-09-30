/**
 * Whether an authored row would change application state.
 *
 * ## Why this is not `assessWriteRisk`
 *
 * Door A's `assessWriteRisk` (`generation/proposal.ts`) has two other production
 * callers and a spec that asserts its exact behaviour. Changing it would change
 * what the generation engine holds, silently, in a commit about the authored path —
 * so the authored path gets its own function and Door A's is untouched. Measured
 * before deciding: `resolver.ts:312` and `proposal.ts:263` both call it, plus
 * `tests/unit/generation-proposal.spec.ts`.
 *
 * ## What it reads, and what it deliberately does not
 *
 * **ACTION clauses and their resolved targets. Not Then clauses, not the title.**
 * The old version read every clause and `scenarioName`, so a pure assertion held
 * the whole row: measured, `verify the record was created successfully` in a Then
 * column, and a `scenarioName` of "employee is created", both produced `held` for
 * rows that only read. On the real sheet `scenarioName` is routinely phrased that
 * way, so that reach was a large and invisible source of false holds — invisible
 * because it cannot be seen in any count of controls.
 *
 * ## Three rules, in the order their evidence is strongest
 *
 * 1. **The resolved ROLE.** A checkbox, radio, switch or option changes state when
 *    clicked, whatever it is called. This is the only rule here that is structural
 *    — the role comes from the capture, not from a list — and it is the one a new
 *    label cannot defeat. Measured on the local DMS captures: 42 of 391 distinct
 *    controls are state-toggling roles, and the old gate allowed every one.
 * 2. **A CONFIRMATION name.** `Yes`, `OK`, `Proceed`, `Continue` commit whatever
 *    the dialog asked. `Confirm` was in the old list and these were not, so a
 *    two-step delete — trash icon, then Yes — had both steps allowed.
 * 3. **A write WORD.** The widened list. This is the weakest of the three and is
 *    ordered last on purpose: it is a hand-written list, and the honest claim about
 *    it is "23 named misses closed", never "0 missed" (`docs/phase-2-generation.md`
 *    §AH).
 */

/**
 * Roles whose CLICK changes state, whatever the control is called.
 *
 * Not a list of names — a list of ARIA roles, read off the resolved target. The
 * distinction is the whole value: every other fail-open finding this month was a
 * word list, and a role cannot be defeated by an unfamiliar label.
 *
 * `option` is included. Clicking an option in a listbox selects it, which is a
 * state change on the control even when nothing is persisted until a later Save —
 * and "nothing is persisted yet" is exactly the reasoning that let `Edit` and the
 * confirmation step through.
 */
export const STATE_TOGGLING_ROLES: ReadonlySet<string> = new Set([
  'checkbox',
  'radio',
  'switch',
  'option',
  'menuitemcheckbox',
  'menuitemradio',
]);

/**
 * Names that COMMIT whatever a dialog asked. Exact match, not a substring.
 *
 * Exact on purpose: a button called "Yes, delete everything" is caught by the word
 * list, and one called "Okay then" is not a confirmation control. A substring rule
 * here would match "Yesterday" and "Bookmark".
 */
const CONFIRMATION_NAMES = /^(yes|ok|okay|confirm|confirmed|proceed|continue|accept|agree)$/i;

/**
 * Write words, widened from 15 stems to close the 23 misses the audit named.
 *
 * ## Every stem's decision, because a stem is a judgement and not a fact
 *
 * | stem | held | the read-only word it must NOT catch |
 * | --- | --- | --- |
 * | `adds?`/`adding` | yes | **anchored** — `\badd` matched "Address" and "Additional", both FALSE HOLDS on today's list |
 * | `new\b`/`newly` | yes | **anchored** — `\bnew` matched "News" and "Newest first" |
 * | `sign` | yes | `Sign in`, `Sign out`, `Sign up` excluded by lookahead; `Signature` still held, which is the safe side |
 * | `clear` | yes | `Clear filter`, `Clear search`, `Clear all` excluded — they reset a VIEW |
 * | `reset` | yes | `Reset filter(s)`, `Reset search`, `Reset view` excluded; `Reset password` held |
 * | `copy` | yes | held even for `Copy to clipboard`. A named clipboard control is rare and duplicating a record is not |
 * | `generat` | yes | held. Generate usually persists something; `Export` is the read-only sibling and is allowed |
 * | `complet`, `share`, `lock`/`unlock`, `send`, `approv`/`reject`, `assign`, `revok`, `grant`, `activat`/`deactivat`, `import`, `mov` | yes | none found |
 * | `edit` | yes, UNANCHORED | **a declared known false hold.** `Edit` only opens a form, and `Editor` is caught too. Narrowing it would drop `edited`/`editing`, so v1 keeps the false hold and records it |
 *
 * `export` is deliberately ABSENT: it is treated as a read. See the decision and
 * its reason in `docs/WHERE-WE-ARE.md`.
 *
 * **`attach` and `detach` are deliberately ABSENT too, and that was a correction.**
 * They were in the first draft — attaching a file plainly writes — and adding them
 * flipped `UP_001` in the demo run's pre-registered table from `refused` to `held`,
 * plus five tests in `upload-not-supported.spec.ts`. The finding underneath is that
 * an attach clause is ALREADY refused at resolve, by `actionCapability`: the word
 * bought no safety and cost the better message. `refused: action-not-supported`
 * tells a QA the platform cannot do uploads; `held` tells them it would write,
 * which is true and useless. The pre-registration held and nothing was edited to
 * match a run.
 */
const AUTHORED_WRITE_WORDS = new RegExp(
  [
    // the original fifteen, with `add` and `new` anchored
    'creat',
    'delet',
    'remov',
    'sav(e|ing)',
    'submit',
    'upload',
    'archiv',
    'restor',
    'renam',
    'edit',
    'updat',
    'adds?\\b',
    'adding',
    'new\\b',
    'newly',
    'confirm',
    'publish',
    // the 23 named misses and their kin
    'approv',
    'reject',
    'assign',
    'revok',
    'grant',
    'deny',
    'send',
    'shar(e|ing)',
    'mov(e|ing)',
    'copy|copies|copying',
    'lock',
    'unlock',
    'activat',
    'deactivat',
    'enabl',
    'disabl',
    'import',
    'complet',
    'releas',
    'withdraw',
    'transfer',
    'merg',
    'split',
    'generat',
    'issu',
    'commit',
    'declin',
    'trash',
    'discard',
    'purge',
    'void',
    'reassign',
    'forward',
    // guarded stems: the write sense only
    'sign(?! ?(in|out|up|ed in|ed out))',
    'clear(?! ?(filter|search|all|selection))',
    'reset(?! ?(filter|search|view|form|zoom))',
  ].join('|'),
  'i',
);

export interface AuthoredWriteRiskInput {
  /** The row's ACTION clauses, verbatim. Then clauses and the title are excluded. */
  actionClauses: readonly string[];
  /** The target each action step resolved to, when it resolved. */
  targets: ReadonlyArray<{ role: string; name: string }>;
}

export interface AuthoredWriteRisk {
  risk: 'read-only' | 'creates-data';
  /**
   * WHY it was held, in words a QA can act on. Absent for `read-only`.
   *
   * The three rules are not interchangeable to a reader: a checkbox held by its
   * ROLE cannot be rephrased, and a button held by the word "Approve" in its label
   * might be a row about a read-only screen. One sentence for all three would tell
   * neither group what to do, which is why `failed` and `refused` are separate
   * statuses too.
   */
  why?: string;
}

/**
 * ANY action clause that writes holds the WHOLE row. No partial run.
 *
 * A row is one scenario. Running its first two steps and stopping at the third
 * leaves the application in a state nobody described, and reports a row that
 * neither passed nor was cleanly held. The invariant that falls out is checkable:
 * a held row has `stepsRun === 0`.
 */
export function assessAuthoredWriteRisk(input: AuthoredWriteRiskInput): AuthoredWriteRisk {
  // 1. THE ROLE. Structural, and first because it is the rule no label can defeat.
  const toggling = input.targets.find((target) => STATE_TOGGLING_ROLES.has(target.role));
  if (toggling) {
    return {
      risk: 'creates-data',
      why:
        `clicking a ${toggling.role} changes state — "${toggling.name}" is a ` +
        `${toggling.role}, and a click on one is a write whatever it is called`,
    };
  }

  // 2. A CONFIRMATION name, exact.
  const confirming = input.targets.find((target) => CONFIRMATION_NAMES.test(target.name.trim()));
  if (confirming) {
    return {
      risk: 'creates-data',
      why:
        `"${confirming.name}" is a confirmation control: it commits whatever the ` +
        'previous step asked for, and this platform cannot see what that was',
    };
  }

  // 3. A WRITE WORD, in the clause or in the resolved name. The weakest rule, last.
  for (const text of [...input.actionClauses, ...input.targets.map((t) => t.name)]) {
    const hit = AUTHORED_WRITE_WORDS.exec(text);
    if (hit) {
      return {
        risk: 'creates-data',
        why: `"${hit[0].toLowerCase()}" is a word that indicates a change to stored data`,
      };
    }
  }

  return { risk: 'read-only' };
}
