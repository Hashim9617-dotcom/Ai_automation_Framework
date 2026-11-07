/**
 * Comment text blanked, LINE NUMBERS PRESERVED. The one copy.
 *
 * ## Why this is shared rather than written twice
 *
 * It lived in `tests/unit/no-unscrubbed-spawn.spec.ts`, and
 * `tests/unit/app-arg-remedies.spec.ts` needed the same thing. The second copy was
 * written from scratch and was WRONG IN A WAY THE FIRST ALREADY HANDLED: it stripped
 * `//` only at the start of a line, so a trailing comment —
 * `if (already) continue; // re-running \`pnpm heal\` …` — was read as an
 * instruction and reported as a violation of the rule it documents.
 *
 * That is §AE with a verdict attached: two implementations of "is this text code or
 * prose" drift, and a drifted scanner reads exactly like a correct one. Both scans
 * now ask the same function.
 *
 * ## Both halves were earned, on the same day, by the first scan
 *
 * `//` was already stripped; a `/* *\/` block was not, and `child-env.ts`'s own doc
 * comment — which QUOTES the defect it fixed, `{ ...process.env }` — was reported as
 * a violation of the rule it documents. Prose about a mistake must not read as the
 * mistake, or the only way to keep a scan green is to stop explaining anything.
 *
 * Newlines survive so a finding still names the line it was on. The first version of
 * the remedy scan replaced each block with `''`, which collapsed its lines and
 * shifted every number after it: eight genuine matches, eight wrong locations. A
 * guard whose output is what a human acts on has to get that output right.
 *
 * ## The limitation, stated
 *
 * `//` inside a string literal — `'http://example.test'` — is treated as a comment
 * and the rest of the line is dropped. That direction is fail-CLOSED for both
 * callers: dropping text can only lose a match, never invent one, so a scan can
 * miss a finding but cannot manufacture a false one. A full tokeniser is the fix if
 * a caller ever needs the other guarantee.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}
