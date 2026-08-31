import { PlatformError } from '@aitp/shared';
import type { ScriptGenerator, TestCaseGenerator } from '@aitp/shared';

/**
 * Phase 2, still pending.
 *
 * Root cause analysis has shipped — see ./rca/analyzer. Self-healing has
 * shipped too — see ./healing/engine (docs/phase-2-healing.md for the
 * design). These two remain: replacing a class below with a working
 * implementation requires no change at any call site, which is the whole
 * point of having defined the contracts in Phase 1.
 */
export class NotImplementedYetError extends PlatformError {
  constructor(capability: string) {
    super(
      `${capability} arrives in Phase 2 (AI layer). The interface is stable — implement it in packages/ai-engine and register it in the engine factory.`,
      'NOT_IMPLEMENTED_YET',
      { capability },
    );
  }
}

export class PendingTestCaseGenerator implements TestCaseGenerator {
  generate(): never {
    throw new NotImplementedYetError('AI test-case generation');
  }
}

export class PendingScriptGenerator implements ScriptGenerator {
  compile(): never {
    throw new NotImplementedYetError('AI Playwright-script generation');
  }
}
