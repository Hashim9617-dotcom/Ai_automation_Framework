import { affordanceOf } from '../a11y/addressability';
import type { ProposalAssertion, TestCaseProposal } from './proposal';
import { approvedForEmission, type ReviewableProposal } from './review';

/**
 * Emitting an approved proposal as a Playwright spec.
 *
 * Four rules, and each has a falsifier.
 *
 * 1. **Only APPROVED, OBSERVED assertions are emitted.** Both gates: approval is
 *    the human's, `observed` is the evidence's.
 * 2. **An assertion whose target is not CONTROL-addressable is REFUSED.** Not
 *    warned about, not emitted with a comment — refused, naming the row. See
 *    §M.2: `getByRole` cannot reach a text node, and a spec that tries produces
 *    a red test the application is not responsible for.
 * 3. **A title is a STRING, never an identifier.** Proposal text is untrusted
 *    output derived from untrusted input, so nothing here interpolates it into a
 *    path, a shell argument, or code. It is JSON-escaped into a string literal.
 * 4. **The writer asserts its own effect.** A file is re-read and checked
 *    against what was intended before success is reported.
 */

/** Why an approved assertion could not be turned into a step. */
export type EmitRefusalReason =
  /** The target is page text or tree scaffolding — `getByRole` cannot reach it. */
  | 'target-not-control-addressable'
  /** The assertion was graded against no state, so there is nothing to open. */
  | 'no-state-to-enter';

export interface EmitRefusal {
  assertionId: string;
  why: EmitRefusalReason;
  /** The claim, verbatim, so a human can see what was dropped and why. */
  claim: string;
  reason: string;
}

export interface EmittedSpec {
  /** Relative path the caller should write to. Never derived from model text. */
  fileName: string;
  source: string;
  emitted: ProposalAssertion[];
  refusals: EmitRefusal[];
}

/** A JS string literal. `JSON.stringify` escapes quotes, newlines and U+2028/9. */
const literal = (value: string): string => JSON.stringify(value);

/**
 * The file name, built from the proposal's ID and nothing else.
 *
 * **Never from the title.** A title is model output derived from capture
 * content, so a case called `../../../etc/passwd` or one carrying a newline is
 * reachable by anyone who can name a document in the application under test.
 * The id is ours.
 */
export function specFileName(proposal: TestCaseProposal): string {
  const safe = proposal.id.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
  if (safe.length === 0) throw new Error('the proposal id yields no safe file name — refusing to emit');
  return `generated-${safe}.spec.ts`;
}

/**
 * Turns the approved half of a reviewed proposal into a spec.
 *
 * Refuses rather than degrades: an assertion that cannot be expressed is
 * returned in `refusals` and does not appear in `source`. Emitting it with a
 * `// TODO` comment would be worse than refusing, because a spec that compiles
 * and asserts nothing reads as coverage.
 */
export function emitSpec(review: ReviewableProposal): EmittedSpec {
  const approved = approvedForEmission(review);
  const emitted: ProposalAssertion[] = [];
  const refusals: EmitRefusal[] = [];

  for (const assertion of approved) {
    const claim =
      `${assertion.claim.role} "${assertion.claim.name}" ` +
      `${assertion.claim.property}=${assertion.claim.expected}`;

    // RULE 2. The affordance type makes this checkable rather than a judgement
    // call — which is the whole reason it is a type (§M.2).
    if (affordanceOf(assertion.claim.role) !== 'control') {
      refusals.push({
        assertionId: assertion.assertionId,
        why: 'target-not-control-addressable',
        claim,
        reason:
          `"${assertion.claim.role}" is ${affordanceOf(assertion.claim.role)}, not a control — ` +
          'getByRole cannot address it, so this assertion cannot become a step. ' +
          'A text target needs a getByText step, which this emitter does not yet write.',
      });
      continue;
    }

    if (!assertion.claim.stateId) {
      refusals.push({
        assertionId: assertion.assertionId,
        why: 'no-state-to-enter',
        claim,
        reason:
          'this assertion was graded with an unknown state cursor, so there is no captured ' +
          'state to navigate to before checking it.',
      });
      continue;
    }

    emitted.push(assertion);
  }

  const { proposal } = review;
  const body = emitted.map((assertion) => {
    const { role, name, property, expected } = assertion.claim;
    const locator = `page.getByRole(${literal(role)}, { name: ${literal(name)}, exact: true })`;
    const matcher =
      property === 'present'
        ? expected ? 'toBeVisible()' : 'not.toBeVisible()'
        : property === 'enabled'
          ? expected ? 'toBeEnabled()' : 'toBeDisabled()'
          : `toHaveAttribute('aria-selected', ${literal(String(expected))})`;
    return [
      `    // ${assertion.assertionId} — grade ${assertion.grade} (${assertion.why})`,
      `    await expect(${locator}).${matcher};`,
    ].join('\n');
  });

  const source = [
    '// GENERATED by the proposal reviewer. Do not edit by hand.',
    '//',
    `// proposal   ${proposal.id}`,
    `// command    ${literal(proposal.sourceCommand)}`,
    `// model      ${literal(proposal.model)}`,
    `// capture    ${proposal.provenance.captureDigest}`,
    `// prompt     ${proposal.provenance.promptVersion}`,
    '//',
    `// ${emitted.length} approved assertion(s) emitted; ${refusals.length} refused.`,
    "import { test, expect } from '@playwright/test';",
    '',
    // The title is a STRING LITERAL, escaped. Rule 3.
    `test(${literal(proposal.title)}, async ({ page }) => {`,
    ...body,
    '});',
    '',
  ].join('\n');

  return { fileName: specFileName(proposal), source, emitted, refusals };
}

/**
 * Verifies an emitted spec after it lands on disk.
 *
 * Rule 4, and the reason it is a separate exported function rather than an
 * inline block: a guard inside the writer has no falsifier — no input makes the
 * generator legitimately omit an assertion, so nothing could ever make it fire.
 * Extracted, a test can hand it a file with a line deleted. That exact mistake
 * was found and fixed once already in door B's report writer.
 *
 * Reads the argument rather than the string it meant to write, so a truncated or
 * failed write is caught rather than assumed away.
 */
export function verifyEmittedSpec(landed: string, spec: EmittedSpec): void {
  if (landed.trim().length === 0) {
    throw new Error(`the emitted spec ${spec.fileName} is empty after writing.`);
  }

  const missing = spec.emitted.filter((assertion) => !landed.includes(assertion.assertionId));
  if (missing.length > 0) {
    throw new Error(
      `the emitted spec ${spec.fileName} is missing ${missing.length} of ${spec.emitted.length} ` +
        `approved assertion(s): ${missing.map((a) => a.assertionId).join(', ')}. ` +
        'An assertion a human approved that does not appear in the file is the failure this checks for.',
    );
  }

  // The inverse, and it matters as much: a REFUSED assertion appearing in the
  // file would be an unreviewed claim emitted as a test.
  const leaked = spec.refusals.filter((refusal) => landed.includes(refusal.assertionId));
  if (leaked.length > 0) {
    throw new Error(
      `the emitted spec ${spec.fileName} contains ${leaked.length} REFUSED assertion(s): ` +
        `${leaked.map((r) => r.assertionId).join(', ')}. A refused assertion in an emitted file ` +
        'is a claim nobody approved being run as a test.',
    );
  }
}
