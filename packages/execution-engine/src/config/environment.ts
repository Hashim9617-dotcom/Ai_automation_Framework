import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { ConfigError, findRepoRoot, rootLogger } from '@aitp/shared';
import { environmentSchema, type EnvironmentConfig } from './schema';

const log = rootLogger.child('environment');

let cached: EnvironmentConfig | undefined;
let dotenvLoaded = false;
let resolvedEnvName: string | undefined;
/**
 * Which environments this process has announced.
 *
 * Once per NAME, not once per process. SEC-3a made one process resolve two —
 * the pinned fixture for the `demo` project and the ambient one for live
 * projects — and a once-per-process flag printed whichever came first. That was
 * `local`, on every live run: the run stated a target it was not using, which
 * is SEC-2's failure with the sign reversed. Printing each distinct resolution
 * is longer and true; printing one is shorter and sometimes a lie.
 */
const announced = new Set<string>();

/**
 * Repo root, resolved by walking up for the workspace marker rather than by a
 * fixed depth — this file is also compiled into apps/api/dist, where a hardcoded
 * number of levels would resolve to the wrong directory.
 */
export function repoRoot(): string {
  return findRepoRoot(__dirname);
}

export function artifactsDir(...segments: string[]): string {
  return path.join(repoRoot(), 'artifacts', ...segments);
}

/**
 * Where a `TEST_ENV` came from, kept only so a refusal can SAY so.
 *
 * `ensureDotenv()` merges `.env` into `process.env`, after which the value is
 * flat and its origin is gone. Both layers are captured here before that
 * happens: the shell's value (before the merge) and what `.env` itself parsed.
 * Nothing decides anything from these — the refusal below turns on the NAME
 * being absent, not on where a present one came from. They exist because
 * "TEST_ENV is not set" is useless next to "TEST_ENV=app, from .env, and this
 * surface needs a fixture".
 */
let shellTestEnv: string | undefined;
let dotenvTestEnv: string | undefined;

/** One sentence naming the value and its layer, for error messages only. */
export function describeEnvNameSource(): string {
  if (shellTestEnv) return `TEST_ENV=${shellTestEnv} (exported in the shell)`;
  if (dotenvTestEnv) return `TEST_ENV=${dotenvTestEnv} (from .env)`;
  return 'TEST_ENV is set in neither the shell nor .env';
}

function ensureDotenv(): void {
  if (dotenvLoaded) return;
  dotenvLoaded = true;

  // Captured BEFORE the merge: afterwards `process.env.TEST_ENV` cannot say
  // whether the shell or `.env` supplied it.
  shellTestEnv = process.env.TEST_ENV;

  // Base .env is loaded unconditionally, first — TEST_ENV itself usually
  // lives here, so it must be readable before anything downstream (including
  // resolveEnvName, below) asks what environment this run targets.
  const baseFile = path.join(repoRoot(), '.env');
  if (existsSync(baseFile)) dotenvTestEnv = loadDotenv({ path: baseFile }).parsed?.TEST_ENV;

  // Only now do we know which env-specific override file (if any) to layer
  // on top. override:true so a value here beats what the base .env set for
  // the same key — these files exist specifically to override it.
  const envName = process.env.TEST_ENV;
  if (!envName) return;
  for (const file of [`.env.${envName}.local`, '.env.local']) {
    const full = path.join(repoRoot(), file);
    if (existsSync(full)) loadDotenv({ path: full, override: true });
  }
}

/**
 * The single source of truth for which environment this run targets. Every
 * caller that needs the environment name goes through this — never read
 * process.env.TEST_ENV directly.
 *
 * This function exists because of a bug that shipped for months: TEST_ENV
 * lives in .env for most runs, not the shell, but authStatePath() and
 * loadEnvironment() both defaulted their envName parameter to
 * `process.env.TEST_ENV ?? 'qa'` — and JavaScript evaluates default
 * parameters *before* the function body runs. .env loading happened inside
 * the function body, so by the time TEST_ENV could have been read from .env,
 * the default had already resolved (silently, to 'qa') using whatever was in
 * the shell — usually nothing. `pnpm auth` run from a fresh terminal saved
 * every session under artifacts/auth/qa.json instead of the intended
 * environment, and the test runner (which happened to have TEST_ENV exported
 * by whatever launched it) read from a different file — two processes
 * silently talking to different saved sessions.
 *
 * ensureDotenv() is called first, unconditionally, so .env is always loaded
 * before TEST_ENV is read here.
 */
