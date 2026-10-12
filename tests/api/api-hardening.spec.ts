import { spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { findRepoRoot } from '@aitp/shared';
import { buildChildEnv } from '../../apps/api/src/modules/runs/child-env';
import { freePort } from '../support/free-port';
import { execFileSyncClean, spawnClean } from '../support/spawn-clean';

/**
 * B0 — the four things the API did that it should not have.
 *
 * Measured on 2026-10-09 and all four reachable at once, on a machine holding a
 * saved session for a live customer system:
 *
 *   1. `app.listen(port)` bound `::`, so the API was on every interface.
 *   2. `enableCors({ origin: … ?? true })` REFLECTED the caller's Origin, so any
 *      page the operator visited could read it.
 *   3. `RunnerService` spawned with `{ ...process.env }`, so `ALLOW_WRITES` in
 *      the API's environment made `POST /api/runs {"grep":"@write"}` create real
 *      records.
 *   4. `POST /api/events` had no schema — `LiveEvent` is an interface, which
 *      exists only at compile time.
 *
 * None of this is authentication; that is B1. These are the four properties that
 * have to hold whether or not anyone is logged in.
 *
 * ## One file, three servers, and why they are not three files
 *
 * The boot cost was measured before this suite was written: requiring the
 * compiled `app.module` takes ~12.7s cold and ~1.0s warm on this machine,
 * because `nest build` sets `deleteOutDir` and every one of the 90 emitted files
 * is read for the first time. Three api spec files already boot their own API in
 * parallel workers, and `command-box.spec.ts` has a known flake whose message is
 * "the API did not start within 40s". Playwright runs one FILE in one worker, so
 * keeping these three servers here makes them sequential rather than three more
 * boots competing with the existing three.
 *
 * ## THE API UNDER TEST HOLDS `ALLOW_WRITES=true` THROUGHOUT
 *
 * Deliberately, and it is not only for the scrub test. Every assertion in this
 * file is made against an API process that has the one variable set which must
 * never reach a run — so "the API serves normally in that state" is established
 * alongside everything else rather than assumed.
 */

const ROOT = findRepoRoot();
const API_DIR = path.join(ROOT, 'apps', 'api');
const ENTRY = path.join(API_DIR, 'dist', 'apps', 'api', 'src', 'main.js');

/** Set on the API process, and required to be absent from any child it spawns. */
const SENTINELS = {
  ALLOW_WRITES: 'true',
  ANTHROPIC_API_KEY: 'sk-sentinel-must-not-travel',
  APP_PASSWORD: 'sentinel-password-must-not-travel',
};

interface Booted {
  api: ChildProcess;
  port: number;
  output: () => string;
}

async function bootApi(extra: Record<string, string>): Promise<Booted> {
  if (!existsSync(ENTRY)) {
    execFileSyncClean('pnpm', ['--filter', '@aitp/api', 'build'], {
      cwd: ROOT,
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
  }
  const port = await freePort();
  const api = spawnClean(process.execPath, [ENTRY], {
    cwd: API_DIR,
    env: { API_PORT: String(port), ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Kept, not discarded: "the API exited with 1" alone cannot be diagnosed, and
  // the startup line is itself the subject of two tests below.
  let output = '';
  api.stdout?.on('data', (chunk) => (output += String(chunk)));
  api.stderr?.on('data', (chunk) => (output += String(chunk)));

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (api.exitCode !== null) {
      throw new Error(
        `the API exited with ${api.exitCode} (port ${port}):\n${output.slice(-2000)}`,
      );
    }
    try {
      await fetch(`http://127.0.0.1:${port}/api/health`);
      return { api, port, output: () => output };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  api.kill();
  throw new Error(`the API did not start within 90s (port ${port}):\n${output.slice(-2000)}`);
}

/** What a TCP connect to one address does. Resolves rather than throws, both ways. */
function probe(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(4000);
    socket.on('connect', () => {
      socket.destroy();
      resolve('connected');
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve('timeout');
    });
    socket.on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'));
  });
}

/** No response body anywhere may carry a stack frame or a path from this machine. */
function expectNoStack(body: string): void {
  expect(body, 'a stack frame reached the response body').not.toMatch(/\s+at\s+\S+\(/);
  expect(body, 'a source path reached the response body').not.toMatch(
    /node_modules|\.ts:\d+|\\src\\/,
  );
  expect(body.length, 'the error body is not short').toBeLessThan(1000);
}

test.describe('B0: the API network and input surface @api', () => {
  let server: Booted;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    server = await bootApi(SENTINELS);
  });

  test.afterAll(() => server?.api.kill());

  const post = async (
    route: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: string }> => {
    const response = await fetch(`http://127.0.0.1:${server.port}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: response.status, body: await response.text() };
  };

  // ── 1. BIND ────────────────────────────────────────────────────────────────

  test('B0-1a: the API reports the address it actually bound, and it is loopback', () => {
    // wrong: a line printing the REQUESTED host cannot show a bind that went
    // somewhere else, which is SEC-2's mistake committed by the very statement
    // written to prevent it. This address comes from `server.address()`.
    expect(server.output()).toMatch(new RegExp(`API bound to 127\\.0\\.0\\.1:${server.port}\\b`));
    // And it says the consequence in words, because the address alone is not
    // something an operator reading a log can act on.
    expect(server.output()).toContain('Reachable from this machine only');
  });

  test('B0-1b: ::1 is REFUSED while 127.0.0.1 answers', async () => {
    // wrong: measured directly on 2026-10-12 — `listen(port)` with no host binds
    // `{"address":"::","family":"IPv6"}` and a connect to `::1` CONNECTS. So this
    // is the assertion that fails on the pre-fix code; the startup line above
    // would merely have said something different. A loopback-only bind is also
    // what makes the "not reachable from another machine" claim true, and `::1`
    // is the one non-IPv4 address present on every machine, so this discriminates
    // without depending on what interfaces this host happens to have (§AJ).
    expect(await probe('::1', server.port)).toBe('ECONNREFUSED');
    expect(await probe('127.0.0.1', server.port)).toBe('connected');
  });

  // ── 2. CORS ────────────────────────────────────────────────────────────────

  test('B0-2a: with no allowlist, a foreign Origin gets no CORS header at all', async () => {
    // wrong: with `origin: true` the `cors` package echoes the caller's own
    // Origin back, so this header would read "https://evil.example" and any page
    // an operator visited could start runs against a customer system. Absent, not
    // empty and not "null" as a string — only the header's absence blocks the read.
    const simple = await fetch(`http://127.0.0.1:${server.port}/api/health`, {
      headers: { origin: 'https://evil.example' },
    });
    expect(simple.headers.get('access-control-allow-origin')).toBeNull();

    // And the preflight, which is the half a browser asks before a POST.
    const preflight = await fetch(`http://127.0.0.1:${server.port}/api/events`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
    expect(server.output()).toContain('CORS: disabled');
  });

  // ── 3. CHILD ENVIRONMENT ───────────────────────────────────────────────────

  test('B0-3: ALLOW_WRITES set on this API process is absent from a real child', () => {
    // wrong: with `{ ...process.env }` the child inherits it and three @write
    // tests stop skipping — records created in a live customer system from an
    // unauthenticated HTTP request. The API serving this file HAS the variable
    // set (see SENTINELS), so the parent half of the claim is real rather than
    // simulated.
    //
    // WHAT THIS COVERS, AND WHAT IT DOES NOT. This spawns a real child with the
    // environment `buildChildEnv` produces, so it proves the rule survives an
    // actual `spawn()`. That `RunnerService` and `CommandService` are the only
    // spawners and both go through that function is a DIFFERENT claim, held
    // structurally by `no-unscrubbed-spawn.spec.ts`. The two compose to the
    // property; neither states it alone (§L).
    const parent: NodeJS.ProcessEnv = { ...process.env, ...SENTINELS };
    expect(parent.ALLOW_WRITES, 'the fixture did not set ALLOW_WRITES on the parent').toBe('true');

    const child = spawnSync(
      process.execPath,
      ['-e', 'process.stdout.write(Object.keys(process.env).sort().join(","))'],
      { encoding: 'utf8', env: buildChildEnv({ parent, overrides: { TEST_ENV: 'local' } }) },
    );

    // §T — it had a subject. A child that failed to start prints nothing, and an
    // empty string contains no forbidden name either.
    expect(child.status, `the probe child did not run: ${child.stderr}`).toBe(0);
    const keys = child.stdout.split(',').filter(Boolean);
    expect(keys.length, 'the child reported no environment at all').toBeGreaterThan(2);

    for (const name of Object.keys(SENTINELS)) {
      expect(keys, `${name} reached the child`).not.toContain(name);
    }
    // Discriminating in the other direction: the child must still be usable, or
    // an allowlist that emptied the environment would satisfy the loop above.
    expect(keys).toContain('TEST_ENV');
    expect(
      keys.some((key) => key.toLowerCase() === 'path'),
      'the child has no PATH',
    ).toBe(true);
  });

  // ── 4. INPUT VALIDATION ────────────────────────────────────────────────────

  test('B0-4a: /api/events rejects a wrong-typed field with 400 and no stack', async () => {
    // wrong: `LiveEvent` is an interface, so before this the body was whatever
    // the caller sent — and it is re-serialised into the SSE stream, where a
    // dashboard renders it.
    const { status, body } = await post('/api/events', { event: 123 });
    expect(status).toBe(400);
    expect(body).toContain('event');
    expectNoStack(body);
  });

  test('B0-4b: /api/events caps the length of a string field', async () => {
    // wrong: an unbounded `event` is stored in the per-run buffer and echoed to
    // every subscriber, so a long one is amplified rather than merely accepted.
    const { status, body } = await post('/api/events', { event: 'x'.repeat(5000) });
    expect(status).toBe(400);
    expectNoStack(body);
  });

  test('B0-4c: /api/events validates the runId NESTED in the payload', async () => {
    // wrong: `EventsService.publish` falls back to `payload.runId` when the
    // top-level one is absent, so validating only the top level leaves the actual
    // buffer key unvalidated in exactly the case where it is used as the key.
    const { status, body } = await post('/api/events', {
      event: 'run:started',
      payload: { runId: '../../etc/passwd' },
    });
    expect(status).toBe(400);
    expect(body).toContain('payload.runId');
    expectNoStack(body);
  });

  test('B0-4d: /api/events still ACCEPTS the events the reporter really sends', async () => {
    // wrong: a schema that refused everything would satisfy every rejection test
    // above and silently break the live stream — a rule that refuses everything
    // is as empty as one that accepts everything, and this is the half that tells
    // them apart. These are the shapes `AitpReporter` emits.
    for (const event of [
      { event: 'run:started', payload: { runId: 'run_0123456789abcdef', total: 42 } },
      { event: 'test:finished', payload: { runId: 'run_0123456789abcdef', result: { id: 'x' } } },
      { event: 'run:stdout', payload: { runId: 'run_0123456789abcdef', line: 'a log line' } },
    ]) {
      const { status, body } = await post('/api/events', event);
      expect(status, `${event.event} was rejected: ${body}`).toBe(202);
    }
  });

  test('B0-4e: /api/runs refuses an environment this installation does not have', async () => {
    // wrong: `environment` was `z.string().default('qa')` — free text, and the
    // field that decides WHICH SYSTEM a run drives. It also reaches `path.join`
    // when the config is resolved, so the slug pattern is doing two jobs.
    const unknown = await post('/api/runs', { environment: 'not-configured', grep: '@smoke' });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toContain('environment');
    expectNoStack(unknown.body);

    const traversal = await post('/api/runs', { environment: '../../../etc/passwd' });
    expect(traversal.status).toBe(400);
    expectNoStack(traversal.body);

    // The two are different sentences because they have different fixes: one is
    // malformed, the other is a configuration gap.
    expect(unknown.body).toContain('no such environment');
    expect(traversal.body).toContain('lower-case slug');
  });

  test('B0-4f: /api/runs caps metadata entries and the browsers array', async () => {
    // wrong: `metadata` was an unbounded `z.record(z.string())` written straight
    // onto the run record AND published to every SSE subscriber, so it was the
    // cheapest way to put arbitrary bulk into both.
    const metadata = await post('/api/runs', {
      environment: 'local',
      metadata: Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`k${index}`, 'v'])),
    });
    expect(metadata.status).toBe(400);
    expect(metadata.body).toContain('metadata');
    expectNoStack(metadata.body);

    const browsers = await post('/api/runs', {
      environment: 'local',
      browsers: ['chromium', 'firefox', 'webkit', 'chromium'],
    });
    expect(browsers.status).toBe(400);
    expect(browsers.body).toContain('browsers');
    expectNoStack(browsers.body);
  });

  test('B0-4g: a body over 64 KB is refused before it is parsed', async () => {
    // wrong: Nest's default JSON limit is 100kb and `useBodyParser` ADDS a parser
    // rather than replacing one, so without `bodyParser: false` in
    // NestFactory.create the 64kb limit is never reached — the first parser to
    // run accepts the body and ours never sees it. That failure is invisible
    // except by sending something between the two sizes, which is what this does.
    const oversize = JSON.stringify({
      event: 'run:started',
      payload: { blob: 'x'.repeat(80 * 1024) },
    });
    expect(oversize.length, 'the fixture is not actually over the cap').toBeGreaterThan(64 * 1024);

    const { status, body } = await post('/api/events', oversize);
    // 413, not 400: "too big" and "malformed" have different fixes, and a client
    // cannot tell them apart from the status otherwise.
    expect(status).toBe(413);
    expectNoStack(body);

    // Discriminating: a body just UNDER the cap must still be accepted, or a
    // limit of zero would satisfy the assertion above.
    const fits = JSON.stringify({ event: 'run:started', payload: { blob: 'x'.repeat(20 * 1024) } });
    expect(fits.length).toBeLessThan(64 * 1024);
    expect((await post('/api/events', fits)).status).toBe(202);
  });

  // ── The two overrides, each on its own server ──────────────────────────────

  test.describe('with API_HOST set', () => {
    let overridden: Booted;

    test.beforeAll(async () => {
      test.setTimeout(240_000);
      overridden = await bootApi({ ...SENTINELS, API_HOST: '0.0.0.0' });
    });
    test.afterAll(() => overridden?.api.kill());

    test('B0-1c: an explicit API_HOST is honoured, and warned about', () => {
      // wrong: without this, `127.0.0.1` could be a HARDCODE rather than a
      // default and every bind test above would still pass — so this is what
      // makes "default" a true word. The warning matters too: the override puts
      // an API with no authentication on the network, and the operator who typed
      // it is the only one who can weigh that.
      expect(overridden.output()).toMatch(
        new RegExp(`API bound to 0\\.0\\.0\\.0:${overridden.port}\\b`),
      );
      expect(overridden.output()).toContain('NO authentication');
      expect(overridden.output()).not.toContain('Reachable from this machine only');
    });
  });

  test.describe('with API_ALLOWED_ORIGINS set', () => {
    let scoped: Booted;
    const ALLOWED = 'http://localhost:5173';

    test.beforeAll(async () => {
      test.setTimeout(240_000);
      scoped = await bootApi({ ...SENTINELS, API_ALLOWED_ORIGINS: ALLOWED });
    });
    test.afterAll(() => scoped?.api.kill());

    test('B0-2b: the listed origin is allowed EXACTLY, and a foreign one still is not', async () => {
      // wrong: both halves are needed and neither is enough. Checking only that
      // the listed origin works is satisfied by reflection — the bug this
      // replaced — and checking only that a foreign origin is denied is satisfied
      // by CORS being broken, which would also break the dashboard B3 builds.
      const allowed = await fetch(`http://127.0.0.1:${scoped.port}/api/health`, {
        headers: { origin: ALLOWED },
      });
      expect(allowed.headers.get('access-control-allow-origin')).toBe(ALLOWED);

      const foreign = await fetch(`http://127.0.0.1:${scoped.port}/api/health`, {
        headers: { origin: 'https://evil.example' },
      });
      expect(foreign.headers.get('access-control-allow-origin')).toBeNull();

      // A near-miss, because exact match is the claim: same host, different port.
      const nearMiss = await fetch(`http://127.0.0.1:${scoped.port}/api/health`, {
        headers: { origin: 'http://localhost:5174' },
      });
      expect(nearMiss.headers.get('access-control-allow-origin')).toBeNull();
    });
  });

  test('B0-2c: a wildcard allowlist REFUSES TO BOOT rather than starting quietly', async () => {
    // wrong: the unit test proves `resolveAllowedOrigins('*')` throws. It cannot
    // prove what the PROCESS does with that throw, and the two plausible
    // outcomes are opposite: an unhandled rejection that still leaves a server
    // listening with CORS silently off, or a refusal. Only the second is safe to
    // ship, because an operator who typed `*` believes they have opened the API
    // up and would otherwise get no signal at all.
    await expect(bootApi({ ...SENTINELS, API_ALLOWED_ORIGINS: '*' })).rejects.toThrow(
      /API_ALLOWED_ORIGINS may not contain/,
    );
  });
});
