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

/** Every `KEY=value` found, last one winning. */
export function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    // Surrounding quotes are a quoting convention, not part of the value.
    out[key] = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^(["'])([\s\S]*)\1$/, '$2');
  }
  return out;
}
