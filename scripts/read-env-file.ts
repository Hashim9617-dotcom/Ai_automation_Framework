/**
 * One variable out of `.env`, with no dependency.
 *
 * ## Why not `dotenv`
 *
 * Measured 2026-10-21: `import 'dotenv'` from `scripts/` fails with
 * `Cannot find module 'dotenv'`. It is a dependency of
 * `packages/execution-engine` and of `apps/api`, and pnpm does not hoist it to
 * the root — the same shape as the finding already recorded in CLAUDE.md, where
 * a package's own `import 'dotenv'` was invisible from the API. `scripts/` has
 * no `package.json` of its own, so it resolves from the root, where dotenv is
 * not.
 *
 * The alternatives were adding `dotenv` to the ROOT (a root dependency added so
 * one script could read one variable, against the standing preference for
 * keeping dependencies in the package that uses them) or going through
 * `loadEnvironment()`, which demands `TEST_ENV` and resolves a whole application
 * environment to answer a question about a database. Neither is worth it for
 * `KEY=value`.
 *
 * ## What it deliberately does NOT do
 *
 * No `${VAR}` interpolation, no `export ` prefix, no multi-line values. The
 * repo's own interpolation lives in
 * `packages/execution-engine/src/config/environment.ts` and applies to
 * `config/env/*.json`, not here — a second implementation of it would be a
 * second answer that can disagree with the first. If a value ever needs any of
 * those, this stops being the right reader and the caller should say so rather
 * than this growing to meet it.
 *
 * Values are returned, never logged. Callers hold connection strings.
 */
import { existsSync, readFileSync } from 'node:fs';

interface Assignment {
  key: string;
  value: string;
  /** 1-based, so a refusal can tell a human which line to delete. */
  line: number;
}

/** Every `KEY=value` in order, with its line number. Internal. */
function assignments(file: string): Assignment[] {
  if (!existsSync(file)) return [];
  const out: Assignment[] = [];
  for (const [index, raw] of readFileSync(file, 'utf8').split(/\r?\n/).entries()) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    // Surrounding quotes are a quoting convention, not part of the value.
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^(["'])([\s\S]*)\1$/, '$2');
    out.push({ key, value, line: index + 1 });
  }
  return out;
}

/** Every `KEY=value` found, last one winning — which is what dotenv does too. */
export function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of assignments(file)) out[key] = value;
  return out;
}

/**
 * Keys assigned more than once with DIFFERENT values, and the lines they are on.
 *
 * ## Why this exists
 *
 * Found on 2026-10-21: `AITP_DB_OWNER_URL` appeared twice in `.env`, at lines 56
 * and 58, with different passwords. Measured, because it decides everything:
 * dotenv and this reader are both **LAST-WINS**, and line 58 was the one that
 * FAILED authentication. So the working credential was present, sitting two
 * lines above the broken one that silently won — and the failure surfaces as
 * "password authentication failed", which reads as a wrong password rather than
 * as two of them.
 *
 * A duplicate with the SAME value is not reported: it is untidy and it cannot
 * change an outcome. A duplicate with different values is two sources
 * disagreeing, which `requireApplicationArg` already establishes has no safe
 * tie-break — so the caller refuses and names both lines rather than picking.
 *
 * **Line numbers only, never values.** A refusal about a credential must not
 * print the credential, and "they differ" is the whole finding.
 */
export function conflictingEnvKeys(file: string): Array<{ key: string; lines: number[] }> {
  const byKey = new Map<string, Assignment[]>();
  for (const entry of assignments(file)) {
    byKey.set(entry.key, [...(byKey.get(entry.key) ?? []), entry]);
  }
  const conflicts: Array<{ key: string; lines: number[] }> = [];
  for (const [key, entries] of byKey) {
    if (entries.length < 2) continue;
    if (new Set(entries.map((entry) => entry.value)).size < 2) continue;
    conflicts.push({ key, lines: entries.map((entry) => entry.line) });
  }
  return conflicts;
}
