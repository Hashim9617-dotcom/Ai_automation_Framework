import type { DomSnapshot } from '@aitp/shared';

/**
 * Turns a snapshot into the compact text the model actually sees. Kept separate
 * from capture (which lives in @aitp/execution-engine) because this is prompt
 * engineering, and it is the knob to turn when prompts get too expensive.
 */
export function renderSnapshotForPrompt(snapshot: DomSnapshot): string {
  const lines = snapshot.elements.map((el) => {
    const parts = [`${el.ref}`, el.role];
    if (el.name) parts.push(`"${el.name}"`);
    if (el.testId) parts.push(`testid=${el.testId}`);
    if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
    if (!el.enabled) parts.push('(disabled)');
    return `- ${parts.join(' ')}`;
  });
  return [`URL: ${snapshot.url}`, `Title: ${snapshot.title}`, 'Elements:', ...lines].join('\n');
}
