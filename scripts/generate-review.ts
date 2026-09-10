#!/usr/bin/env node
/**
 * Review generated proposals, and emit the approved ones.
 *
 *   pnpm generate:review                     # list what is waiting
 *   pnpm generate:review <proposal-id>       # render one for reading
 *   pnpm generate:review <id> --approve <assertionId> --reviewer <name>
 *   pnpm generate:review <id> --emit
 *
 * Proposals live in `artifacts/generated/`, decisions beside them in
 * `<id>.decisions.json`, and emitted specs in `artifacts/generated/emitted/` —
 * **never in `tests/`**. Nothing here writes into the test suite; moving a spec
 * across is a human's deliberate act.
 *
 * The rules this obeys are in `docs/phase-2-generation.md` §N:
 *
 * - approval is per assertion and lapses when the assertion's basis moves;
 * - only APPROVED and OBSERVED assertions are emitted;
 * - an assertion whose target is not control-addressable is refused, not
 *   emitted with a placeholder;
 * - the writer verifies what landed, both ways, before reporting success.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  emitSpec,
  findRepoRoot,
  renderReview,
  reviewProposal,
  claimKeyOf,
  verifyEmittedSpec,
  type AssertionApproval,
  type TestCaseProposal,
} from '@aitp/shared';

const argOf = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  return index > 0 ? process.argv[index + 1] : undefined;
};

const dirs = (root: string) => ({
  proposals: path.join(root, 'artifacts', 'generated'),
  emitted: path.join(root, 'artifacts', 'generated', 'emitted'),
});

function loadProposal(dir: string, id: string): TestCaseProposal {
  const file = path.join(dir, `${id}.json`);
  if (!existsSync(file)) throw new Error(`no proposal ${id} in ${dir}`);
  return JSON.parse(readFileSync(file, 'utf8')) as TestCaseProposal;
}

function loadDecisions(dir: string, id: string): AssertionApproval[] {
  const file = path.join(dir, `${id}.decisions.json`);
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, 'utf8')) as AssertionApproval[];
}

function saveDecisions(dir: string, id: string, decisions: AssertionApproval[]): void {
  writeFileSync(path.join(dir, `${id}.decisions.json`), JSON.stringify(decisions, null, 2), 'utf8');
}

function main(): void {
  const root = findRepoRoot();
  const { proposals: proposalDir, emitted: emittedDir } = dirs(root);
  const id = process.argv[2]?.startsWith('--') ? undefined : process.argv[2];

  if (!existsSync(proposalDir)) {
    console.log(`nothing to review — ${proposalDir} does not exist yet.`);
    return;
  }

  if (!id) {
    const files = readdirSync(proposalDir).filter(
      (f) => f.endsWith('.json') && !f.endsWith('.decisions.json'),
    );
    if (files.length === 0) {
      console.log('nothing to review.');
      return;
    }
    console.log(`${files.length} proposal(s) awaiting review:\n`);
    for (const file of files) {
      const proposalId = file.replace(/\.json$/, '');
      const review = reviewProposal(
        loadProposal(proposalDir, proposalId),
        loadDecisions(proposalDir, proposalId),
      );
      console.log(
        `  ${proposalId.padEnd(20)} ${String(review.approvedCount).padStart(2)} approved, ` +
          `${String(review.lapsedCount).padStart(2)} lapsed, ` +
          `${String(review.assertions.length).padStart(2)} assertion(s), ` +
          `${String(review.modelQuestions.length).padStart(2)} question(s)  ` +
          `${review.emittable ? '[emittable]' : ''}`,
      );
    }
    return;
  }

  const proposal = loadProposal(proposalDir, id);
  let decisions = loadDecisions(proposalDir, id);

  const approve = argOf('--approve');
  const reject = argOf('--reject');
  const target = approve ?? reject;
  if (target) {
    const reviewer = argOf('--reviewer');
    // A decision without a named reviewer is not a decision. Never defaulted to
    // a service account or to $USER — approval is a person's signature.
    if (!reviewer) throw new Error('--reviewer <name> is required to record a decision');
    if (!proposal.assertions.some((a) => a.assertionId === target)) {
      throw new Error(`assertion ${target} is not in proposal ${id}`);
    }
    const assertion = proposal.assertions.find((a) => a.assertionId === target)!;
    decisions = [
      ...decisions.filter((d) => d.assertionId !== target),
      {
        assertionId: target,
        decision: approve ? 'approved' : 'rejected',
        reviewer,
        decidedAt: new Date().toISOString(),
        claimKey: claimKeyOf(assertion),
      },
    ];
    saveDecisions(proposalDir, id, decisions);
    console.log(`recorded: ${reviewer} ${approve ? 'approved' : 'rejected'} ${target}\n`);
  }

  const review = reviewProposal(proposal, decisions);

  if (process.argv.includes('--emit')) {
    if (!review.emittable) {
      throw new Error(
        `proposal ${id} is not emittable: ${review.approvedCount} approved, ` +
          `${review.lapsedCount} lapsed. A lapse blocks the whole proposal.`,
      );
    }
    const spec = emitSpec(review);
    if (spec.emitted.length === 0) {
      throw new Error(
        `proposal ${id} produced no emittable steps — ${spec.refusals.length} refused. ` +
          'Refusing to write an empty spec, which would read as coverage.',
      );
    }
    mkdirSync(emittedDir, { recursive: true });
    const file = path.join(emittedDir, spec.fileName);
    writeFileSync(file, spec.source, 'utf8');

    // The writer asserts its own effect, against the FILE rather than the
    // string it meant to write.
    verifyEmittedSpec(readFileSync(file, 'utf8'), spec);

    console.log(`emitted ${spec.emitted.length} assertion(s) to ${file}`);
    for (const refusal of spec.refusals) {
      console.log(`  REFUSED ${refusal.assertionId} (${refusal.why}) — ${refusal.claim}`);
      console.log(`          ${refusal.reason}`);
    }
    console.log('\nThis file is NOT in tests/. Moving it there is a deliberate human act.');
    return;
  }

  console.log(renderReview(review));
}

try {
  main();
} catch (error) {
  console.error(`generate:review failed: ${(error as Error).message}`);
  process.exit(1);
}
