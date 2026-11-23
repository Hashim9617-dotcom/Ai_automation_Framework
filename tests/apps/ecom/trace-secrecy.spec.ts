import { inflateRawSync } from 'node:zlib';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { requireUser } from '@aitp/execution-engine';
import { test, expect, readSessionStorage, seedSession, signIn } from './fixtures';

/**
 * DOES A TRACE CONTAIN THE SESSION? Measured on a real trace, not reasoned about.
 *
 * ## Why this cannot be settled by reading the code
 *
 * The fixture holds the application's sessionStorage — `access_token` among it — in
 * process memory and hands it to `addInitScript` as an ARGUMENT rather than
 * interpolating it into the script source. That is the right shape, and it is not
 * evidence: Playwright records an action's parameters in its trace, and whether this
 * particular parameter lands there is a fact about Playwright's recorder.
 *
 * A trace travels. It is attached to a failing test, archived under
 * `artifacts/runs/`, zipped into a report email and opened by whoever is triaging.
 * "Probably not in there" is not a standard for that.
 *
 * ## The reader needs a control, or "not found" means nothing
 *
 * A trace is a zip of deflated streams. A search that read zero bytes — a parser
 * that mis-walked the central directory, an entry it skipped, a decompression that
 * silently returned empty — would report NO SECRETS FOUND with total confidence.
 * That is this repo's oldest failure mode: a criterion satisfied by knowing nothing.
 *
 * So a control string is planted in the trace through a step title, and the reader
 * must find it. If the control is missing the verdict is VOID and this test fails
 * saying so, rather than reporting a clean result it did not earn (§W).
 *
 * ## It reports yes/no and never a value
 *
 * The needles are a live access token and the application password. Nothing in this
 * file writes, logs, annotates or attaches either, and no JWT is decoded — the only
 * output is a boolean per needle, by NAME of the needle.
 */

/** Where a trace is written for inspection. Removed in `finally`, never archived. */
function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'aitp-trace-secrecy-'));
}

interface ZipEntry {
  name: string;
  bytes: Buffer;
}

/**
 * Every entry of a zip, decompressed, read through the CENTRAL DIRECTORY.
 *
 * The central directory is used rather than scanning for local headers because a
 * local header may carry zeroed sizes when the writer streamed the entry and put the
 * real sizes in a trailing data descriptor. Walking local headers would then read the
 * wrong number of bytes — and reading too few is the silent direction, because the
 * needle could be in the part that was not read.
 */
function readZip(file: string): ZipEntry[] {
  const buffer = readFileSync(file);

  // End of central directory: scan backwards, because it is followed by a comment of
  // arbitrary length and is therefore not at a fixed offset.
  let eocd = -1;
  for (let at = buffer.length - 22; at >= 0; at -= 1) {
    if (buffer.readUInt32LE(at) === 0x06054b50) {
      eocd = at;
      break;
    }
  }
  if (eocd === -1) throw new Error(`${file} has no end-of-central-directory record`);

  const declared = buffer.readUInt16LE(eocd + 10);
  let at = buffer.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];

  while (at < buffer.length && buffer.readUInt32LE(at) === 0x02014b50) {
    const method = buffer.readUInt16LE(at + 10);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localOffset = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataAt = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataAt, dataAt + compressedSize);
    entries.push({ name, bytes: method === 8 ? inflateRawSync(raw) : Buffer.from(raw) });

    at += 46 + nameLength + extraLength + commentLength;
  }

  // ASSERTS ITS OWN EFFECT. A walk that stopped after one entry would otherwise
  // report a clean trace having read a fraction of it.
  if (entries.length !== declared) {
    throw new Error(
      `${file}: the central directory declares ${declared} entr(y/ies) and the walk read ` +
        `${entries.length} — refusing to report a search over a partly-read archive`,
    );
  }
  return entries;
}

/** Is this needle anywhere in the decompressed trace? Bytes, so encoding cannot hide it. */
function present(entries: ZipEntry[], needle: string): boolean {
  return carriedBy(entries, needle).length > 0;
}

/**
 * WHICH ENTRIES carry the needle — names only, never an offset or a value.
 *
 * A yes/no answer says a trace is unsafe; it does not say what to do about it. The
 * entry name does: `0-trace.trace` is the ACTION recorder and can be suspended,
 * while `0-trace.network` and `resources/*` are the NETWORK capture, which has no
 * option to turn off and is not bounded by a chunk. The remedy differs completely,
 * so the diagnosis has to distinguish them.
 */