export function resolveEnvName(): string {
  if (resolvedEnvName) return resolvedEnvName;
  ensureDotenv();

  const name = process.env.TEST_ENV;
  if (!name) {
    // NO FALLBACK. It used to assume "qa" — a live environment, chosen by a
    // default rather than by anyone, and then written into the path that stores
    // live session cookies. A guess about which system to touch is the one
    // guess this repo cannot afford, and an assumption that reads as a decision
    // is worse than a refusal that reads as one.
    throw new ConfigError(
      'refusing to run: no environment was named. ' +
        `${describeEnvNameSource()}. ` +
        'Name one explicitly — TEST_ENV=local for the bundled demo app, or the key of a ' +
        'file in config/env/ for a real system. There is no default: every default here ' +
        'is a live system somebody did not choose.',
    );
  }
  resolvedEnvName = name;
  return resolvedEnvName;
}

/**
 * The ambient name, or `undefined` — for callers that must not demand one.
 *
 * `playwright.config.ts` is loaded for EVERY invocation, including one that
 * only touches fixture projects. If it resolved the ambient environment
 * strictly, naming no environment would refuse a demo run too, and the pinned
 * fixture project would not be pinned to anything. So the config asks this, and
 * the refusal lives where it can tell a live surface from a fixture one: the
 * setup project a live project depends on.
 */
export function ambientEnvName(): string | undefined {
  ensureDotenv();
  return process.env.TEST_ENV || undefined;
}

/**
 * Where a logged-in browser session is stored for reuse.
 *
 * Under artifacts/ deliberately — that path is gitignored, and this file holds
 * live cookies and tokens. It must never reach a repository.
 *
 * ## Keyed on the APPLICATION as well as the environment
 *
 * It was `artifacts/auth/<env>.json`, keyed on the environment name alone. Two
 * environments of one application are correctly separate there — `app` and `qa`
 * are different sessions. What it could not express is two APPLICATIONS: a QA who
 * reuses an environment name for a second target silently overwrites the first
 * one's session, and a session file is the one artifact where "belongs to the
 * wrong system" means a browser signed in somewhere nobody asked.
 *
 * It takes the resolved config rather than two strings on purpose. Both halves come
 * from the same `loadEnvironment` call, so they cannot disagree — the pairing rule
 * SEC-2 earned: record the label and the target together, at the point of
 * resolution.
 */
export function authStatePath(env: Pick<EnvironmentConfig, 'name' | 'application'>): string {
  return artifactsDir(env.application, 'auth', `${env.name}.json`);
}

/**
 * Where an inspector's captures for one application live.
 *
 * Exported so the writer and every reader use one expression. Three readers
 * resolved `artifacts/inspect` independently — `triage-sheet.ts`,
 * `command.service.ts` and `generation-smoke.ts` — and a fourth path built by hand
 * is how two applications' captures came to be pooled in one flat directory.
 */
/**
 * The target, in one line, for a tool a human is WATCHING.
 *
 * `auth` and `inspect` are interactive: somebody is at the keyboard, about to sign in
 * to a real system or record real screens. The one thing they must be able to check
 * before pressing Enter is which system this is — and the one thing that cannot be
 * checked afterwards is a capture's label, because the label IS the only record.
 *
 * So all four facts, together, and **where each came from**: a value is only as
 * trustworthy as its source, and `TEST_ENV` exported in a shell beats `.env` silently
 * (SEC-2). An operator who sees `from .env` when they edited the shell has been told
 * something they can act on; `environment: app` alone tells them nothing.
 *
 * `BASE_URL` is reported as overriding when it is set, because it is the variable
 * that redirected every environment — `local` included — to the live customer system
 * in SEC-2. A banner that printed the resolved URL without saying an override
 * produced it would launder exactly that.
 */
