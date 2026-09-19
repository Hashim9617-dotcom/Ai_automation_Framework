import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { findRepoRoot } from '@aitp/shared';

/**
 * The execute path cannot reach an LLM.
 *
 * This is what replaced E8. Until 2026-09-19 the promise "healing may propose,
 * it may never substitute" was held by a FIELD — a proposal recorded beside a
 * row's verdict, which the status computation was careful not to read. A field
 * can be read by the next person to touch the file; an architecture cannot.
 *
 * So the field is gone, the executor has no healer hook, and the promise is now
 * a consequence of where the LLM is not: a proposal about a door B row can only
 * come from a pass that runs AFTER the verdicts are written, and a pass that
 * runs afterwards cannot change one.
 *
 * **Why this is a source scan and not a call counter.** "Zero gateway calls
 * during executeAuthoredRows" is the easy test to write and it would pass
 * vacuously — the counter counts nothing because nothing can call it, which is
 * `expect.every()` over an empty array wearing different clothes. A scan asks a
 * question that can actually come out the other way.
 *
 * **What it covers:** the plausible edit — an import, a gateway construction, a
 * `complete()`/`completeJson()` call, or a raw network call appearing in one of
 * these files.
 *
 * **What it does not cover:** an exotic reach this token list does not name —
 * a dynamic import assembled at runtime, a call through a helper in another
 * package that is itself innocent-looking. It is a list of plausible reads, not
 * a proof of purity, stated plainly so nobody takes more from a green run than
 * is in it.
 */

const ROOT = findRepoRoot();

/** Every file that runs between "rows resolved" and "verdicts written". */
const EXECUTE_PATH = [
  'packages/shared/src/authored/execute.ts',
  'packages/shared/src/authored/report.ts',
  'packages/shared/src/authored/resolve-authored.ts',
  'packages/shared/src/authored/module-map.ts',
  'packages/execution-engine/src/authored/playwright-executor.ts',
];

/** Ways an LLM enters a file. Comments are stripped before this is applied. */
const LLM_TOKENS = [
  'LlmGateway',
  'createLlmGateway',
  'HttpLlmGateway',
  'MockLlmGateway',
  'ai-engine',
  'completeJson',
  '.complete(',
  'anthropic',
  'openai',
  'fetch(',
];

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

test.describe('nothing in the execute path can reach an LLM @unit', () => {
  test('the scan reads real files and its detector fires on a planted call', () => {
    // wrong: with a mistyped path or a token list that matches nothing, the
    // scan below reports clean over zero bytes — green, permanently, about
    // files it never opened.
    //
    // Asserts its own effect twice. A scan over zero files reports clean
    // forever, and a detector that matches nothing does the same more quietly.
    const sizes = EXECUTE_PATH.map(
      (file) => stripComments(readFileSync(path.join(ROOT, file), 'utf8')).length,
    );
    expect(sizes.length).toBe(EXECUTE_PATH.length);
    for (const [index, size] of sizes.entries()) {
      expect(size, `${EXECUTE_PATH[index]} read as empty`).toBeGreaterThan(400);
    }

    const planted = stripComments(
      "import { createLlmGateway } from '@aitp/ai-engine'; // a comment naming ai-engine\n",
    );
    // Three, not two: `LlmGateway` is a substring of `createLlmGateway`, so the
    // list overlaps itself. Written out rather than loosened — the point is
    // that the detector fires, and knowing exactly what it fires on.
    expect(LLM_TOKENS.filter((token) => planted.includes(token))).toEqual([
      'LlmGateway',
      'createLlmGateway',
      'ai-engine',
    ]);
    // And the comment really was stripped, so a file may still EXPLAIN the rule.
    expect(stripComments('// createLlmGateway\n')).not.toContain('createLlmGateway');
  });

  test('no file in the execute path names an LLM in its CODE', () => {
    // wrong: a gateway call lands in the execute path, a proposal is produced
    // while a row's verdict is still being decided, and "propose, never
    // substitute" becomes a rule someone has to remember again — which is
    // exactly the arrangement this replaced.
    const hits: string[] = [];
    for (const file of EXECUTE_PATH) {
      const code = stripComments(readFileSync(path.join(ROOT, file), 'utf8'));
      for (const token of LLM_TOKENS) {
        if (code.includes(token)) hits.push(`${file}: ${token}`);
      }
    }

    expect(hits).toEqual([]);
  });

  test('the executor offers no hook a healer could be passed through', () => {
    // wrong: the callback is gone from the code but its option survives on the
    // type, so the next caller wires one up and the promise is a field again.
    const executor = readFileSync(
      path.join(ROOT, 'packages/execution-engine/src/authored/playwright-executor.ts'),
      'utf8',
    );

    expect(executor).not.toContain('proposeHealing');
    expect(executor).not.toContain('healingProposal');
    // Discriminating: the file is still the executor, so this is not passing
    // because the path was renamed out from under the test.
    expect(executor).toContain('target-not-on-page');
  });
});
