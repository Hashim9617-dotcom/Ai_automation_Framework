import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  describeKitIntegrity,
  describeKitRefusal,
  hashKitFile,
  verifyKitIntegrity,
  type KitManifest,
} from '@aitp/execution-engine';

/**
 * THE KIT LOCK: tamper-EVIDENT, fail-closed. Never tamper-proof.
 *
 * Three QAs run this kit on laptops they own, with an AI assistant that can edit
 * files. Nothing can stop a determined person editing code on their own machine, and
 * a tool that claimed otherwise would be worse than no lock at all — a QA would trust
 * a modified kit because the tool said it was locked.
 *
 * So the property under test is the reachable one: **a modified kit never produces a
 * pass.** Every test here is about that, and the ones that matter most are the two
 * silent halves — a clean kit must pass, and a kit with only build output or only a
 * line-ending difference must pass, because a check that refused those would be
 * turned off within a day.
 *
 * ## §AJ: every input is a fixture
 *
 * `root` and `markerPath` are arguments. These tests build a kit in a temp directory
 * and hand both in, so they give the SAME answer whether or not the maintainer's
 * `.aitp-maintainer` exists on the machine running them — which it does on mine and
 * does not in CI. Four guards in this repo were green here and red on a clean
 * checkout, every one because it read an environment it had not supplied.
 */

/** A minimal kit on disk: locked framework files, plus a QA's own two. */
function buildKit(): { root: string; manifestPath: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'aitp-kit-'));
  const write = (relative: string, contents: string): void => {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents, 'utf8');
  };

  write('packages/shared/src/index.ts', 'export const x = 1;\n');
  write('scripts/auth-setup.ts', '// auth\n');
  write('docs/QA-QUICKSTART.md', '# quickstart\n');
  write('config/apps/dms/module-map.json', '{}\n');
  write('config/env/app.json', '{"name":"app"}\n');
  write('package.json', '{"name":"kit"}\n');
  // The QA's own files. Deliberately NOT locked, and present from the start so a
  // test cannot pass by the checker simply ignoring everything under config/.
  write('config/apps/globex/module-map.json', '{}\n');
  write('config/env/globex.json', '{"name":"globex"}\n');

  const locked = [
    'packages/shared/src/index.ts',
    'scripts/auth-setup.ts',
    'docs/QA-QUICKSTART.md',
    'config/apps/dms/module-map.json',
    'config/env/app.json',
    'package.json',
  ];
  const manifest: KitManifest = {
    kitVersion: '0.4',
    commit: 'deadbee',
    generatedAt: new Date().toISOString(),
    lockedPrefixes: [
      'packages',
      'scripts',
      'docs',
      'config/apps/dms',
      'config/env/app.json',
      'package.json',
    ],
    files: Object.fromEntries(locked.map((f) => [f, hashKitFile(path.join(root, f))])),
  };
  const manifestPath = path.join(root, 'kit-manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { root, manifestPath };
}

/** A marker path that does not exist, so the check RUNS. */
const noMarker = (root: string): string => path.join(root, '.aitp-maintainer');