export function describeTargetBanner(env: EnvironmentConfig): string {
  const host = (() => {
    try {
      return new URL(env.baseUrl).host;
    } catch {
      return env.baseUrl;
    }
  })();
  // DID the override produce this host, not merely IS the variable set.
  //
  // The first version printed the note whenever `BASE_URL` existed. On `local` —
  // whose file pins `http://127.0.0.1:4173` as a LITERAL — it claimed the host came
  // from an ambient variable that had not touched it. That is SEC-2's own mistake
  // committed by the banner written to prevent it: a provenance claim derived from
  // the wrong fact reads exactly like a measured one.
  //
  // So the RAW file is read and the question asked properly: a literal `baseUrl`
  // cannot have been overridden; a placeholder one was.
  const raw = (() => {
    try {
      const parsed = JSON.parse(
        readFileSync(path.join(repoRoot(), 'config', 'env', `${env.name}.json`), 'utf8'),
      ) as { baseUrl?: unknown };
      return typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '';
    } catch {
      return '';
    }
  })();
  const override =
    process.env.BASE_URL && raw.includes('${')
      ? ' (from an ambient BASE_URL, not from the environment file)'
      : '';
  return [
    `  application : ${env.application}`,
    `  environment : ${env.name}   <- ${describeEnvNameSource()}`,
    `  host        : ${host}${override}`,
    `  session file: ${path.relative(repoRoot(), authStatePath(env))}`,
  ].join('\n');
}

/**
 * A configured user, or a refusal that NAMES THE VARIABLE.
 *
 * Three ways a role can be unusable, and they are one sentence apart for a reader
 * but very different to debug:
 *
 * - the environment file has no entry for the role at all;
 * - it has one, and the username resolved to a blank;
 * - it has one, and the password resolved to a blank.
 *
 * All three used to be the same thing: `${APP_USER2_USERNAME:-}` resolved to `''`,
 * the schema accepts an empty string, and a test took it and tried to sign in. The
 * run then failed on the login page, which reads as a credential problem when the
 * truth is that nobody said what the credentials were.
 *
 * **A blank is never handed to a login.** The convention is spelled out so the
 * refusal can name the exact variable to set, which is the only thing that makes it
 * actionable — `APP_USER2_PASSWORD is not set` tells a QA what to do;
 * `login failed` does not.
 */
export function requireUser(
  env: EnvironmentConfig,
  role: string,
): { username: string; password: string; role: string } {
  const user = env.users[role];
  const naming =
    role === 'admin'
      ? 'APP_USERNAME and APP_PASSWORD'
      : `APP_${role.toUpperCase()}_USERNAME and APP_${role.toUpperCase()}_PASSWORD`;

  if (!user) {
    throw new ConfigError(
      `environment "${env.name}" defines no "${role}" user. This is not a missing ` +
        `password — the role is absent from config/env/${env.name}.json. Add it with ` +
        `\${${naming.split(' and ')[0]}} / \${${naming.split(' and ')[1]}} and set both in .env.`,
      { name: role },
    );
  }
  if (!user.username.trim() || !user.password.trim()) {
    const blank = !user.username.trim() ? 'username' : 'password';
    throw new ConfigError(
      `environment "${env.name}": the "${role}" user's ${blank} is BLANK. Set ${naming} ` +
        'in .env. A blank is never handed to a login — a run that tries one fails on the ' +
        'login page and reads as a wrong password rather than as missing configuration.',
      { name: role },
    );
  }
  return user;
}

export function capturesDir(application: string): string {
  return artifactsDir(application, 'inspect');
}

/**
 * The OLD, application-blind capture root. Still read, only to be reported.
 *
 * Sessions written before the move carry no application, and deleting them would
 * throw away provenance — a capture is what a locator was written against, and an
 * old one is more valuable than a new one for answering "why does this say ABCD".
 * So readers count what they find here and say so, rather than pooling it into an
 * application's set on the strength of nothing.
 */
export function legacyCapturesDir(): string {
  return artifactsDir('inspect');
}

