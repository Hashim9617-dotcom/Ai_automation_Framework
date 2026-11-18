import { readableName } from './names';

/**
 * WHAT MAY NEVER BE CLICKED INSIDE AN OPEN DIALOG OR DRAWER.
 *
 * ## Why the rule lives here and not only in the specs
 *
 * This batch is read-only against a shared development environment that QA, BA and
 * developers are using. A spec that clicks `Create` inside a drawer writes a real
 * record into their data, and "we wrote the specs carefully" is not a control — it
 * is the thing that holds until somebody adds the thirtieth module at five o'clock.
 *
 * So the refusal is in the COMPONENT. `Drawer.click()` asks this before it touches
 * anything, and throws. A spec cannot opt out, because there is no parameter to
 * opt out with.
 *
 * ## The second layer, and why one is not enough
 *
 * The network guard in the ecom fixture fails a test that sends any non-GET request
 * to the application. That is the backstop, and it catches what this misses — a
 * write triggered by something other than a named button, a form that submits on
 * Enter, an auto-save. But it catches it AFTER the request is sent, which on a
 * shared system is after the damage. This layer is the one that prevents rather
 * than detects, so it comes first and the guard confirms it worked.
 *
 * ## An ALLOWLIST inside the dialog, not a denylist
 *
 * A denylist of forbidden verbs is fail-open: the first dialog whose submit button
 * says `Raise` or `Issue` or `Release` walks straight through it (§AC). So the
 * component permits only the four kinds of control a read-only walk needs —
 * Close, Cancel, a `Next: …` step, and a tab — and refuses everything else by
 * default, naming the verb list separately only to give a BETTER MESSAGE when the
 * refused control is an obvious write.
 */

/**
 * The only controls a read-only walk may click inside an open dialog.
 *
 * `Next: …` is here because the multi-step create forms — GoodsReceipt, Location,
 * PurchaseRequisition, RFQ, SupplierQuotation — only reveal their later fields
 * after a step advance, and stepping forward submits nothing. `Back`/`Previous`
 * likewise. Nothing else is permitted.
 */
export const DIALOG_ALLOWED = [
  { label: 'close', test: (name: string) => /^close$/i.test(name) },
  { label: 'cancel', test: (name: string) => /^cancel$/i.test(name) },
  { label: 'a stepper step', test: (name: string) => /^next\s*:/i.test(name) },
  { label: 'a stepper step back', test: (name: string) => /^(back|previous)$/i.test(name) },
] as const;

/**
 * Verbs that make a refusal MESSAGE sharper. Never the rule itself.
 *
 * The rule is the allowlist above. This list only lets the error say "that is a
 * submit control" instead of "that is not on the allowlist", which is the
 * difference between a reader fixing their spec and a reader widening the
 * allowlist to make the error go away.
 */
const SUBMIT_SHAPED = /^(create|save|submit|approve|confirm|post|send)\b/i;

export interface DialogClickVerdict {
  allowed: boolean;
  /** Why, in words a spec author can act on. Always present. */
  why: string;
}

/**
 * May a control with this accessible name be clicked inside an open dialog?
 *
 * The name is normalised first, because every control in this application may
 * carry an icon glyph — `"<U+EB0B> Create Purchase Order"` must be refused exactly
 * as `"Create Purchase Order"` is, and an un-normalised check would let the
 * glyph-prefixed one through. That is not hypothetical: the glyph prefix is the
 * normal case here, not the exception.
 */
export function mayClickInDialog(rawName: string | null | undefined): DialogClickVerdict {
  const name = readableName(rawName);

  if (name === '') {
    return {
      allowed: false,
      why:
        'refusing to click a control inside a dialog whose accessible name is only an icon ' +
        'glyph (or empty). Nothing can tell a close button from a submit button by its icon, ' +
        'and this run must not write to a shared environment on a guess.',
    };
  }

  const permitted = DIALOG_ALLOWED.find((rule) => rule.test(name));
  if (permitted) return { allowed: true, why: `${permitted.label} is permitted inside a dialog` };

  return {
    allowed: false,
    why:
      `refusing to click "${name}" inside a dialog. ` +
      (SUBMIT_SHAPED.test(name)
        ? 'It is a submit control, and this suite is READ-ONLY against a shared development ' +
          'environment — clicking it would create a real record in data other people are using.'
        : 'Only Close, Cancel, a "Next: …" step and Back are permitted inside a dialog. This is ' +
          'an ALLOWLIST on purpose: a denylist of write verbs is one unfamiliar label — Raise, ' +
          'Issue, Release — away from letting a write through.') +
      '\n  If this control genuinely does not write, add it to DIALOG_ALLOWED with the ' +
      'evidence, rather than widening the rule at the call site.',
  };
}

/**
 * The same question for a control OUTSIDE any dialog — the create TRIGGER.
 *
 * Opening a create form writes nothing; it is the submit inside it that does. So a
 * trigger is permitted, and the distinction is positional rather than textual:
 * `"Create"` on the list page opens the drawer, and `"Create Purchase Order"`
 * inside the drawer submits it. A rule that went by name alone could not tell them
 * apart, which is why `Drawer` asks the in-dialog question and `ModulePage` asks
 * this one.
 */
export function mayClickOutsideDialog(rawName: string | null | undefined): DialogClickVerdict {
  const name = readableName(rawName);
  if (name === '') {
    return {
      allowed: false,
      why:
        'refusing to click a control whose accessible name is only an icon glyph. It cannot be ' +
        'identified, so what it does cannot be known.',
    };
  }
  return {
    allowed: true,
    why: 'outside a dialog, a control opens or filters — it does not submit',
  };
}
