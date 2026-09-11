#!/usr/bin/env node
/**
 * Can every module compiled into apps/api resolve its runtime dependencies?
 *
 *   node scripts/check-api-deps.mjs
 *
 * **Why this exists.** `apps/api/tsconfig.json` compiles every package source
 * into the API's own `dist`, so a package's `import 'dotenv'` becomes a bare
 * `require('dotenv')` resolved from `apps/api/dist/...`. pnpm installs that
 * dependency under `packages/execution-engine/node_modules` and does not hoist
 * it, so it is invisible from the API — and the failure surfaces only when some
 * code path first touches it, possibly in front of a user. `nodemailer` was
 * found that way on 2026-10-09, with 435 unit tests green.
 *
 * **Why it is a SCRIPT run in a clean child process, not an in-test loop.**
 * Playwright sets `NODE_PATH` to pnpm's hidden hoist store
 * (`node_modules/.pnpm/node_modules`), which contains every transitive package
 * flat. A check that runs under Playwright — or spawns a child inheriting its
 * environment — resolves everything and reports clean while the API genuinely
 * cannot boot. The first version of this check did exactly that and passed with
 * `nodemailer` demonstrably missing.
 *
 * So: `NODE_PATH` is scrubbed here, and the caller must run this with a clean
 * environment. It asserts its own effect — a scan that finds no files fails
 * rather than reporting success.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// The hoist store must not participate. Deleting it from `process.env` is not
// enough — Node reads NODE_PATH at startup — so this file must be entered by a
// process that never had it. Refuse rather than report a result that is wrong.
if (process.env.NODE_PATH) {
  console.error(
    'REFUSING: NODE_PATH is set, so resolution here does not match how the API runs.\n' +
      `  NODE_PATH=${process.env.NODE_PATH}\n` +
      'Run this from a plain `node` process with NODE_PATH unset.',
  );
  process.exit(2);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps', 'api', 'dist');

if (!existsSync(DIST)) {
  console.error(`REFUSING: no build at ${DIST}. Run: pnpm --filter @aitp/api build`);
  process.exit(2);
}

function compiledModules(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) compiledModules(full, found);
    else if (entry.endsWith('.js')) found.push(full);
  }
  return found;
}

const modules = compiledModules(DIST);
// ASSERT OWN EFFECT: a scan that read nothing must not report a clean tree.
if (modules.length < 50) {
  console.error(`REFUSING: only ${modules.length} compiled module(s) found — the scan is not looking at a real build.`);
  process.exit(2);
}

const unresolved = [];
for (const file of modules) {
  const source = readFileSync(file, 'utf8');
  const require_ = createRequire(file);
  const specifiers = new Set([...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]));
  for (const specifier of specifiers) {
    // Relative misses are build problems and would already have failed the
    // build. Only bare specifiers are dependency problems.
    if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
    try {
      require_.resolve(specifier);
    } catch {
      unresolved.push({ specifier, from: path.relative(ROOT, file) });
    }
  }
}

const byModule = new Map();
for (const { specifier, from } of unresolved) {
  if (!byModule.has(specifier)) byModule.set(specifier, []);
  byModule.get(specifier).push(from);
}

console.log(`scanned ${modules.length} compiled module(s) in apps/api/dist`);
if (byModule.size === 0) {
  console.log('all runtime dependencies resolve');
  process.exit(0);
}

console.error(`\n${byModule.size} UNRESOLVABLE runtime dependenc(ies):\n`);
for (const [specifier, files] of byModule) {
  console.error(`  ${specifier}  — required by ${files.length} compiled file(s)`);
  console.error(`      e.g. ${files[0]}`);
}
console.error(
  '\nThe code path that reaches any of these will fail at runtime.\n' +
    'Add them to apps/api/package.json, or change the build so the API consumes\n' +
    'built packages instead of compiling their sources.',
);
process.exit(1);
