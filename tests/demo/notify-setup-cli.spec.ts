import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@aitp/execution-engine';
import { findRepoRoot } from '@aitp/shared';
import { NOTIFY_CONFIG_RELATIVE } from '@aitp/reporting-engine';
import { spawnSyncClean } from '../support/spawn-clean';

/**
 * `pnpm notify:setup`, AS A REAL PROCESS.
 *
 * ## Why the CLI gets its own suite rather than a unit test of its parts
 *
 * The flags, the merge and the refusals are the thing a QA actually runs, and the
 * only instrument that can say whether the refusals are REACHED — rather than merely
 * present in the source — is the process itself. It is also the only way to check the
 * ORDER: `--ran-by` has to be resolved before the recipients are checked, because the
 * allowed domain comes from it, and a stub cannot hold an order (§R).
 *
 * ## Nothing here needs Windows, OneDrive or a network
 *
 * Every spawn gets its own `AITP_REPO_ROOT` with a temp drop folder inside it, and
 * `--ran-by` is passed explicitly so the identity cascade — which is the one part
 * that reads the machine — is bypassed entirely. Its own logic is covered purely in
 * `tests/unit/notify-config.spec.ts`, where the three sources are supplied (§AJ).
 */

const ROOT = findRepoRoot();
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

/**
 * A repo root with `config/apps/bundled-demo/` and a folder to drop into.
 *
 * `.aitp-maintainer` because this root is not a released kit — without it the
 * integrity check refuses first and this suite would measure the LOCK instead of the
 * CLI (§Y). `config/apps/bundled-demo/` exists because the CLI refuses a slug with
 * no application directory, and that refusal has its own test below.
 */
function fixtureRoot(): { root: string; folder: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'aitp-notify-cli-'));
  writeFileSync(path.join(root, 'pnpm-workspace.yaml'), '');
  writeFileSync(path.join(root, '.aitp-maintainer'), '');
  mkdirSync(path.join(root, 'config', 'apps', 'bundled-demo'), { recursive: true });
  const folder = path.join(root, 'synced', 'Demo QA');
  mkdirSync(folder, { recursive: true });
  return { root, folder };
}

const run = (root: string, args: readonly string[]) =>
  spawnSyncClean(process.execPath, [TSX, path.join(ROOT, 'scripts', 'notify-setup.ts'), ...args], {
    cwd: ROOT,
    maxBuffer: 20 * 1024 * 1024,
    env: { AITP_REPO_ROOT: root, LOG_LEVEL: 'error' },
  });

const configIn = (root: string): unknown =>
  JSON.parse(readFileSync(path.join(root, NOTIFY_CONFIG_RELATIVE), 'utf8'));

