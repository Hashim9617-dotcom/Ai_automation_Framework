import { type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { findRepoRoot } from '@aitp/shared';
import { execFileSyncClean, spawnClean } from '../support/spawn-clean';

/**
 * Does the API actually START?
 *
 * **Earned on 2026-10-09.** `pnpm api:dev` failed with
 * `Cannot find module 'nodemailer'` while 435 unit tests were green. Not one of
 * them booted the server, so a missing runtime dependency survived every check
 * and surfaced at a hand-run command — the same shape as the mocked gateway and
 * the stubbed executor: **not exercised, therefore not tested.**
 *
 * WHY THE CLASS EXISTS. `apps/api/tsconfig.json` compiles every package source
 * into the API's own `dist`, so a package's `import 'dotenv'` becomes a bare
 * `require('dotenv')` resolved from `apps/api/dist/...`. pnpm installs that
 * dependency under `packages/execution-engine/node_modules` and does not hoist
 * it, so it is invisible from the API. Every runtime dependency of every
 * compiled package has this problem, and each surfaces only when a code path
 * first touches it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ENVIRONMENT IS PART OF THE TEST, AND THE FIRST VERSION GOT IT WRONG.
 *
 * Playwright sets `NODE_PATH` to pnpm's hidden hoist store
 * (`node_modules/.pnpm/node_modules`), which holds every transitive package
 * flat. The first version of these tests spawned the API with
 * `env: { ...process.env }` and inherited it — so `nodemailer` resolved from the
 * hoist store, the API booted, and **both tests passed while `pnpm api:dev` was
 * demonstrably broken.**
 *
 * A test that inherits an environment the real thing does not have is running in
 * a world where the bug cannot exist. So both tests below scrub `NODE_PATH`, and
 * the resolution check runs as a separate script in a clean process — a check
 * that must not run under Playwright cannot be written as a loop inside it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const ROOT = findRepoRoot();
const API_DIR = path.join(ROOT, 'apps', 'api');
const ENTRY = path.join(API_DIR, 'dist', 'apps', 'api', 'src', 'main.js');

test.describe('the API boots @api', () => {
  test.beforeAll(() => {
    if (!existsSync(ENTRY)) {
      execFileSyncClean('pnpm', ['--filter', '@aitp/api', 'build'], {
        cwd: ROOT,
        stdio: 'pipe',
        shell: process.platform === 'win32',
      });
    }
    // A test that passed because there was nothing to check would be the same
    // failure it exists to catch.
    expect(existsSync(ENTRY), `no built entry point at ${ENTRY}`).toBe(true);
  });

  test('every compiled module resolves its runtime dependencies', () => {
    // wrong: a package dependency pnpm did not hoist stays invisible until some
    // code path first touches it. `nodemailer` was found that way, and `dotenv`
    // and `@faker-js/faker` were queued up behind it to surface one at a time.
    let stdout = '';
    let failed = false;
    try {
      stdout = execFileSyncClean(process.execPath, [path.join(ROOT, 'scripts', 'check-api-deps.mjs')], {
        cwd: ROOT,
      });
    } catch (error) {
      failed = true;
      const err = error as { stdout?: string; stderr?: string };
      stdout = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }

    expect(failed, `apps/api cannot resolve every runtime dependency:\n\n${stdout}`).toBe(false);
    // Discriminating: the script refuses (exit 2) if it scanned too few files or
    // saw a NODE_PATH, so a pass here means it really looked.
    expect(stdout).toMatch(/scanned \d+ compiled module/);
  });

  test('the server starts, answers /api/health, and shuts down', async () => {
    // wrong: with no boot test, a missing module, a broken module graph or bad
    // DI wiring is caught by nobody — 435 unit tests were green while the API
    // could not start at all.
    const port = 3100 + Math.floor(Math.random() * 800);
    let child: ChildProcess | undefined;

    try {
      child = spawnClean(process.execPath, [ENTRY], {
        cwd: API_DIR,
        env: { API_PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));

      const deadline = Date.now() + 40_000;
      let status = 0;
      let body: unknown;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) {
          throw new Error(`the API exited with code ${child.exitCode} before serving:\n${output}`);
        }
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/health`);
          status = response.status;
          body = await response.json();
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
      }

      expect(status, `no response from /api/health within 40s:\n${output}`).toBe(200);
      expect(body).toBeTruthy();
      // The startup banner names the docs URL, so a silent change to the prefix
      // or the port is visible here rather than in someone's browser.
      expect(output).toContain('/api/docs');
    } finally {
      child?.kill();
    }
  });
});
