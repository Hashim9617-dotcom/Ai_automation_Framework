import type { Page } from '@playwright/test';
import type { DomSnapshot } from '@aitp/shared';

export interface SnapshotOptions {
  /** Cap on elements sent to the model — controls prompt size and therefore cost. */
  maxElements?: number;
  /** Skip elements that are not visible; usually what you want. */
  visibleOnly?: boolean;
}

/**
 * "DOM understanding" starts here. Raw HTML is far too large and noisy to hand
 * to an LLM, so we extract a compact, accessibility-first view: role, accessible
 * name, test id, placeholder and state for interactive elements only.
 *
 * This runs with zero LLM calls, which is why it belongs in the Phase 1 foundation —
 * the Phase 2 generator, healer and RCA analyzer all consume this same structure.
 */
export async function captureDomSnapshot(
  page: Page,
  options: SnapshotOptions = {},
): Promise<DomSnapshot> {
  const maxElements = options.maxElements ?? 150;
  const visibleOnly = options.visibleOnly ?? true;

  const elements = await page.evaluate(
    ({ limit, onlyVisible }) => {
      const INTERACTIVE =
        'a[href], button, input, select, textarea, [role], [data-testid], [contenteditable="true"], summary';

      const isVisible = (el: Element): boolean => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        const style = window.getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
      };

      const accessibleName = (el: Element): string | undefined => {
        const aria = el.getAttribute('aria-label');
        if (aria) return aria.trim();
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
          const parts = labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
            .filter(Boolean);
          if (parts.length) return parts.join(' ');
        }
        if (el.id) {
          const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (label?.textContent) return label.textContent.trim();
        }
        const closestLabel = el.closest('label');
        if (closestLabel?.textContent) return closestLabel.textContent.trim();
        const text = (el as HTMLElement).innerText?.trim();
        return text ? text.slice(0, 80) : undefined;
      };

      const implicitRole = (el: Element): string => {
        const explicit = el.getAttribute('role');
        if (explicit) return explicit;
        const tag = el.tagName.toLowerCase();
        if (tag === 'a') return 'link';
        if (tag === 'button') return 'button';
        if (tag === 'select') return 'combobox';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'input') {
          const type = (el as HTMLInputElement).type;
          if (type === 'checkbox') return 'checkbox';
          if (type === 'radio') return 'radio';
          if (type === 'submit' || type === 'button') return 'button';
          return 'textbox';
        }
        return tag;
      };

      const out: Array<Record<string, unknown>> = [];
      const nodes = Array.from(document.querySelectorAll(INTERACTIVE));

      for (const [index, el] of nodes.entries()) {
        if (out.length >= limit) break;
        const visible = isVisible(el);
        if (onlyVisible && !visible) continue;

        out.push({
          ref: `e${index}`,
          role: implicitRole(el),
          name: accessibleName(el),
          tag: el.tagName.toLowerCase(),
          testId:
            el.getAttribute('data-testid') ??
            el.getAttribute('data-test-id') ??
            el.getAttribute('data-qa') ??
            undefined,
          placeholder: el.getAttribute('placeholder') ?? undefined,
          value: (el as HTMLInputElement).value?.slice(0, 60) || undefined,
          visible,
          enabled: !(el as HTMLButtonElement).disabled,
        });
      }
      return out;
    },
    { limit: maxElements, onlyVisible: visibleOnly },
  );

  return {
    url: page.url(),
    title: await page.title(),
    capturedAt: new Date().toISOString(),
    elements: elements as DomSnapshot['elements'],
  };
}

/** Token-cheap textual form of a snapshot, ready to paste into a prompt. */
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
