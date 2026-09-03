import type { DomSnapshot } from '@aitp/shared';

/**
 * Turns a snapshot into the compact text the model actually sees. Kept separate
 * from capture (which lives in @aitp/execution-engine) because this is prompt
 * engineering, and it is the knob to turn when prompts get too expensive.
 */
export function renderSnapshotForPrompt(snapshot: DomSnapshot): string {
  const lines = snapshot.elements.map((el) => {
    const parts = [`${el.ref}`, el.role];
    // A clipped name is marked, not silently quoted. The RCA prompt asks the
    // model to "name the element" and to "quote the exact lines", so an
    // unmarked prefix would be reported to a human as the element's real
    // name — and the elements that exceed the cap are exactly the composite
    // ones (a row carrying its children's labels), where the missing tail is
    // what distinguishes one row from another.
    if (el.name) parts.push(`"${el.name}${el.nameTruncated ? '…" (name truncated)' : '"'}`);
    if (el.testId) parts.push(`testid=${el.testId}`);
    if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
    if (!el.enabled) parts.push('(disabled)');
    return `- ${parts.join(' ')}`;
  });
  return [`URL: ${snapshot.url}`, `Title: ${snapshot.title}`, 'Elements:', ...lines].join('\n');
}
