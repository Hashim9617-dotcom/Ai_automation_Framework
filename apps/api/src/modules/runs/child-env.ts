/**
 * THE ENVIRONMENT A CHILD OF THIS API GETS, BUILT FROM AN ALLOWLIST.
 *
 * `RunnerService` spawned Playwright with `{ ...process.env, … }`, so every
 * variable the API process happened to hold reached the child: the LLM key, the
 * application password, the SMTP password — and `ALLOW_WRITES`, which is the
 * single switch that lets three tests create real records in a live customer
 * system. No request body could set it (`CB5` proves that), but nothing had to:
 * one `export` in the shell that started the API made
 * `POST /api/runs {"grep":"@write"}` a data-creating endpoint, unauthenticated.
 *
 * ## An allowlist, never a denylist
 *
 * A denylist of secret-looking names is fail-open — it protects the names
 * somebody thought of, and the next variable anyone adds is inherited by
 * default (§AC). So the child's environment is BUILT, not filtered: a key
 * reaches the child only by appearing below.
 *
 * `SECRET_SHAPED` is therefore not the gate. It is a tripwire ON the gate: if
 * the allowlist itself ever grows an entry that looks like a credential, this
 * THROWS instead of passing it through. Today no entry matches, which is
 * exactly the silent half a detector needs (§W) — the catching half is a test
 * that hands in a poisoned allowlist, which is why `allowed` is a parameter.
 *
 * ## `NODE_*` is deliberately NOT a prefix allowance
 *
 * `NODE_PATH` and `NODE_OPTIONS` are the two variables this repo has already
 * measured as poisonous to a child: `NODE_PATH` points at pnpm's hidden hoist
 * store, where every unhoisted dependency resolves, and it is why a boot test
 * passed while `pnpm api:dev` could not start; `NODE_OPTIONS` can carry a
 * loader that makes a TypeScript source importable where only JavaScript
 * exists. `tests/support/spawn-clean.ts` scrubs both for exactly this reason.
 * Allowing `NODE_*` wholesale would re-open that hole from the other side, so
 * only the two safe members are named.
 */

/**
 * Keys a child may inherit, matched case-INSENSITIVELY.
 *
 * Windows reports its own casing — `Path`, `SystemRoot`, `windir`,
 * `ProgramFiles` — and `Object.entries(process.env)` hands those back verbatim.
 * A case-sensitive lookup would therefore drop `Path` on the one platform this
 * repo is developed on, and a child with no `PATH` fails in a way that reads as
 * a missing browser.
 */
export const CHILD_ENV_ALLOWLIST: readonly string[] = [
  // ── The operating system's own floor. Without these, Node cannot spawn and
  //    Chromium cannot launch.
  'PATH',
  'PATHEXT',
  'COMSPEC',
  'SystemRoot',
  'windir',
  'OS',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'LANG',
  'LC_ALL',
  'SHELL',
  'DISPLAY',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',

  // ── Node, the two members that are safe. See the note above for why this is
  //    not `NODE_*`.
  'NODE_ENV',
  'NODE_EXTRA_CA_CERTS',

  // ── Where Playwright keeps its browsers, when it is not the default cache.
  'PLAYWRIGHT_BROWSERS_PATH',

  // ── The suite's own configuration. Every one of these is read by
  //    `packages/execution-engine/src/config/environment.ts`,
  //    `packages/shared/src/logger.ts`, `fixtures/index.ts`, `data/factory.ts`
  //    or `playwright.config.ts`, and a run behaves differently without it.
  'TEST_ENV',
  'BASE_URL',
  'API_BASE_URL',
  'TEST_WORKERS',
  'TEST_RETRIES',
  'TEST_DATA_SEED',
  'TEST_ID_ATTRIBUTE',
  'LOCATOR_CANDIDATE_TIMEOUT',
  'LOCATOR_FALLBACK_TIMEOUT_MS',
  'LOG_LEVEL',
  'LOG_FORMAT',
  'CLEAN_ARTIFACTS',
  'AITP_REPO_ROOT',
  'DEMO_APP_PORT',
  /**
   * Which notify config a run reads. A PATH, not a credential — the file it names
   * is refused if it holds anything secret-shaped (`assertNoSecretShapedKeys`).
   *
   * It is on the list because the variable's whole purpose is to survive a spawn:
   * the reader is the child's reporter, so a value the parent holds and the child
   * does not would mean the parent's own tests read the parent's own config file —
   * the thing it exists to prevent. `AITP_NOTIFY_TEST_FOLDER` is deliberately NOT
   * here: that one re-enables a drop, and an API-initiated run has no business
   * being redirected into writing one.
   */
  'AITP_NOTIFY_CONFIG',
];

/**
 * Names that must never reach a child, whatever list they appear on.
 *
 * `ALLOW_WRITES` is named explicitly rather than left to the pattern: it is not
 * secret-shaped, and it is the one variable whose presence changes a live
 * customer system.
 */
const SECRET_SHAPED = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i;
const NEVER_INHERITED = /^ALLOW_WRITES$/i;

const forbidden = (name: string): boolean => SECRET_SHAPED.test(name) || NEVER_INHERITED.test(name);

export interface ChildEnvOptions {
  /** The spawning process's environment. Passed in, never read here (§AJ). */
  parent: NodeJS.ProcessEnv;
  /** What this particular spawn sets on purpose. Wins over the parent. */
  overrides?: Record<string, string>;
  /**
   * The allowlist. Injected so a test can hand in a POISONED one and see the
   * tripwire fire — a detector with no catching case is an assertion about
   * nothing (§W).
   */
  allowed?: readonly string[];
}

/**
 * The child's environment: allowlisted keys from the parent, then the
 * overrides.
 *
 * @throws when the allowlist or the overrides name something that must never be
 * inherited. Failing the spawn is the correct outcome — the alternative is a run
 * that quietly carries a credential it had no reason to see.
 */
export function buildChildEnv(options: ChildEnvOptions): NodeJS.ProcessEnv {
  const allowed = options.allowed ?? CHILD_ENV_ALLOWLIST;
  const overrides = options.overrides ?? {};

  // THE TRIPWIRE, before anything is copied. It guards the LIST, which is the
  // thing a future change edits, and the overrides, which are this file's own
  // callers. Both are refused by name so the message says what to remove.
  for (const [source, names] of [
    ['the child-env allowlist', allowed],
    ['the overrides for this spawn', Object.keys(overrides)],
  ] as const) {
    const offenders = names.filter((name) => forbidden(name));
    if (offenders.length > 0) {
      throw new Error(
        `refusing to spawn: ${source} names ${offenders.join(', ')}, which a child of this ` +
          'API must never inherit. A credential has no reason to reach a test run, and ' +
          'ALLOW_WRITES would let an HTTP request create records in a live system. Remove ' +
          'the entry rather than widening the pattern.',
      );
    }
  }

  const wanted = new Set(allowed.map((name) => name.toLowerCase()));
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(options.parent)) {
    if (value === undefined) continue;
    if (!wanted.has(key.toLowerCase())) continue;
    // Unreachable while the tripwire above holds. Kept because it is the
    // assertion that makes that sentence true rather than hopeful: if the two
    // ever disagree, nothing secret-shaped leaves this loop.
    if (forbidden(key)) continue;
    env[key] = value;
  }

  return { ...env, ...overrides };
}
