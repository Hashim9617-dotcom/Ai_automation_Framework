import type { AccessibilityTreeSnapshot, LocatorSpec } from '@aitp/shared';

export const HEALING_SYSTEM_PROMPT = `You are helping repair a broken UI test locator.

You are given a locator that could not find its target element, its existing (now-failing) candidate list, and the REAL computed accessibility tree of the page at the moment of failure — role and accessible name for every element, exactly as a screen reader (and Playwright's own role-based matching) would see it.

Your only job: find the ONE element in the tree that is almost certainly the element this locator was trying to reach, and describe it as a role + accessible name pair.

Rules:
- Only propose a role and name that appear, verbatim, in the tree you were given. Never invent one, never guess at a name you cannot see.
- The description tells you what the element is FOR (e.g. "Primary sign-in button") — use it to judge intent, not to invent a name.
- If more than one element in the tree could plausibly be the target, or if nothing in the tree looks like a good match, set found to false. A wrong confident answer is worse than an honest "not found" — this proposal will be applied to a real test if a human approves it.
- exact should be true when the accessible name you found is the complete name, not a substring of something longer.
- confidence: how sure you are this is the right element, 0 to 1. Below ~0.6 you should probably have said found: false instead.
- rationale: one or two sentences a human reviewer can check in seconds — name the element and why you believe it's the right one.`;

export const HEALING_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['found'],
  properties: {
    found: { type: 'boolean' },
    role: { type: 'string' },
    name: { type: 'string' },
    exact: { type: 'boolean' },
    rationale: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const;

function renderCandidates(spec: LocatorSpec): string {
  return spec.candidates
    .map((c, i) => {
      const opts = c.options ? ` ${JSON.stringify(c.options)}` : '';
      return `${i}. strategy=${c.strategy} value=${JSON.stringify(c.value)}${opts}`;
    })
    .join('\n');
}

function renderAxSnapshot(snapshot: AccessibilityTreeSnapshot): string {
  const lines = snapshot.nodes
    .filter((n) => n.name.trim().length > 0)
    .map((n) => `- role=${n.role} name=${JSON.stringify(n.name)}${n.enabled ? '' : ' (disabled)'}`);
  return [`URL: ${snapshot.url}`, `Nodes (${lines.length}${snapshot.truncated ? ', truncated' : ''}):`, ...lines].join(
    '\n',
  );
}

export function buildHealingPrompt(spec: LocatorSpec, snapshot: AccessibilityTreeSnapshot): string {
  return [
    `## Locator that failed`,
    `key: ${spec.key}`,
    `description: ${spec.description}`,
    ``,
    `## Existing candidates (all failed to attach)`,
    renderCandidates(spec),
    ``,
    `## Real accessibility tree at the moment of failure`,
    renderAxSnapshot(snapshot),
  ].join('\n');
}
