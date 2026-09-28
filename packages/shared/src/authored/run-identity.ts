import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';

/**
 * WHO ran this, and WHERE that answer came from.
 *
 * The generated automation sheet carries `automation-<runBy>` so a QA pasting
 * rows into their issue sheet can see which run produced them. That name is only
 * useful if a reader can also tell how confident it is, which is why the source
 * travels with it and is never dropped.
 *
 * ## The order, and why
 *
 * 1. `git config user.name` — a name the person chose, spelled the way they
 *    spell it. Best when it is there.
 * 2. the OS username — always there on a developer machine, and often a login
 *    rather than a name.
 * 3. `ci` — when the OS username is a service account. Measured: the Jenkins
 *    agent runs `mcr.microsoft.com/playwright:…` with `-u root:root`, so the OS
 *    answer there is `root`, which is not a person and must not be written into
 *    a sheet as if it were one. Jenkins also exposes no `BUILD_USER_ID` today
 *    (that needs the build-user-vars plugin), so the human who clicked Build is
 *    genuinely not available to the run — and saying `ci` is the honest answer
 *    rather than a name nobody chose.
 *
 * ## Recording the source is the point
 *
 * `runBy: "root"` and `runBy: "Hashim Khan"` read identically in a spreadsheet
 * cell. `runBySource` is what makes the first one visibly a fallback. Same rule
 * as recording a run's label next to its URL: a value with nothing to qualify it
 * cannot be checked afterwards.
 *
 * Every source is INJECTED, so a test asserts on values it chose rather than on
 * whatever machine happens to run it — a test that reads the real git config
 * passes or fails for reasons that have nothing to do with this code.
 */

/** Names that are a machine, not a person. Lowercased before comparison. */
const SERVICE_ACCOUNTS = new Set(['system', 'root', 'administrator', 'jenkins', 'runner']);

export interface RunIdentitySources {
  /** `git config user.name`, or undefined when git has none / is unavailable. */
  gitUserName: () => string | undefined;
  /** The OS username, or undefined when it cannot be read. */
  osUserName: () => string | undefined;
}

export interface RunIdentity {
  runBy: string;
  runBySource: 'git' | 'os' | 'ci';
}

const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * Resolves the identity, preferring a chosen name and falling back loudly.
 *
 * A service account never becomes a `runBy` name: it becomes `ci`, with the
 * source saying so. Note the order — the git name is trusted even on CI, because
 * a pipeline that has configured one has said who it is on purpose.
 */
export function resolveRunIdentity(sources: RunIdentitySources): RunIdentity {
  const git = clean(sources.gitUserName());
  if (git) return { runBy: git, runBySource: 'git' };

  const os = clean(sources.osUserName());
  if (os && !SERVICE_ACCOUNTS.has(os.toLowerCase())) return { runBy: os, runBySource: 'os' };

  return { runBy: 'ci', runBySource: 'ci' };
}

/**
 * The real sources, kept apart from the resolver above.
 *
 * `git` is spawned rather than parsed out of `.git/config`: a name can come from
 * the global config, an include, or a worktree override, and re-implementing
 * git's own precedence would be a second answer that disagrees with the first.
 *
 * Both swallow their errors and return `undefined`, because "git is not
 * installed" and "git has no user.name" call for the same next step here — fall
 * through. Neither is reported as a name.
 */
export const defaultRunIdentitySources: RunIdentitySources = {
  gitUserName: () => {
    try {
      return execFileSync('git', ['config', 'user.name'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return undefined;
    }
  },
  osUserName: () => {
    try {
      return userInfo().username;
    } catch {
      return undefined;
    }
  },
};
