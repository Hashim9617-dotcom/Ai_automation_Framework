/**
 * ACCESSIBLE NAMES IN THIS APPLICATION CARRY ICON-FONT GLYPHS.
 *
 * ## The measurement
 *
 * Of the accessible names in the Ecom captures, **16,465 contain a character in
 * Unicode category Cf, Co, Cs or Cc**, and **10,979 of those have no readable text
 * at all** — they are a single icon glyph. 84 distinct glyph codepoints appear,
 * led by U+EB41, U+EB04, U+EAFF.
 *
 * The create button on the Purchase Order list is not `" New Purchase Order"`. It
 * is `"<U+EB0B> New Purchase Order"` — U+EB0B is a Private Use Area codepoint that a
 * webfont draws as a plus sign. It looks like a leading space when printed and it
 * is not one, so `String.trim()` leaves it in place.
 *
 * ## Why this module exists rather than a `.trim()` at each call site
 *
 * The STEP 0 analysis reported SEVEN modules as having no create control, because
 * it tested `/^(create|new|add)/` against the trimmed name. Every one of those
 * modules has a create control; the regex was anchored in front of a glyph. A
 * normalisation that is remembered at each call site will be forgotten at one of
 * them, and the symptom is a locator that silently matches nothing.
 *
 * ## The definition is STRUCTURAL, not a list
 *
 * `invisible-characters.spec.ts` earned this rule already: a detector built from a
 * list of bad characters is bounded by the imagination of whoever wrote the list,
 * and U+FEFF got through one. Categories Cf (format), Co (private use), Cs
 * (surrogate) and Cc (control) are what "not readable text" means, and they cover
 * all 84 of this application's glyphs without anybody naming one.
 */

/** Cf, Co, Cs, Cc — every character class that is not readable text. */
const NON_TEXT = /[\p{Cf}\p{Co}\p{Cs}\p{Cc}]/gu;

/**
 * What a human reads: glyphs removed, whitespace collapsed, ends trimmed.
 *
 * A glyph becomes a SPACE rather than nothing, so `"<U+EB0B>Create"` — were the app
 * ever to render an icon with no separating space — reads as `"Create"` and not as
 * a word glued to the glyph's neighbour. Collapsing afterwards makes the two cases
 * identical, which is what lets one expected string match both.
 */
export function readableName(name: string | null | undefined): string {
  return (name ?? '').replace(NON_TEXT, ' ').replace(/\s+/g, ' ').trim();
}

/** True when a name is only icons — no text a person could read or type. */
export function isGlyphOnly(name: string | null | undefined): boolean {
  const raw = name ?? '';
  return raw !== '' && readableName(raw) === '';
}

/**
 * Do two accessible names mean the same thing to a reader?
 *
 * Case-insensitive on top of the normalisation, which is what Playwright's own
 * `getByRole({ name })` does — so a comparison here and a locator there cannot
 * disagree about whether a control matched.
 */
export function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  return readableName(a).toLowerCase() === readableName(b).toLowerCase();
}

/**
 * Does a name CONTAIN this text, the way Playwright's `name` option matches?
 *
 * Playwright matches a substring, case-insensitively, with whitespace normalised —
 * which is precisely why the glyph prefix does not stop `{ name: 'New Purchase
 * Order' }` from finding that button. Mirrored here so a check written against the
 * capture predicts what a locator will do against the page.
 */
export function nameContains(name: string | null | undefined, text: string): boolean {
  return readableName(name).toLowerCase().includes(readableName(text).toLowerCase());
}
