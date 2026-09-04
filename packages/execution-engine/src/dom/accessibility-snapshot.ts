import type { Page } from '@playwright/test';
import type { AccessibilityNode, AccessibilityTreeSnapshot } from '@aitp/shared';
import { sanitizeUrl } from '@aitp/shared';

export interface AccessibilitySnapshotOptions {
  /** Cap on nodes kept — bounds both the LLM prompt and this capture's own cost. */
  maxNodes?: number;
}

interface CdpAxNode {
  nodeId: string;
  ignored: boolean;
  role?: { value?: string };
  name?: { value?: string };
  properties?: Array<{ name: string; value?: { value?: unknown } }>;
}

/**
 * Captures the REAL computed accessibility tree via CDP
 * (`Accessibility.getFullAXTree`) — not the heuristic `accessibleName()`
 * guess `captureDomSnapshot` uses. This is the same technique used by hand
 * to find Findings 5, 6, 10 and 11 (docs/dms-findings.md): a visible label
 * and its computed accessible name can diverge (an icon-font glyph before
 * the text, a name assembled from nested controls), and a heuristic
 * snapshot built from the DOM can't see that divergence — only the browser's
 * own accessibility computation can.
 *
 * Deliberately NOT used for every failure — only for ones that already
 * passed the free, synchronous part of the healing gate
 * (`checkHealingEligibility`). A CDP session per failure is not free; this
 * keeps that cost bounded to the minority of failures where it can matter.
 */
export async function captureAccessibilityTree(
  page: Page,
  options: AccessibilitySnapshotOptions = {},
): Promise<AccessibilityTreeSnapshot> {
  const maxNodes = options.maxNodes ?? 500;

  const client = await page.context().newCDPSession(page);
  try {
    const { nodes } = (await client.send('Accessibility.getFullAXTree' as never)) as {
      nodes: CdpAxNode[];
    };

    const kept: AccessibilityNode[] = [];
    for (const node of nodes) {
      if (kept.length >= maxNodes) break;
      if (node.ignored) continue;
      const role = node.role?.value;
      const name = node.name?.value;
      // Structural nodes (generic, none, StaticText/InlineTextBox fragments)
      // carry no role a locator could ever target — Finding 11's tree-row
      // bug is exactly why raw text fragments matter for understanding a
      // page, but they are noise for candidate matching, which only ever
      // queries role + name.
      if (!role || role === 'none' || role === 'generic' || role === 'InlineTextBox') continue;
      const prop = (wanted: string): unknown =>
        node.properties?.find((p) => p.name === wanted)?.value?.value;

      // `selected`/`expanded`/`checked` are only meaningful on the roles that
      // carry them, and CDP omits them elsewhere — so `undefined` here means
      // "the platform did not report it", which downstream must read as
      // SILENCE rather than `false`. A wizard step's whole contract lives in
      // `selected` (docs/dms-findings.md, Finding 8: the fixed test asserts
      // aria-selected on the Folder tab), so a capture without it cannot
      // ground the one fact that flow turns on.
      const selected = prop('selected');
      const expanded = prop('expanded');
      const checked = prop('checked');
      const level = prop('level');

      kept.push({
        role,
        name: name ?? '',
        enabled: prop('disabled') !== true,
        ...(typeof selected === 'boolean' ? { selected } : {}),
        ...(typeof expanded === 'boolean' ? { expanded } : {}),
        // CDP reports tristate checkboxes as the string "mixed"; only a real
        // boolean is recorded, so "mixed" stays silence rather than becoming
        // a misleading `false`.
        ...(typeof checked === 'boolean' ? { checked } : {}),
        ...(typeof level === 'number' ? { level } : {}),
      });
    }

    return {
      url: sanitizeUrl(page.url()),
      capturedAt: new Date().toISOString(),
      truncated: kept.length >= maxNodes,
      nodes: kept,
    };
  } finally {
    await client.detach().catch(() => {
      // Page may already be closing — nothing to clean up if so.
    });
  }
}
