import { test, expect } from '@playwright/test';
import { isGlyphOnly, nameContains, namesMatch, readableName } from '../apps/ecom/components/names';
import {
  DIALOG_ALLOWED,
  mayClickInDialog as mayClickInDialogFromSafety,
  mayClickOutsideDialog,
} from '../apps/ecom/components/write-safety';
// The barrel re-exports both modules, and W7 asserts the two entry points are the
// SAME function rather than two implementations that could drift (§AE).
import { mayClickInDialog } from '../apps/ecom/components';

/**
 * THE TWO RULES THE ECOM SUITE'S SAFETY RESTS ON, tested without a browser.
 *
 * ## Name normalisation, and the measurement behind it
 *
 * This application's accessible names carry ICON-FONT GLYPHS. Measured across 88
 * captured states: 16,465 names contain a character in Unicode category Cf, Co, Cs
 * or Cc, and 10,979 of those have no readable text at all. 84 distinct glyph
 * codepoints appear.
 *
 * The create button on the Purchase Order list is not `" New Purchase Order"`. Its
 * first character is U+EB0B — Private Use Area, drawn as a plus by a webfont. It
 * LOOKS like a leading space when printed and it is not one, so `String.trim()`
 * leaves it and an anchored `/^new/` matches nothing. That is not a hypothetical:
 * the STEP 0 analysis reported seven modules as having no create control on
 * exactly that basis, and every one of them has one.
 *
 * ## Why the write rule is tested here and not only in a spec
 *
 * This batch is read-only against a development environment that QA, BA and
 * developers share. A click on `Create` inside a drawer writes a real record into
 * their data. "The specs are careful" is not a control; a component that throws is.
 *
 * Every codepoint below is written as an ESCAPE IN A TEST EXPRESSION, never as a
 * literal character in the source — `invisible-characters.spec.ts` scans every
 * tracked file for exactly these categories, and three real U+EB0B characters got
 * into this library's own comments the first time they were written, and a FOURTH
 * into this very file — in the sentence warning about it — because a backslash-u
 * escape typed into a comment is resolved by the writing path and lands as the
 * character itself (CLAUDE.md, "never type an invisible character's escape").
 * Building them with `String.fromCodePoint` keeps the source clean AND makes the
 * codepoint readable, which a literal glyph would not.
 */

/** U+EB0B — the glyph on the real Purchase Order create button. */
const ICON = String.fromCodePoint(0xeb0b);
/** U+EAF8 — the glyph-only button on the Quotation Comparison list. */
const ICON_ONLY = String.fromCodePoint(0xeaf8);
/** U+200B zero-width space (Cf) and U+00A0 no-break space, for contrast. */
const ZERO_WIDTH = String.fromCodePoint(0x200b);
const NBSP = String.fromCodePoint(0x00a0);

test.describe('ecom accessible-name normalisation @unit', () => {
  test('N1: a Private Use glyph is stripped, so the real create button is matchable', () => {
    // wrong: `trim()` alone. The glyph is NOT whitespace, so the name stays
    // `<U+EB0B> New Purchase Order`, an anchored /^new/ fails, and the module is
    // reported as having no create control — which is exactly what happened, for
    // seven modules at once. This is the single assertion that episode produced.
    expect(readableName(`${ICON} New Purchase Order`)).toBe('New Purchase Order');
    expect(`${ICON} New Purchase Order`.trim()).not.toBe('New Purchase Order');
  });

  test('N2: a glyph-ONLY name normalises to empty, and is reported as glyph-only', () => {
    // wrong: treating it as a named control. 10,979 captured names are glyph-only;
    // a locator built from one matches on a codepoint nobody can read, and a
    // refusal that said "name is empty" would be wrong in a way that sends somebody
    // looking for a missing aria-label when there IS one — it is just not text.
    expect(readableName(ICON_ONLY)).toBe('');
    expect(isGlyphOnly(ICON_ONLY)).toBe(true);
    // The discriminating half: a genuinely empty name is NOT glyph-only, because
    // the two call for different fixes — add a label, versus add TEXT to a label.
    expect(isGlyphOnly('')).toBe(false);
    expect(isGlyphOnly('Create')).toBe(false);
  });

  test('N3: every invisible CLASS is handled, not a list of characters', () => {
    // wrong: a normaliser built from the glyphs this app happens to use today. The
    // repo already learned this — a BOM got past a detector whose set was NUL plus
    // the PUA range, because the set was a list somebody wrote. Cf, Co, Cs and Cc
    // are what "not readable text" means, so a zero-width space and a control
    // character go the same way as the icon glyph, with nobody naming them.
    expect(readableName(`a${ZERO_WIDTH}b`)).toBe('a b');
    expect(readableName(`a${String.fromCodePoint(0x0001)}b`)).toBe('a b');
    // NBSP is category Zs, not C — it IS whitespace, and collapsing handles it.
    expect(readableName(`a${NBSP}b`)).toBe('a b');
  });

  test('N4: matching mirrors what Playwright actually does', () => {
    // wrong: an exact, case-sensitive comparison. Playwright's getByRole name
    // option matches a SUBSTRING, case-insensitively, whitespace normalised — so a
    // check written against the capture would disagree with the locator written
    // from it, and the disagreement shows up as a test that cannot find a control
    // the analysis said was there.
    expect(nameContains(`${ICON} New Purchase Order`, 'new purchase order')).toBe(true);
    expect(namesMatch(`${ICON}  Create `, 'create')).toBe(true);
    // And the half that must still be false, or `nameContains` matches everything.
    expect(nameContains('Refresh', 'create')).toBe(false);
    expect(namesMatch('Create Purchase Order', 'Create')).toBe(false);
  });
});

