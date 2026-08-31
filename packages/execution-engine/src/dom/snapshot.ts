import type { Page } from '@playwright/test';
import { sanitizeUrl, type DomSnapshot } from '@aitp/shared';

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
 * Zero LLM calls happen here, which is why this lives in the execution engine
 * rather than the AI engine: it is browser work. The generator, healer and RCA
 * analyzer all consume the structure it produces.
 */
export async function captureDomSnapshot(
  page: Page,
  options: SnapshotOptions = {},
): Promise<DomSnapshot> {
  const maxElements = options.maxElements ?? 150;
  const visibleOnly = options.visibleOnly ?? true;

  const elements = await page.evaluate(
    ({ limit, onlyVisible }) => {
      // Bundlers that keep function names (esbuild, which powers tsx) wrap the
      // helpers below in a `__name(...)` call. That helper is defined in the
      // Node module scope, not in the page, so without this shim the whole
      // evaluate fails with "__name is not defined" whenever this file is run
      // through tsx rather than the Playwright test runner.
      const scope = globalThis as unknown as Record<string, unknown>;
      if (typeof scope.__name !== 'function') scope.__name = (fn: unknown) => fn;

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

      // Field values are useful context ("the ID box already had EMP123 in it"),
      // but a password or token value must never reach a report, a prompt or the
      // live event stream. redactSecrets cannot help here — the property is
      // literally called "value" — so it is filtered at the source.
      const SECRET_FIELD = /(pass|pwd|secret|token|otp|cvv|card|ssn|auth)/i;
      const safeValue = (el: Element): string | undefined => {
        const input = el as HTMLInputElement;
        if (typeof input.value !== 'string' || input.value === '') return undefined;
        if (input.type === 'password' || input.type === 'hidden') return undefined;
        const identity = `${input.name ?? ''} ${input.id ?? ''} ${el.getAttribute('data-testid') ?? ''}`;
        if (SECRET_FIELD.test(identity)) return undefined;
        return input.value.slice(0, 60);
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
          value: safeValue(el),
          visible,
          enabled: !(el as HTMLButtonElement).disabled,
        });
      }
      return out;
    },
    { limit: maxElements, onlyVisible: visibleOnly },
  );

  const typedElements = elements as DomSnapshot['elements'];
  return {
    // Credentials and tokens routinely ride in the URL; strip them before this
    // is persisted into run.json and streamed to the dashboard.
    url: sanitizeUrl(page.url()),
    title: await page.title(),
    capturedAt: new Date().toISOString(),
    // The in-page loop breaks the instant it hits `limit`, so reaching the
    // cap exactly is the only signal available here that elements past it
    // were never even considered — not that the page only had this many.
    truncated: typedElements.length >= maxElements,
    elements: typedElements,
  };
}
