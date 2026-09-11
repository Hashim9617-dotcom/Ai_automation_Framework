/**
 * Prints its own arguments as JSON, and nothing else.
 *
 * A stand-in for the Playwright CLI in `tests/unit/no-shell-spawn.spec.ts`. The
 * question there is what the CHILD receives, which is exactly what this reports:
 * if a shell was involved it will have split the argument at the metacharacter
 * before this ever ran, and the JSON shows it.
 *
 * CommonJS on purpose — it must run under `node <file>` regardless of the
 * package type of whatever directory it is invoked from.
 */
process.stdout.write(JSON.stringify(process.argv.slice(2)));