function carriedBy(entries: ZipEntry[], needle: string): string[] {
  const bytes = Buffer.from(needle, 'utf8');
  return entries.filter((entry) => entry.bytes.includes(bytes)).map((entry) => entry.name);
}

/** Groups entry names into the two capture mechanisms, so a remedy can be named. */
function mechanisms(names: readonly string[]): string {
  if (names.length === 0) return 'nowhere';
  const kind = (name: string): string =>
    name.endsWith('.network') || name.startsWith('resources/')
      ? 'network-capture'
      : name.endsWith('.trace')
        ? 'action-recorder'
        : name;
  return [...new Set(names.map(kind))].sort().join(' + ');
}

test.describe('Ecom traces carry no session material @ecom @smoke @readonly @security', () => {
  test('TRACE-SEC the action recorder carries no secret; the network capture does, and says so', async ({
    unseededContext,
    env,
  }, testInfo) => {
    // wrong: asserting that `addInitScript` is called with an argument rather than an
    // interpolated string, which is a fact about this repo's code and not about what
    // Playwright's recorder writes down. And a search with no planted control would
    // report a clean trace just as confidently over a zip it failed to read.
    const dir = tempDir();
    const traceFile = path.join(dir, 'trace.zip');
    const control = `AITP-TRACE-SELECTOR-${Math.random().toString(36).slice(2)}`;
    const argControl = `AITP-TRACE-ARGUMENT-${Math.random().toString(36).slice(2)}`;
    const user = requireUser(env, 'admin');

    /**
     * A CHUNK OF THE HARNESS'S OWN TRACE, not a trace this test configured.
     *
     * The first version created its own context and called `tracing.start`, which
     * failed: `Tracing has been already started`. The harness instruments every
     * context made from the test's `browser`, so a private trace is not available —
     * and that is the better answer. The artifact that travels (attached to a
     * failure, archived under `artifacts/runs/`, zipped into a report email) is the
     * one the HARNESS records with the options in `playwright.config.ts`. A trace
     * this test configured itself could be clean while that one is not.
     *
     * `startChunk`/`stopChunk` writes a slice of exactly that recording to a file
     * this test can read.
     *
     * The context is the UNSEEDED one, and it is seeded below on purpose: the point
     * is to make the recorder see the real `addInitScript` call with real values, so
     * the call has to happen inside the window being recorded.
     */
    const context = unseededContext;
    let tokenInTrace = true;
    let passwordInTrace = true;
    let controlInTrace = false;
    try {
      await context.tracing.startChunk({ title: 'trace-secrecy' });

      const page = await context.newPage();
      // PATH 1: the sign-in itself, which types the password through `fill`.
      await signIn(page, env);
      // PATH 2: reading the session out of a page, which `ensureSignedIn` does on a
      // real re-login — inside a traced context, which is the case that matters.
      const entries = await readSessionStorage(page);
      // PATH 3: seeding, the path every test takes. Same function the fixture uses.
      await seedSession(context, entries);
      await page.goto('/admin/domains/Department', { waitUntil: 'domcontentloaded' });

      /**
       * THE CONTROL, and the first version put it in the wrong place.
       *
       * It was a `test.step(control)` title, and the control was NOT FOUND — so the
       * run reported VOID, which is the gate working. `test.step` is a TEST RUNNER
       * concept: its titles are written into the trace by the runner's own
       * recording, and a chunk started and stopped by this test covers the
       * CONTEXT's actions. The control has to be something the context records.
       *
       * A SELECTOR is, and it is also the cheapest thing to be sure about: the
       * trace viewer displays selectors, so they are in the file by construction.
       * The locator matches nothing, which is the point — `count()` is an action
       * with a recorded selector and no effect on the page.
       */
      await page.locator(`[data-aitp-control="${control}"]`).count();

      /**
       * A SECOND control, through a DIFFERENT mechanism: an argument to `evaluate`.
       *
       * It is not used to validate the reader — the selector does that — but to say
       * whether argument VALUES are recorded at all. If this one is absent while
       * the selector is present, then the recorder does not keep arguments, which
       * is the same mechanism `addInitScript` uses and therefore evidence about the
       * token rather than a separate curiosity.
       */
      await page.evaluate((marker: string) => marker.length, argControl);

      await context.tracing.stopChunk({ path: traceFile });
      /**
       * A FRESH CHUNK FOR THE HARNESS TO STOP.
       *
       * Without this, teardown failed with `Must start tracing before stopping` —
       * the harness stops a chunk at the end of every test, and this test had
       * already stopped the only one. Leaving an active chunk hands the lifecycle
       * back exactly as it was found.
       */
      await context.tracing.startChunk();

      // §T — the needles have to exist, or every "not found" below is a fact about
      // an empty string. A token of zero length would be found everywhere or
      // nowhere, and neither would mean anything.
      const token = entries.find(([key]) => key === 'access_token')?.[1] ?? '';
      expect(
        token.length,
        'no access_token in sessionStorage — nothing to search for',
      ).toBeGreaterThan(20);
      expect(user.password.length, 'no password configured').toBeGreaterThan(0);

      const zip = readZip(traceFile);
      // TWO DISTINCT NONCES, because one cannot tell the two plantings apart: the
      // selector contains the nonce, so a search for a shared nonce would report
      // "arguments are recorded" on the strength of the selector alone.
      controlInTrace = present(zip, control);
      const argRecorded = present(zip, argControl);

      const tokenWhere = carriedBy(zip, token);
      const passwordWhere = carriedBy(zip, user.password);
      // The ACTION-RECORDER copies are the ones this repo puts there and can remove.
      // The network ones are the application's own traffic, and no trace option
      // excludes them — they are reported, not asserted. See the note by the
      // assertions below.
      const recorderOnly = (names: readonly string[]): boolean =>
        mechanisms(names).includes('action-recorder');
      tokenInTrace = recorderOnly(tokenWhere);
      passwordInTrace = recorderOnly(passwordWhere);

      testInfo.annotations.push({
        type: 'trace-secrecy',
        description:
          `trace entries read: ${zip.length}; selector control found: ${controlInTrace}; ` +
          `argument values recorded: ${argRecorded}; ` +
          `access_token carried by: ${mechanisms(tokenWhere)}; ` +
          `password carried by: ${mechanisms(passwordWhere)}`,
      });
      process.stdout.write(
        `\nTRACE-SEC entries=${zip.length} selectorControl=${controlInTrace} ` +
          `argsRecorded=${argRecorded}\n` +
          `  access_token carried by: ${mechanisms(tokenWhere)}\n` +
          `  password     carried by: ${mechanisms(passwordWhere)}\n\n`,
      );
    } finally {
      // The context belongs to the fixture, which closes it. Only this test's own
      // temp directory is removed here — and the trace file inside it goes with it,
      // which is deliberate: a file that was just searched for a live token is not
      // one to leave lying about.
      rmSync(dir, { recursive: true, force: true });
    }

    // THE CONTROL FIRST. Without it the two verdicts below are unearned, and a
    // reader would take "no token in the trace" from a search that read nothing.
    expect(
      controlInTrace,
      'the planted control string was NOT found in the trace — the reader did not read it, ' +
        'so this run proves nothing about tokens either way (VOID, not clean)',
    ).toBe(true);

    /**
     * THE HALF THIS REPO CONTROLS, and the half it does not.
     *
     * Measured 2026-11-23, and the first two attempts both asserted the wrong thing:
     *
     *     attempt 1 — token=true password=true, carried by action-recorder + network
     *     attempt 2 — token=true password=true, carried by NETWORK-CAPTURE only
     *
     * Suspending the recorder around the credential window removed the
     * action-recorder copies. The network ones cannot be removed: the password is in
     * the login request body, the token is in the login response and in the
     * `Authorization` header of every request after it, and Playwright's trace has
     * no option to leave network out — `screenshots`, `snapshots` and `sources` are
     * the only switches. Turning tracing off entirely is the only way, and that
     * collides with keeping failure evidence.
     *
     * So the assertion is the controllable half, stated as such. The other half is
     * REPORTED on every run rather than asserted, because asserting its presence
     * would turn a future Playwright improvement into a failure — and asserting its
     * absence would fail forever while telling nobody anything new.
     *
     * **A green result here does NOT mean an Ecom trace is safe to send.** It means
     * nothing this repo does adds a secret the application's own traffic had not
     * already put there. The handling rule that follows from that is a decision
     * about where traces may go, not a thing a test can fix.
     */
    expect(
      tokenInTrace,
      'the access token is in the ACTION RECORDER — the credential window is not suspended',
    ).toBe(false);
    expect(
      passwordInTrace,
      'the password is in the ACTION RECORDER — the credential window is not suspended',
    ).toBe(false);
  });
});
