import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

/**
 * Spawning a child process in the environment the REAL process will have.
 *
 * **Earned on 2026-10-09, twice over.** `pnpm api:dev` failed with
 * `Cannot find module 'nodemailer'` while 435 unit tests were green — no test
 * started the server. A boot test was then written, and **it passed while the
 * API was demonstrably broken.**
 *
 * The cause was the environment, not the test logic. Playwright sets `NODE_PATH`
 * to pnpm's hidden hoist store (`node_modules/.pnpm/node_modules`), which
 * contains every transitively-installed package FLAT. A child spawned with
 * `env: { ...process.env }` inherits it, so every dependency pnpm declined to
 * hoist resolves anyway. The test ran in a world where the bug cannot exist.
 *
 * > **A test that starts a process is only as honest as the environment it
 * > starts it in.** The runner's environment is not the production environment,
 * > and the difference is invisible until something that resolves in one fails
 * > in the other.
 *
 * This is the THIRD variant of one family — a verification that never meets the
 * conditions it claims to verify. The mock gateway (§L) and the stubbed executor
 * (§11.1) were the first two.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TRAP, because it is not obvious: the scrub must DELETE the variable, never
 * set it.
 *
 *     env.NODE_PATH = '';         // WRONG — empty string is still a value
 *     env.NODE_PATH = undefined;  // WRONG — some spawns stringify this
 *     delete env.NODE_PATH;       // RIGHT
 *
 * Any value is a value the real process does not have, and "set to empty" is a
 * third environment, different from both. On Windows an empty `NODE_PATH` is not
 * identical to an absent one for every consumer.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * **This module is the only place the scrub list lives.** Per-call-site scrubbing
 * drifts — that is what `tests/unit/no-unscrubbed-spawn.spec.ts` exists to
 * prevent.
 */

/**
 * Variables the test runner injects that a production process never has.
 *
 * Kept short and justified rather than defensive: each entry is something
 * observed to change resolution or behaviour, not everything that looks
 * test-shaped.
 */
export const RUNNER_ONLY_VARS = [
  /**
   * Playwright points this at pnpm's hidden hoist store, making every unhoisted
   * dependency resolvable. The single variable behind both false passes above.
   */
  'NODE_PATH',
  /**
   * Set by Node when a loader is registered (tsx, ts-node, Playwright's
   * transform). A child inheriting it gets a loader the real process does not,
   * which can make a TypeScript source importable where only JS exists.
   */
  'NODE_OPTIONS',
] as const;

/**
 * `process.env` minus everything the runner added, plus anything the caller sets.
 *
 * The caller's own additions are applied AFTER the scrub, so a test can
 * deliberately set one of these if it is the thing under test — an explicit
 * choice at the call site rather than an accident of inheritance.
 */
export function productionEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of RUNNER_ONLY_VARS) delete env[name];
  return { ...env, ...extra };
}

export interface CleanSpawnOptions extends Omit<SpawnOptions, 'env'> {
  /** Merged in AFTER the scrub, so a deliberate override is visible here. */
  env?: Record<string, string>;
}

/** `spawn`, in the environment the real process will have. */
export function spawnClean(
  command: string,
  args: readonly string[],
  options: CleanSpawnOptions = {},
): ChildProcess {
  const { env, ...rest } = options;
  return spawn(command, [...args], { ...rest, env: productionEnv(env) });
}

/** `execFileSync`, in the environment the real process will have. */
export function execFileSyncClean(
  command: string,
  args: readonly string[],
  options: CleanSpawnOptions & { encoding?: 'utf8'; maxBuffer?: number } = {},
): string {
  const { env, ...rest } = options;
  return execFileSync(command, [...args], {
    ...rest,
    encoding: 'utf8',
    env: productionEnv(env),
  });
}