test.describe('pnpm notify:setup, as a real process @demo', () => {
  test.setTimeout(240_000);

  test('S1: a complete invocation writes the entry, and the loader can read it back', () => {
    // wrong: the command prints success and writes nothing, or writes something its
    // own loader refuses — which is the failure mode this repo has hit twice with
    // scripts that reported success while matching nothing. The CLI reads its own
    // output back THROUGH the loader before printing, so this asserts the file on
    // disk rather than the message.
    const { root, folder } = fixtureRoot();
    const result = run(root, [
      '--app',
      'bundled-demo',
      '--folder',
      folder,
      '--to',
      'qa@contoso.com,lead@contoso.com',
      '--cc',
      'cto@contoso.com',
      '--ran-by',
      'me@contoso.com',
    ]);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(configIn(root)).toEqual({
      schemaVersion: 1,
      apps: {
        'bundled-demo': {
          folder,
          to: ['qa@contoso.com', 'lead@contoso.com'],
          cc: ['cto@contoso.com'],
          ranBy: 'me@contoso.com',
          // `explicit`, because --ran-by was passed. The SOURCE is recorded so a
          // wrong sender is traceable rather than mysterious.
          ranBySource: 'explicit',
          allowedDomain: 'contoso.com',
        },
      },
    });
    // It tells the reader what it did and what to do next, naming the whole command.
    expect(result.stdout).toContain('POWER-AUTOMATE-FLOW.md');
    expect(result.stdout).toContain('recipients outside it are refused');
  });

  test('S2: a second application MERGES — it never replaces the file', () => {
    // wrong: the second setup overwrites the whole file and the first application's
    // drop silently stops. Nothing downstream would say why: a run for the first app
    // would simply report "not configured" and print setup instructions for
    // something that WAS configured last week. A silent regression in a file nobody
    // reads is the worst shape available here.
    const { root, folder } = fixtureRoot();
    mkdirSync(path.join(root, 'config', 'apps', 'ecom'), { recursive: true });

    expect(
      run(root, [
        '--app',
        'bundled-demo',
        '--folder',
        folder,
        '--to',
        'qa@contoso.com',
        '--ran-by',
        'me@contoso.com',
      ]).status,
    ).toBe(0);
    const second = run(root, [
      '--app',
      'ecom',
      '--folder',
      folder,
      '--to',
      'ecom-qa@contoso.com',
      '--ran-by',
      'me@contoso.com',
    ]);
    expect(second.status, `${second.stdout}${second.stderr}`).toBe(0);

    const config = configIn(root) as { apps: Record<string, { to: string[] }> };
    expect(Object.keys(config.apps).sort()).toEqual(['bundled-demo', 'ecom']);
    expect(config.apps['bundled-demo']!.to).toEqual(['qa@contoso.com']);
    expect(config.apps.ecom!.to).toEqual(['ecom-qa@contoso.com']);
    // And it SAYS which other applications are configured, so a reader can see at a
    // glance that nothing was lost.
    expect(second.stdout).toContain('other apps  : bundled-demo');
  });

  test('S3: re-running for the same application UPDATES it, and says so', () => {
    // wrong: a second run for the same slug either refuses (so a recipient can never
    // be changed) or appends a duplicate key. The word "updated" rather than
    // "configured" is asserted because that is the only signal a reader gets that
    // they have replaced something rather than added it.
    const { root, folder } = fixtureRoot();
    run(root, [
      '--app',
      'bundled-demo',
      '--folder',
      folder,
      '--to',
      'old@contoso.com',
      '--ran-by',
      'me@contoso.com',
    ]);
    const second = run(root, [
      '--app',
      'bundled-demo',
      '--folder',
      folder,
      '--to',
      'new@contoso.com',
      '--ran-by',
      'me@contoso.com',
    ]);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('updated "bundled-demo"');
    const config = configIn(root) as { apps: Record<string, { to: string[] }> };
    expect(config.apps['bundled-demo']!.to).toEqual(['new@contoso.com']);
  });

  test('S4: a recipient outside the sender’s domain is refused, naming both', () => {
    // wrong: the address is accepted and a report about a customer system is mailed
    // out of the organisation because of one typo. Refused HERE rather than at send
    // time on purpose — a human is present and the fix is cheap. The message must
    // name the address AND the domain it was in AND the domain that is allowed, or
    // the reader cannot tell which of the two they got wrong.
    const { root, folder } = fixtureRoot();
    const result = run(root, [
      '--app',
      'bundled-demo',
      '--folder',
      folder,
      '--to',
      'qa@contoso.com,outsider@gmail.com',
      '--ran-by',
      'me@contoso.com',
    ]);
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain('outsider@gmail.com');
    expect(output).toContain('gmail.com');
    expect(output).toContain('contoso.com');
    // NOTHING WAS WRITTEN. A refusal that had already saved the file would leave the
    // rejected address on disk for the next run to read.
    expect(existsSync(path.join(root, NOTIFY_CONFIG_RELATIVE))).toBe(false);
  });

  test('S5: the five refusals, each with the case that must NOT refuse', () => {
    // wrong: any one of these accepted. Each is paired with the invocation that
    // differs ONLY in that one thing and must succeed, because a rule that refuses
    // everything is as empty as one that accepts everything — and the refusing kind
    // looks safe in review precisely because nothing wrong gets through (§W).
    const { root, folder } = fixtureRoot();
    const base = ['--folder', folder, '--to', 'qa@contoso.com', '--ran-by', 'me@contoso.com'];

    // 1. no --app
    expect(run(root, base).status).not.toBe(0);
    expect(`${run(root, base).stdout}${run(root, base).stderr}`).toContain('--app is required');

    // 2. an application with no config/apps/<slug>/ directory
    const unknown = run(root, ['--app', 'no-such-app', ...base]);
    expect(unknown.status).not.toBe(0);
    expect(`${unknown.stdout}${unknown.stderr}`).toContain('no config/apps/no-such-app/');

    // 3. a folder that does not exist
    const missingFolder = run(root, [
      '--app',
      'bundled-demo',
      '--folder',
      path.join(root, 'not-synced-yet'),
      '--to',
      'qa@contoso.com',
      '--ran-by',
      'me@contoso.com',
    ]);
    expect(missingFolder.status).not.toBe(0);
    expect(`${missingFolder.stdout}${missingFolder.stderr}`).toContain('watched by no');

    // 4. no --to
    const noTo = run(root, [
      '--app',
      'bundled-demo',
      '--folder',
      folder,
      '--ran-by',
      'me@contoso.com',
    ]);
    expect(noTo.status).not.toBe(0);
    expect(`${noTo.stdout}${noTo.stderr}`).toContain('--to is required');

    // 5. a --ran-by that is not an address
    const badRanBy = run(root, [
      '--app',
      'bundled-demo',
      '--folder',
      folder,
      '--to',
      'qa@contoso.com',
      '--ran-by',
      'CONTOSO\\hashim',
    ]);
    expect(badRanBy.status).not.toBe(0);
    expect(`${badRanBy.stdout}${badRanBy.stderr}`).toContain('is not an email address');

    // THE CASE THAT MUST NOT REFUSE. Identical but for having all five right.
    const good = run(root, ['--app', 'bundled-demo', ...base]);
    expect(good.status, `${good.stdout}${good.stderr}`).toBe(0);
  });

  test('S6: a flag with another flag after it is not a value', () => {
    // wrong: `--to --ran-by me@contoso.com` makes the recipient list `--ran-by`,
    // which then fails as a malformed address — a message about the wrong thing
    // entirely, sending the reader to check their addresses when the fault is a
    // missing argument. Same rule as `requireApplicationArg`'s.
    const { root, folder } = fixtureRoot();
    const result = run(root, [
      '--app',
      'bundled-demo',
      '--folder',
      folder,
      '--to',
      '--ran-by',
      'me@contoso.com',
    ]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('--to is required');
  });
});