/**
 * Replaces ${VAR} and ${VAR:-default} placeholders with process.env values.
 *
 * The default group excludes braces so a nested placeholder
 * (`${API_BASE_URL:-${BASE_URL}}`) is not swallowed: the inner one resolves
 * first and a second pass resolves the outer.
 */
const PLACEHOLDER = /\$\{([A-Z0-9_]+)(?::-([^{}]*))?\}/g;

function interpolateOnce(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(PLACEHOLDER, (_match, name: string, fallback?: string) => {
      const resolved = process.env[name] ?? fallback;
      if (resolved === undefined) {
        throw new ConfigError(`Environment variable ${name} is required but not set.`, { name });
      }
      return resolved;
    });
  }
  if (Array.isArray(value)) return value.map(interpolateOnce);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, interpolateOnce(v)]),
    );
  }
  return value;
}

function interpolate(value: unknown): unknown {
  let current = value;
  // Bounded: resolves nesting without ever looping forever on a self-reference.
  for (let pass = 0; pass < 5; pass += 1) {
    const next = interpolateOnce(current);
    if (JSON.stringify(next) === JSON.stringify(current)) return next;
    current = next;
  }
  return current;
}

/** The baseUrl exactly as written in the file, before any interpolation. */
function rawBaseUrl(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = (raw as Record<string, unknown>).baseUrl;
  return typeof value === 'string' ? value : undefined;
}

export function loadEnvironment(envName = resolveEnvName()): EnvironmentConfig {
  if (cached && cached.name === envName) return cached;
  ensureDotenv();

  const file = path.join(repoRoot(), 'config', 'env', `${envName}.json`);
  if (!existsSync(file)) {
    throw new ConfigError(`No environment config found for "${envName}".`, { file });
  }

  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  const parsed = environmentSchema.safeParse(interpolate(raw));
  if (!parsed.success) {
    throw new ConfigError(`Invalid environment config "${envName}": ${parsed.error.message}`, {
      file,
    });
  }

  // Selected process.env overrides win over the file (CI / Jenkins parameter injection).
  const overrides: Partial<EnvironmentConfig> = {};
  // …EXCEPT a baseUrl the file pins as a LITERAL.
  //
  // Found on 2026-09-11 building the Command Box: with `BASE_URL` set in `.env`,
  // every key — `local`, `qa`, `app` — resolved to the live customer system,
  // including `local`, whose file says `http://127.0.0.1:4173` in plain text.
  // A run requested against the demo app silently ran against a customer
  // system, and nothing in the request could have prevented it.
  //
  // The override was never needed for the files it was written for. `app`,
  // `qa` and `staging` consume `BASE_URL` through `${BASE_URL}` placeholders,
  // so for them this line changed nothing. It changed the outcome ONLY for a
  // file that pins a literal — which is exactly the file whose author was
  // saying "this environment means this URL". Ambient state does not get to
  // overrule a value someone wrote down on purpose.
  const pinnedLiteral = typeof rawBaseUrl(raw) === 'string' && !rawBaseUrl(raw)!.includes('${');
  if (process.env.BASE_URL && !pinnedLiteral) overrides.baseUrl = process.env.BASE_URL;
  if (process.env.API_BASE_URL) overrides.apiBaseUrl = process.env.API_BASE_URL;
  if (process.env.TEST_WORKERS) overrides.workers = Number(process.env.TEST_WORKERS);
  if (process.env.TEST_RETRIES) overrides.retries = Number(process.env.TEST_RETRIES);

  cached = { ...parsed.data, ...overrides };

  // Once per environment NAME: exactly what this process resolved, so a wrong
  // environment or a stale/misnamed session is obvious from the first lines of
  // output instead of discovered forty-five failures later.
  if (!announced.has(cached.name)) {
    announced.add(cached.name);
    log.info('Resolved environment', {
      environment: cached.name,
      baseUrl: cached.baseUrl,
      storageState: authStatePath(cached),
    });
  }

  return cached;
}

export function resetEnvironmentCache(): void {
  cached = undefined;
  dotenvLoaded = false;
  resolvedEnvName = undefined;
  announced.clear();
  shellTestEnv = undefined;
  dotenvTestEnv = undefined;
}