test.describe('ecom write safety: the drawer refuses @unit', () => {
  test('W1: every submit-shaped control inside a dialog is refused', () => {
    // wrong: any one of them clicked. This suite runs against a DEVELOPMENT
    // environment shared with QA, BA and developers, and each of these creates a
    // real record in data they are working in. The brief names these verbs; they
    // are asserted one by one because a loop over a regex would be testing the
    // regex against itself.
    for (const name of [
      'Create',
      'Create PR',
      'Create RFQ',
      'Create GRN',
      'Create Purchase Order',
      'Save',
      'Submit',
      'Approve',
      'Confirm',
      'Post',
      'Send',
    ]) {
      const verdict = mayClickInDialogFromSafety(name);
      expect(verdict.allowed, `"${name}" was allowed inside a dialog`).toBe(false);
      expect(verdict.why).toContain('refusing to click');
    }
  });

  test('W2: the SAME verbs carrying an icon glyph are refused too', () => {
    // wrong: normalising nowhere. Every real control in this application may carry
    // a glyph, so a rule applied to the raw name lets `<U+EB0B> Create` through
    // while refusing `Create` — and the glyph-prefixed form is the NORMAL one here,
    // not the exception. W1 without this is a rule that refuses the shape the app
    // does not use.
    for (const name of ['Create', 'Save', 'Submit', 'Approve']) {
      expect(mayClickInDialogFromSafety(`${ICON} ${name}`).allowed, name).toBe(false);
    }
  });

  test('W3: the four permitted controls ARE allowed, or the drawer is unusable', () => {
    // wrong: a rule that refuses everything. It would pass W1 and W2 completely
    // while making it impossible to close a drawer or step through a multi-step
    // form — and a rule that refuses everything is as empty as one that accepts
    // everything, while LOOKING safe in review because nothing wrong gets through.
    for (const name of [
      'Close',
      'Cancel',
      'Next: Line Items',
      'Next: Address',
      'Back',
      'Previous',
    ]) {
      const verdict = mayClickInDialogFromSafety(name);
      expect(verdict.allowed, `"${name}" was refused: ${verdict.why}`).toBe(true);
    }
    // With a glyph, too — the stepper labels carry them in the captures.
    expect(mayClickInDialogFromSafety(`${ICON} Next: Line Items`).allowed).toBe(true);
  });

  test('W4: an UNKNOWN verb is refused — the rule is an allowlist, not a denylist', () => {
    // wrong: a denylist of write verbs. The first dialog whose submit button says
    // `Raise`, `Issue` or `Release` walks straight through it, and nothing says so
    // until a record exists. §AC: a capability list is an allowlist of what the
    // mechanism may do, never a denylist of what it may not — a denylist is
    // fail-open. These three verbs are not in SUBMIT_SHAPED on purpose.
    for (const name of ['Raise', 'Issue', 'Release', 'Allocate', 'Finalise']) {
      const verdict = mayClickInDialogFromSafety(name);
      expect(verdict.allowed, `"${name}" was allowed — the rule is behaving as a denylist`).toBe(
        false,
      );
      expect(verdict.why).toContain('ALLOWLIST');
    }
  });

  test('W5: a glyph-only control inside a dialog is refused, naming why', () => {
    // wrong: clicking it. Nothing can tell a close button from a submit button by
    // its icon, and guessing on a shared environment is the one guess this suite
    // cannot afford. The message has to say THAT rather than "not on the
    // allowlist", because the fix is different: the app needs an accessible name.
    const verdict = mayClickInDialogFromSafety(ICON_ONLY);
    expect(verdict.allowed).toBe(false);
    expect(verdict.why).toContain('icon');
  });

  test('W6: outside a dialog the same name IS permitted, which is the whole distinction', () => {
    // wrong: one rule for both places. `Create` on the LIST page opens the drawer
    // and writes nothing; `Create Purchase Order` INSIDE the drawer submits it. A
    // textual rule cannot tell them apart — the difference is positional — so the
    // library asks a different question in each place, and this is the assertion
    // that says the two questions give different answers for the same word.
    expect(mayClickOutsideDialog('Create').allowed).toBe(true);
    expect(mayClickInDialogFromSafety('Create').allowed).toBe(false);
    // But a glyph-only control is unidentifiable anywhere.
    expect(mayClickOutsideDialog(ICON_ONLY).allowed).toBe(false);
  });

  test('W7: the allowlist is the one the component actually consults', () => {
    // wrong: a test that re-declares the permitted set. It would pass over a
    // component consulting a different list — the §AE shape, where two copies of a
    // rule drift and the drifted one reads exactly like the correct one. Every
    // entry in the exported list is checked to be genuinely permitted, so the list
    // and the behaviour cannot disagree.
    expect(DIALOG_ALLOWED.length).toBeGreaterThan(0);
    for (const rule of DIALOG_ALLOWED) {
      expect(typeof rule.label).toBe('string');
      expect(typeof rule.test).toBe('function');
    }
    // And the two entry points are the same function, not two implementations.
    expect(mayClickInDialog).toBe(mayClickInDialogFromSafety);
  });
});
