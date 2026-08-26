import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { ConfigError, findRepoRoot, rootLogger } from '@aitp/shared';
import { environmentSchema, type EnvironmentConfig } from './schema';

const log = rootLogger.child('environment');

let cached: EnvironmentConfig | undefined;
let dotenvLoaded = false;
let resolvedEnvName: string | undefined;
let printedResolution = false;

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

function ensureDotenv(): void {
  if (dotenvLoaded) return;
  dotenvLoaded = true;

  // Base .env is loaded unconditionally, first — TEST_ENV itself usually
  // lives here, so it must be readable before anything downstream (including
  // resolveEnvName, below) asks what environment this run targets.
  const baseFile = path.join(repoRoot(), '.env');
  if (existsSync(baseFile)) loadDotenv({ path: baseFile });

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
    resolvedEnvName = 'qa';
    log.warn(
      'TEST_ENV is not set — checked .env and the shell, found neither. Assuming "qa". ' +
        'Sessions will be read from and written to artifacts/auth/qa.json. Set TEST_ENV ' +
        'in .env (or export it) if that is not the environment you meant to target.',
      { assumedEnvironment: 'qa', assumedAuthFile: 'artifacts/auth/qa.json' },
    );
  } else {
    resolvedEnvName = name;
  }
  return resolvedEnvName;
}

/**
 * Where a logged-in browser session is stored for reuse.
 *
 * Under artifacts/ deliberately — that path is gitignored, and this file holds
 * live cookies and tokens. It must never reach a repository.
 */
export function authStatePath(envName = resolveEnvName()): string {
  return artifactsDir('auth', `${envName}.json`);
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
  if (process.env.BASE_URL) overrides.baseUrl = process.env.BASE_URL;
  if (process.env.API_BASE_URL) overrides.apiBaseUrl = process.env.API_BASE_URL;
  if (process.env.TEST_WORKERS) overrides.workers = Number(process.env.TEST_WORKERS);
  if (process.env.TEST_RETRIES) overrides.retries = Number(process.env.TEST_RETRIES);

  cached = { ...parsed.data, ...overrides };

  // Once per process: exactly what a run resolved to, so a wrong environment
  // or a stale/misnamed session is obvious from the first line of output
  // instead of discovered forty-five failures later.
  if (!printedResolution) {
    printedResolution = true;
    log.info('Resolved environment', {
      environment: cached.name,
      baseUrl: cached.baseUrl,
      storageState: authStatePath(cached.name),
    });
  }

  return cached;
}

export function resetEnvironmentCache(): void {
  cached = undefined;
  dotenvLoaded = false;
  resolvedEnvName = undefined;
  printedResolution = false;
}