test.describe('the kit integrity check (K) @unit', () => {
  test('K1: a clean kit verifies, and says how many files it checked', () => {
    // wrong: a check that refused a clean kit would be switched off within a day, and
    // this is the half that every other test here depends on being true.
    const { root } = buildKit();
    try {
      const result = verifyKitIntegrity({ root, markerPath: noMarker(root) });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.skipped).toBe(false);
      // §T — it had a subject. "verified (0 files)" is what a check over nothing says.
      expect(result.files).toBe(6);
      expect(describeKitIntegrity(result)).toBe('Kit v0.4 — integrity verified (6 files)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('K2: one byte changed in a locked file refuses, and names that file', () => {
    // wrong: the whole point. A modified kit that still produces a pass makes every
    // result it reports worthless, and nobody downstream can tell.
    const { root } = buildKit();
    try {
      const victim = path.join(root, 'packages', 'shared', 'src', 'index.ts');
      writeFileSync(victim, `${readFileSync(victim, 'utf8')}x`, 'utf8');

      const result = verifyKitIntegrity({ root, markerPath: noMarker(root) });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toBe('files-differ');
      expect(result.problems).toEqual([{ file: 'packages/shared/src/index.ts', why: 'changed' }]);
      // The QA-facing sentence, asserted rather than reviewed: it must tell them NOT
      // to fix it, because the realistic failure is an assistant offering to.
      const refusal = describeKitRefusal(result);
      expect(refusal).toContain('KIT MODIFIED');
      expect(refusal).toContain('packages/shared/src/index.ts');
      expect(refusal).toContain('Do not fix it');
      expect(refusal).toContain('Hashim');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('K3: a CRLF-only difference PASSES', () => {
    // wrong: a QA whose unzip tool or editor rewrote line endings is told their kit
    // was modified, and the recovery in the message — re-extract the zip — does not
    // help, because the next extraction does the same thing. A line-ending difference
    // is not a modification, and this is the false alarm that would destroy trust in
    // every true one.
    const { root } = buildKit();
    try {
      const victim = path.join(root, 'docs', 'QA-QUICKSTART.md');
      const lf = readFileSync(victim, 'utf8');
      writeFileSync(victim, lf.replace(/\n/g, '\r\n'), 'utf8');
      // Discriminating: the bytes really did change, so a raw-hash check would refuse.
      expect(readFileSync(victim).includes(13)).toBe(true);

      expect(verifyKitIntegrity({ root, markerPath: noMarker(root) }).ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('K4: a new slug folder and a new env file PASS — that is the allow-list', () => {
    // wrong: the kit refuses as soon as it is used as documented. ADD-AN-APPLICATION
    // tells a QA to create exactly these two things, so locking them would make the
    // lock and the instructions contradict each other.
    const { root } = buildKit();
    try {
      mkdirSync(path.join(root, 'config', 'apps', 'synergystore'), { recursive: true });
      writeFileSync(
        path.join(root, 'config', 'apps', 'synergystore', 'module-map.json'),
        '{"Home":{"route":"/","provenBy":{"role":"heading","name":"Home"}}}\n',
      );
      writeFileSync(path.join(root, 'config', 'env', 'synergystore.json'), '{"name":"s"}\n');
      // And editing their OWN file is fine too.
      writeFileSync(path.join(root, 'config', 'apps', 'globex', 'module-map.json'), '{"a":1}\n');

      expect(verifyKitIntegrity({ root, markerPath: noMarker(root) }).ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('K5: an EXTRA file inside a locked path refuses — a hash list cannot see an addition', () => {
    // wrong: this is the easiest possible way to modify the kit, and the one a hash
    // list is blind to by construction. A new module under packages/, or a second
    // module map under config/apps/dms/, matches no hash and would otherwise be
    // invisible — which is why the manifest carries lockedPrefixes at all.
    const { root } = buildKit();
    try {
      writeFileSync(path.join(root, 'config', 'apps', 'dms', 'extra.json'), '{}\n');
      writeFileSync(
        path.join(root, 'packages', 'shared', 'src', 'sneak.ts'),
        'export const y = 2;\n',
      );

      const result = verifyKitIntegrity({ root, markerPath: noMarker(root) });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.problems).toEqual([
        { file: 'config/apps/dms/extra.json', why: 'unlisted' },
        { file: 'packages/shared/src/sneak.ts', why: 'unlisted' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('K6: a DELETED locked file refuses', () => {
    // wrong: deleting a file is a modification a hash comparison reports as "I could
    // not read it", and a check that treated unreadable as acceptable would make
    // `rm` the way to turn itself off.
    const { root } = buildKit();
    try {
      rmSync(path.join(root, 'scripts', 'auth-setup.ts'));
      const result = verifyKitIntegrity({ root, markerPath: noMarker(root) });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.problems).toContainEqual({ file: 'scripts/auth-setup.ts', why: 'missing' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('K7: a MISSING manifest refuses — fail closed, not fail open', () => {
    // wrong: carrying on when the manifest cannot be read makes deleting one file the
    // way to turn the check off. That is a lock with its own key taped to it, and it
    // is §AC exactly — ambiguity resolves toward refusal, never toward the reading
    // that can pass.
    const { root } = buildKit();
    try {
      rmSync(path.join(root, 'kit-manifest.json'));
      const result = verifyKitIntegrity({ root, markerPath: noMarker(root) });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toBe('manifest-missing');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('K7: an UNREADABLE manifest refuses, and is a different answer from a missing one', () => {
    // wrong: a truncated or hand-edited manifest throws, the throw is caught
    // somewhere upstream, and the command carries on. The two reasons are separate
    // because they tell a reader different things: one file to restore, versus a file
    // somebody has been editing.
    const { root } = buildKit();
    try {
      writeFileSync(path.join(root, 'kit-manifest.json'), '{ "kitVersion": "0.4", trunc', 'utf8');
      const result = verifyKitIntegrity({ root, markerPath: noMarker(root) });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toBe('manifest-unreadable');

      // A well-formed JSON file of the WRONG SHAPE is also unreadable, not clean.
      writeFileSync(path.join(root, 'kit-manifest.json'), '{"kitVersion":"0.4"}', 'utf8');
      const shape = verifyKitIntegrity({ root, markerPath: noMarker(root) });
      expect(shape.ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('K8: build output inside a locked path is NOT tampering', () => {
    // wrong: the check refuses on a freshly installed, completely unmodified kit —
    // `pnpm install` creates node_modules/ under every package and `pnpm verify`
    // creates apps/api/dist/, both inside locked prefixes. Measured on this repo
    // with `git status --ignored`: those two are the ONLY ignored paths in there.
    //
    // The skip list is hand-written inside a locked path, which is the §AE shape. It
    // is acceptable only because the worst a missing entry can do is a false
    // REFUSAL — loud and named — never a false pass. This test plants a file in each.
    const { root } = buildKit();
    try {
      for (const dir of ['node_modules', 'dist']) {
        mkdirSync(path.join(root, 'packages', 'shared', dir), { recursive: true });
        writeFileSync(path.join(root, 'packages', 'shared', dir, 'whatever.js'), 'x\n');
      }
      writeFileSync(path.join(root, 'packages', 'shared', 'tsconfig.tsbuildinfo'), '{}\n');

      expect(verifyKitIntegrity({ root, markerPath: noMarker(root) }).ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('K9: the maintainer MARKER skips the check, with a visible banner', () => {
    // wrong: the maintainer cannot work — every command refuses the moment there is
    // an uncommitted change, which is every moment of development.
    const { root } = buildKit();
    try {
      // Tamper first, so the skip is doing the work rather than the kit being clean.
      const victim = path.join(root, 'package.json');
      writeFileSync(victim, '{"name":"edited"}\n', 'utf8');
      expect(verifyKitIntegrity({ root, markerPath: noMarker(root) }).ok).toBe(false);

      const marker = path.join(root, '.aitp-maintainer');
      writeFileSync(marker, '', 'utf8');
      const result = verifyKitIntegrity({ root, markerPath: marker });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.skipped).toBe('maintainer');
      // VISIBLE. A silent skip is indistinguishable from a pass, and a run whose
      // output does not say which one happened cannot be audited afterwards.
      expect(describeKitIntegrity(result)).toBe('MAINTAINER MODE — integrity check skipped');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('K10: no environment variable can skip the check', () => {
    // wrong: a variable turns the lock off, and nothing it leaves behind tells anybody
    // it happened. That is ALLOW_WRITES's rule applied to a different switch — the
    // marker is a FILE precisely because a shell profile, a CI step or an agent
    // running a command can all set a variable, and none of them leave a trace.
    const { root } = buildKit();
    const names = [
      'ALLOW_WRITES',
      'SKIP_KIT_CHECK',
      'AITP_SKIP_INTEGRITY',
      'AITP_MAINTAINER',
      'KIT_INTEGRITY',
      'CI',
    ];
    const before = Object.fromEntries(names.map((n) => [n, process.env[n]]));
    try {
      writeFileSync(path.join(root, 'package.json'), '{"name":"edited"}\n', 'utf8');
      for (const name of names) {
        process.env[name] = '1';
        const result = verifyKitIntegrity({ root, markerPath: noMarker(root) });
        expect(result.ok, `${name}=1 skipped the check`).toBe(false);
      }
      // And the source has no reader for any of them, so a future edit cannot add one
      // quietly — this is the structural half of the same claim.
      const source = readFileSync(
        path.join(
          __dirname,
          '..',
          '..',
          'packages',
          'execution-engine',
          'src',
          'kit',
          'integrity.ts',
        ),
        'utf8',
      ).replace(/\/\*[\s\S]*?\*\//g, ' ');
      expect(source).not.toContain('process.env');
    } finally {
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
